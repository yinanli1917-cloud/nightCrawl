/**
 * nightCrawl Bridge — MV3 service worker (Engine R).
 *
 * Connects to the native-messaging host (com.nightcrawl.bridge), which holds the
 * durable link to the local daemon. Receives {id, command, args} commands and
 * executes them against the bound tab via chrome.debugger (CDP), posting back
 * {id, ok, result|error}. Chrome frames native-messaging objects for us — the
 * manual 4-byte framing lives in the host, not here.
 *
 * Why this design beats Kimi's: the durable daemon connection lives in the host
 * PROCESS, not in this evictable service worker. If the worker is evicted, the
 * native port closes and we simply reconnect on the next wake (a chrome.alarms
 * keepalive limits eviction) — a calm reconnect, not a 5-second thrash loop.
 *
 * NOTE: this file is plain JS (extensions can't import the TS modules); the
 * command→CDP mapping and tab-rebind logic mirror src/bridge-commands.ts and
 * src/bridge-session.ts, which ARE unit-tested.
 */

'use strict';

const HOST_NAME = 'com.nightcrawl.bridge';
let port = null;
/** @type {{tabId:number, windowId:number, url:string, title:string}|null} */
let bound = null;

// ─── Native-messaging host connection ───────────────────────
function connect() {
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    console.error('[bridge] connectNative failed:', e);
    port = null;
    return;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    console.warn('[bridge] host disconnected:', chrome.runtime.lastError?.message);
    port = null;
    // Calm reconnect (not a thrash loop). The next alarm/wake also reconnects.
    setTimeout(connect, 2000);
  });
  console.log('[bridge] connected to native host');
}

async function onHostMessage(msg) {
  if (!msg || !msg.command) return; // control frame (bridge-ready/reconnect/error)
  const { id, command, args } = msg;
  try {
    const result = await execute(command, args || []);
    port?.postMessage({ id, ok: true, result });
  } catch (e) {
    port?.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
}

// ─── Command → CDP (mirror of src/bridge-commands.ts) ───────
function evaluate(expression) {
  return { method: 'Runtime.evaluate', params: { expression, returnByValue: true } };
}
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
      const sel = JSON.stringify(args[0] || '');
      const val = JSON.stringify(args[1] || '');
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

async function ensureBoundTab(command, args) {
  const tabs = await chrome.tabs.query({});
  // goto with no live bound tab → bind a fresh owned background tab.
  if (command === 'goto' && (!bound || !resolveBoundTab(bound, tabs))) {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    bound = { tabId: tab.id, windowId: tab.windowId, url: tab.url || '', title: tab.title || '' };
    await attach(tab.id);
    return tab.id;
  }
  if (!bound) throw new Error('SESSION_LOST: no bound tab — run a goto first');
  const tabId = resolveBoundTab(bound, tabs);
  if (tabId == null) throw new Error('SESSION_LOST: bound tab is gone (closed) — run a goto to re-bind');
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
  const tabId = await ensureBoundTab(command, args);
  const cdp = toCdp(command, args);
  const res = await sendCdp(tabId, cdp.method, cdp.params);
  // Refresh bound metadata after navigation.
  if (command === 'goto') {
    try { const t = await chrome.tabs.get(tabId); bound.url = t.url || args[0]; bound.title = t.title || ''; } catch {}
    return `navigated to ${args[0] || ''}`;
  }
  if (cdp.method === 'Runtime.evaluate') {
    if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || 'evaluate error');
    return res?.result?.value ?? '';
  }
  if (cdp.method === 'Page.captureScreenshot') return res?.data ?? '';
  return res;
}

// Detach cleanup: if the user opens DevTools or the tab closes, drop the binding.
chrome.debugger.onDetach.addListener(({ tabId }) => { attached.delete(tabId); });
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); if (bound?.tabId === tabId) bound = null; });

// ─── Lifecycle: connect + keepalive ─────────────────────────
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.4 }); // ~24s < SW eviction
chrome.alarms.onAlarm.addListener(() => { if (!port) connect(); });
connect();
