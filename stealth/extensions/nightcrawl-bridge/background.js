/**
 * nightCrawl Bridge — MV3 service worker (Engine R).
 *
 * Transport (reverse-engineered from Kimi WebBridge, which solved this exact
 * problem): this service worker dials OUT to the nightCrawl daemon's local
 * WebSocket server and drives the active page via chrome.debugger (CDP). There
 * is NO native-messaging host — those die under Chrome's bare spawn env and
 * can't keep an MV3 worker alive. An outbound WS + chrome.alarms keepalive makes
 * the inevitable SW-eviction reconnect harmless and self-healing.
 *
 * Protocol over the socket:
 *   → {type:'hello', payload:{extensionVersion}}     (we send on open)
 *   ← {type:'hello_ack'}
 *   ← {type:'tool_call', requestId, sessionId, payload:{name,args}}
 *   → {type:'tool_result', responseToRequestId, payload:{data|error}}
 *   →/← {type:'ping'} / {type:'pong'}
 *
 * Page-control (toCdp) and tab-rebind logic mirror the unit-tested
 * src/bridge-commands.ts and src/bridge-session.ts. Per-session binding
 * (boundBySession) mirrors bridge-session.ts planBoundTab/clearBoundByTabId:
 * each session (claude:<id>, codex:<id>, …) drives its OWN background tab, so
 * concurrent agents never share or steal each other's real-browser tab.
 */

'use strict';

const WS_URL = 'ws://127.0.0.1:10087/'; // must match bridge-ws.ts BRIDGE_WS_PORT
let ws = null;
/**
 * sessionId → the tab that session drives. One bound tab PER SESSION so two
 * agents on Engine R never collide. Mirrors bridge-session.ts BoundStore.
 * @type {Map<string, {tabId:number, windowId:number, url:string, title:string}>}
 */
const boundBySession = new Map();
const DEFAULT_SESSION_ID = 'default';

// ─── WebSocket transport + keepalive ────────────────────────
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn('[bridge] ws construct failed:', e);
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    console.log('[bridge] ws connected');
    send({ type: 'hello', payload: { extensionVersion: chrome.runtime.getManifest().version } });
  };
  ws.onmessage = (ev) => onMessage(ev.data);
  ws.onclose = () => { console.warn('[bridge] ws closed'); ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws && ws.close(); } catch {} };
}
function send(obj) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch {}
}
function scheduleReconnect() {
  // Calm fixed backoff (NOT a tight thrash). The alarm below also revives us
  // after the SW is evicted, which setTimeout alone cannot survive.
  setTimeout(connect, 3000);
}

async function onMessage(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (m.type === 'tool_call') {
    const { requestId, payload } = m;
    const sessionId = m.sessionId || DEFAULT_SESSION_ID; // older daemon → default
    try {
      const data = await execute(payload.name, payload.args || [], sessionId);
      send({ type: 'tool_result', responseToRequestId: requestId, payload: { data } });
    } catch (e) {
      send({ type: 'tool_result', responseToRequestId: requestId, payload: { error: String((e && e.message) || e) } });
    }
  }
  // hello_ack / pong: nothing to do.
}

