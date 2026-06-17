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
function evaluate(expression) { return { method: 'Runtime.evaluate', params: { expression, returnByValue: true } }; }
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
async function execute(command, args) {
  const tabId = await ensureBoundTab(command);
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
