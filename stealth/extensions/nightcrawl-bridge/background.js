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
 *   ← {type:'tool_call', requestId, payload:{name,args}}
 *   → {type:'tool_result', responseToRequestId, payload:{data|error}}
 *   →/← {type:'ping'} / {type:'pong'}
 *
 * Page-control (toCdp) and tab-rebind logic mirror the unit-tested
 * src/bridge-commands.ts and src/bridge-session.ts.
 */

'use strict';

const WS_URL = 'ws://127.0.0.1:10087/'; // must match bridge-ws.ts BRIDGE_WS_PORT
let ws = null;
/** @type {{tabId:number, windowId:number, url:string, title:string}|null} */
let bound = null;

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
    try {
      const data = await execute(payload.name, payload.args || []);
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
    case 'html':
    case 'snapshot': return evaluate('document.documentElement.outerHTML');
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
async function ensureBoundTab(command) {
  const tabs = await chrome.tabs.query({});
  if (command === 'goto' && (!bound || resolveBoundTab(bound, tabs) == null)) {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    bound = { tabId: tab.id, windowId: tab.windowId, url: tab.url || '', title: tab.title || '' };
    await attach(tab.id);
    return tab.id;
  }
  if (!bound) throw new Error('SESSION_LOST: no bound tab — run a goto first');
  const tabId = resolveBoundTab(bound, tabs);
  if (tabId == null) throw new Error('SESSION_LOST: bound tab is gone — run a goto to re-bind');
  if (tabId !== bound.tabId) { bound.tabId = tabId; await attach(tabId); }
  return tabId;
}

// ─── CDP plumbing ───────────────────────────────────────────
const attached = new Set();
function attach(tabId) {
  return new Promise((resolve, reject) => {
    if (attached.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      attached.add(tabId);
      chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}, () => resolve());
    });
  });
}
function sendCdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res);
    });
  });
}
// Trusted click (mirror of clickProbeCall/mouseClickCalls in src/bridge-commands.ts):
// el.click() is isTrusted:false (rejected by bot-managed sites, and the browser
// won't release a native-autofilled password without a real gesture). CDP
// Input.dispatchMouseEvent is isTrusted:true. Probe the element center, dispatch
// real mouse events; fall back to the JS click only for off-screen/zero-box nodes.
function clickProbeExpr(selJson) {
  return `(() => { const el = document.querySelector(${selJson}); if (!el) return null; ` +
    `el.scrollIntoView({block:'center',inline:'center'}); ` +
    `const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null; ` +
    `return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
}
async function trustedClick(tabId, selector) {
  const selJson = JSON.stringify(selector || '');
  const probe = await sendCdp(tabId, 'Runtime.evaluate', { expression: clickProbeExpr(selJson), returnByValue: true, awaitPromise: true });
  if (probe && probe.exceptionDetails) throw new Error(probe.exceptionDetails.text || 'click probe error');
  const pt = probe && probe.result && probe.result.value;
  if (pt && typeof pt.x === 'number') {
    // Chromium routes synthetic mouse press/release only to the ACTIVE, visible
    // tab — a background tab (created active:false) silently drops them (only
    // mouseMoved leaks through). Bring the bound tab + its window to the front so
    // the trusted gesture actually lands. Engine R drives the real browser, so a
    // visible click here is expected.
    try {
      await chrome.tabs.update(tabId, { active: true });
      if (bound && bound.windowId != null) await chrome.windows.update(bound.windowId, { focused: true });
      await new Promise((r) => setTimeout(r, 120)); // let the visibility change settle
    } catch {}
    // The `buttons` bitmask is REQUIRED — without it Chromium dispatches the raw
    // mouse events but never synthesizes the DOM click. Mirrors mouseClickCalls.
    await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 });
    await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 });
    await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1 });
    return true;
  }
  const fb = toCdp('click', [selector]); // untrusted fallback (no box)
  const res = await sendCdp(tabId, fb.method, fb.params);
  if (res && res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'click error');
  return (res && res.result && res.result.value) ?? true;
}

async function execute(command, args) {
  const tabId = await ensureBoundTab(command);
  if (command === 'click') return await trustedClick(tabId, args[0] || '');
  const cdp = toCdp(command, args);
  const res = await sendCdp(tabId, cdp.method, cdp.params);
  if (command === 'goto') {
    try { const t = await chrome.tabs.get(tabId); bound.url = t.url || args[0]; bound.title = t.title || ''; } catch {}
    return `navigated to ${args[0] || ''}`;
  }
  if (cdp.method === 'Runtime.evaluate') {
    if (res && res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'evaluate error');
    return (res && res.result && res.result.value) ?? '';
  }
  if (cdp.method === 'Page.captureScreenshot') return (res && res.data) || '';
  return res;
}
chrome.debugger.onDetach.addListener(({ tabId }) => { attached.delete(tabId); });
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); if (bound && bound.tabId === tabId) bound = null; });

// ─── Lifecycle: connect + alarms keepalive ──────────────────
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 }); // ~30s: revive SW + ping
chrome.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
  else send({ type: 'ping' });
});
connect();