// ─── Command → CDP (mirror of src/bridge-commands.ts) ───────
// awaitPromise: an in-page `async` expression returns a Promise; without this CDP
// serializes the pending Promise as `{}`. Mirrors src/bridge-commands.ts.
function evaluate(expression) { return { method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }; }
function toCdp(command, args) {
  switch (command) {
    case 'goto': return { method: 'Page.navigate', params: { url: args[0] || '' } };
    case 'text': return evaluate('document.body ? document.body.innerText : ""');
    case 'html': return evaluate('document.documentElement.outerHTML');
    // snapshot's @ref tree is headless-only; never mislabel HTML as a snapshot.
    // The daemon (routeToBridge) intercepts snapshot before dispatch, so the
    // extension normally never sees it — this throw mirrors the spec defensively.
    case 'snapshot': throw new Error('SNAPSHOT_UNSUPPORTED_ON_REAL: use html/js + CSS selectors on the real engine, or run snapshot headless for @refs.');
    case 'screenshot': return { method: 'Page.captureScreenshot', params: { format: 'png' } };
    case 'js':
    case 'eval': return evaluate(args[0] || '');
    case 'click': {
      const sel = JSON.stringify(args[0] || '');
      return evaluate(`(() => { const el = document.querySelector(${sel}); if (!el) throw new Error('no element: ' + ${sel}); el.scrollIntoView({block:'center'}); el.click(); return true; })()`);
    }
    case 'fill': {
      const sel = JSON.stringify(args[0] || ''); const val = JSON.stringify(args[1] || '');
      return evaluate(`(() => { const el = document.querySelector(${sel}); if (!el) throw new Error('no element: ' + ${sel}); el.focus(); el.value = ${val}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    }
    default: throw new Error(`command '${command}' not supported by the bridge`);
  }
}

// ─── Tab binding + rebind (mirror of src/bridge-session.ts) ──
function resolveBoundTab(stored, tabs) {
  const byId = tabs.find((t) => t.id === stored.tabId);
  if (byId) return byId.id;
  const urlMatches = tabs.filter((t) => t.url === stored.url);
  if (urlMatches.length === 0) return null;
  const score = (t) => (t.windowId === stored.windowId ? 2 : 0) + (t.title === stored.title ? 1 : 0);
  urlMatches.sort((a, b) => score(b) - score(a));
  return urlMatches[0].id;
}
async function ensureBoundTab(command, sessionId) {
  const tabs = await chrome.tabs.query({});
  const bound = boundBySession.get(sessionId); // THIS session's tab only
  const resolved = bound ? resolveBoundTab(bound, tabs) : null;
  let tabId;
  if (command === 'goto' && (!bound || resolved == null)) {
    // Match Kimi WebBridge: create a tab in the user's CURRENT window (NEVER a new
    // window — that pops up and interrupts). active:false → the user's view never
    // switches. Reads/nav/JS run fine on an inactive tab; trusted clicks use
    // DOM.getBoxModel coords (see trustedClick). Same profile → the live logged-in
    // session is shared (session-leverage intact). One such tab PER session.
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    boundBySession.set(sessionId, { tabId: tab.id, windowId: tab.windowId, url: tab.url || '', title: tab.title || '' });
    tabId = tab.id;
  } else {
    if (!bound) throw new Error('SESSION_LOST: no bound tab — run a goto first');
    if (resolved == null) throw new Error('SESSION_LOST: bound tab is gone — run a goto to re-bind');
    bound.tabId = resolved;
    tabId = resolved;
  }
  await attach(tabId); // idempotent; re-attaches if the debugger detached on a live tab
  await ensureGrouped(tabId); // timeout-guarded; ≤1.5s once, then cached as supported/unsupported
  return tabId;
}

// Tab grouping is best-effort and BROWSER-DEPENDENT. Chrome honors chrome.tabs.group
// (that's how Kimi groups its tabs there); Arc does NOT — its sidebar/spaces model
// has no Chrome tab-group backend, so chrome.tabs.group() HANGS (verified live). So
// every call is timeout-guarded, and on the first hang/no-op we stop trying for the
// session. Non-intrusiveness does NOT depend on grouping — the bound tab is
// active:false either way; grouping is purely organizational where supported.
let groupedTabId = null;
let groupingUnsupported = false;
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}
async function ensureGrouped(tabId) {
  if (groupingUnsupported || groupedTabId === tabId) return;
  if (typeof chrome.tabs.group !== 'function' || typeof chrome.tabGroups === 'undefined') { groupingUnsupported = true; return; }
  try {
    const gid = await withTimeout(chrome.tabs.group({ tabIds: [tabId] }), 1500);
    const after = (await chrome.tabs.get(tabId)).groupId;
    if (after == null || after === -1) { groupingUnsupported = true; return; } // host ignored it (Arc)
    await withTimeout(chrome.tabGroups.update(gid, { title: 'nightcrawl', color: 'cyan', collapsed: true }), 1500).catch(() => {});
    groupedTabId = tabId;
  } catch {
    groupingUnsupported = true; // hang/timeout (Arc) — don't try again this session
  }
}

// ─── CDP plumbing ───────────────────────────────────────────
const attached = new Set();
function attach(tabId) {
  return new Promise((resolve, reject) => {
    if (attached.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      attached.add(tabId);
      chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}, () => {
        // Focus emulation: the page reports document.hasFocus()/:focus as if its
        // window were focused, so trusted Input + keyboard land on the background
        // window WITHOUT stealing the user's OS focus. Replaces the old
        // activate-tab + focus-window hack. (ignore lastError — older builds noop.)
        chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
    });
  });
}
function rawSendCdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res);
    });
  });
}
// A thrown in-page error puts the USEFUL message in exceptionDetails.exception.description
// (e.g. "TypeError: Cannot read properties of null"); exceptionDetails.text is just the
// generic "Uncaught" prefix. Prefer the description so errors are legible to the agent.
function cdpErrText(ed, fallback) {
  return (ed && ed.exception && ed.exception.description) || (ed && ed.text) || fallback;
}
// Wait until the tab finishes loading (status:complete on a real URL). The timeout
// RESOLVES (never rejects) so a slow/streaming page doesn't fail the goto — it just
// returns after the cap. Makes Engine R latency comparable to headless load-time and
// stops reads from racing a half-rendered page.
function sameOrigin(a, b) { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } }
function waitForLoad(tabId, targetUrl, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const isLoaded = (t) => t && t.status === 'complete' && t.url && t.url !== 'about:blank';
    // Resolve TRUE when loaded, FALSE on timeout — so a hung/slow page is reported
    // honestly to the daemon (recorded timedOut) instead of looking like a fast success.
    const finish = (loaded) => { if (done) return; done = true; try { chrome.tabs.onUpdated.removeListener(onUpd); } catch {} clearTimeout(timer); resolve(loaded); };
    const onUpd = (id, info, t) => { if (id === tabId && info.status === 'complete' && isLoaded(t)) finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.get(tabId, (t) => {
      // Only short-circuit if the tab is ALREADY on the target origin — otherwise the
      // initial 'complete' is the PREVIOUS page (Page.navigate hasn't committed yet)
      // and we must wait for the new navigation's complete event, not return stale.
      if (isLoaded(t) && (!targetUrl || sameOrigin(t.url, targetUrl))) finish(true);
      else chrome.tabs.onUpdated.addListener(onUpd);
    });
  });
}
// Self-healing: the debugger can detach out from under us (tab grouping, an SW
// eviction race, DevTools opening). On "Debugger is not attached", re-attach once
// and retry — so a detached-but-alive bound tab never wedges the whole session.
async function sendCdp(tabId, method, params) {
  try {
    return await rawSendCdp(tabId, method, params);
  } catch (e) {
    if (/not attached/i.test(String((e && e.message) || ''))) {
      attached.delete(tabId);
      await attach(tabId);
      return await rawSendCdp(tabId, method, params);
    }
    throw e;
  }
}
// Trusted click — mirror of Kimi WebBridge's proven mouse_click. el.click() is
// isTrusted:false (rejected by bot-managed sites, and the browser won't release a
// native-autofilled password without a real gesture). CDP Input.dispatchMouseEvent
// is isTrusted:true. Resolve the element to a CDP objectId, scroll it into view,
// read its layout box via DOM.getBoxModel (CDP-level layout — does NOT require the
// tab to be the selected/active one), then dispatch the gesture at the box center.
// No tab activation, no window focus, no focus theft → the user is never interrupted.
async function trustedClick(tabId, selector) {
  const selJson = JSON.stringify(selector || '');
  const resolved = await sendCdp(tabId, 'Runtime.evaluate', { expression: `document.querySelector(${selJson})`, returnByValue: false });
  if (resolved && resolved.exceptionDetails) throw new Error(cdpErrText(resolved.exceptionDetails, 'click resolve error'));
  const objectId = resolved && resolved.result && resolved.result.objectId;
  if (objectId) {
    await sendCdp(tabId, 'Runtime.callFunctionOn', { objectId, functionDeclaration: "function(){ this.scrollIntoView({block:'center',inline:'center'}); }" });
    let box = null;
    try { box = await sendCdp(tabId, 'DOM.getBoxModel', { objectId }); } catch { /* no layout box → JS fallback below */ }
    const content = box && box.model && box.model.content;
    if (content && content.length >= 8) {
      const x = (content[0] + content[2] + content[4] + content[6]) / 4;
      const y = (content[1] + content[3] + content[5] + content[7]) / 4;
      // The `buttons` bitmask is REQUIRED — without it Chromium dispatches the raw
      // mouse events but never synthesizes the DOM click.
      await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      return true;
    }
  }
  const fb = toCdp('click', [selector]); // off-DOM / zero-box → untrusted JS fallback
  const res = await sendCdp(tabId, fb.method, fb.params);
  if (res && res.exceptionDetails) throw new Error(cdpErrText(res.exceptionDetails, 'click error'));
  return (res && res.result && res.result.value) ?? true;
}

async function execute(command, args, sessionId = DEFAULT_SESSION_ID) {
  if (command === 'reload-extension') {
    // Self-reload from disk so the agent can pick up edited extension files without
    // the user toggling the extension by hand. Ack FIRST, then reload on the next
    // tick so the daemon receives this result before the service worker is torn
    // down. (Code edits are picked up; new manifest permissions still need a
    // manual reload.) The WS reconnects on its own via onStartup + the keepalive.
    setTimeout(() => { try { chrome.runtime.reload(); } catch {} }, 200);
    return 'bridge reloading from disk';
  }
  if (command === 'bridge-tabinfo') {
    // Diagnostic: active:false proves Engine R is non-intrusive (the user's view did
    // not switch). groupingUnsupported:true means the host browser (Arc) ignores
    // chrome.tabs.group, so the tab stays a quiet ungrouped background tab.
    // Reports THIS session's bound tab plus a roster of every session's tab.
    const sessions = [...boundBySession.entries()].map(([sid, b]) => ({ sessionId: sid, tabId: b.tabId }));
    const bound = boundBySession.get(sessionId);
    if (!bound) return JSON.stringify({ bound: false, sessionId, sessions });
    const t = await chrome.tabs.get(bound.tabId).catch(() => null);
    return JSON.stringify({ bound: true, sessionId, tabId: bound.tabId, active: t ? t.active : null, rawGroupId: t ? t.groupId : null, grouped: groupedTabId === bound.tabId, groupingUnsupported, sessions });
  }
  const tabId = await ensureBoundTab(command, sessionId);
  if (command === 'click') return await trustedClick(tabId, args[0] || '');
  const cdp = toCdp(command, args);
  const res = await sendCdp(tabId, cdp.method, cdp.params);
  if (command === 'goto') {
    // Wait for the page to actually finish loading before returning (mirror of
    // Kimi's navigate). Without this, goto returns the instant Page.navigate is
    // issued — so (a) a read right after goto hits a half-rendered page, and
    // (b) the recorded latency is ~0ms, NOT comparable to headless's load-time
    // latency, which corrupts the engine-routing recommendation.
    const loaded = await waitForLoad(tabId, args[0] || '');
    try { const t = await chrome.tabs.get(tabId); const b = boundBySession.get(sessionId); if (b) { b.url = t.url || args[0]; b.title = t.title || ''; } } catch {}
    // Mark a load timeout in the result so the daemon records timedOut (the journal's
    // timeout signal) instead of logging a hung page as a fast success.
    return loaded ? `navigated to ${args[0] || ''}` : `navigated to ${args[0] || ''} (load timeout)`;
  }
  if (cdp.method === 'Runtime.evaluate') {
    if (res && res.exceptionDetails) throw new Error(cdpErrText(res.exceptionDetails, 'evaluate error'));
    return (res && res.result && res.result.value) ?? '';
  }
  if (cdp.method === 'Page.captureScreenshot') return (res && res.data) || '';
  return res;
}
chrome.debugger.onDetach.addListener(({ tabId }) => { attached.delete(tabId); });
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  // Drop only the session(s) bound to the closed tab — others keep their tabs.
  for (const [sid, b] of boundBySession) { if (b.tabId === tabId) boundBySession.delete(sid); }
});

// ─── Lifecycle: connect + alarms keepalive ──────────────────
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 }); // ~30s: revive SW + ping
chrome.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
  else send({ type: 'ping' });
});
connect();
