/**
 * [INPUT]: Depends on bridge-hub (command/result correlation). Uses Bun.serve's
 *          WebSocket support.
 * [OUTPUT]: Exports BRIDGE_WS_PORT, BRIDGE_EXTENSION_ID, startBridgeWsServer.
 * [POS]: Phase-3B Engine-R transport — the daemon-side WebSocket SERVER the
 *        real-browser extension dials OUT to.
 *
 * This replaces the native-messaging host (deleted): reverse-engineering the
 * installed Kimi WebBridge showed it uses NO native messaging — its MV3
 * extension opens an outbound WebSocket to a localhost daemon and drives pages
 * via chrome.debugger (CDP). Native-messaging hosts die under Chrome's bare
 * spawn env and can't keep an MV3 service worker alive; an extension→daemon
 * WebSocket sidesteps both (the inevitable SW-eviction reconnect is harmless).
 *
 * Security: bound to 127.0.0.1 only, and the WS upgrade is gated on an
 * Origin allowlist of our pinned extension id — a hostile web page's WS gets a
 * page Origin (not chrome-extension://…), so it's rejected. The daemon remains
 * the listener; nothing on it is reachable off-host.
 *
 * Protocol (mirrors Kimi's shape so the model is battle-tested):
 *   ext → daemon : {type:'hello', payload:{extensionVersion}}
 *   daemon → ext : {type:'hello_ack'}
 *   daemon → ext : {type:'tool_call', requestId, payload:{name, args}}
 *   ext → daemon : {type:'tool_result', responseToRequestId, payload:{data|error}}
 *   ext → daemon : {type:'ping'} / daemon → ext : {type:'pong'}  (liveness)
 */

import type { BridgeHub, BridgeCommand } from './bridge-hub';

// Fixed port the extension hardcodes (Kimi uses 10086; we use a distinct one to
// coexist). Overridable for tests via BRIDGE_WS_PORT.
export const BRIDGE_WS_PORT = parseInt(process.env.BRIDGE_WS_PORT || '10087', 10);

// The pinned extension id (manifest `key`). Only this origin may drive the bridge.
export const BRIDGE_EXTENSION_ID = 'obapdlogondaffdidmnndlcbefockbjc';

type Sink = (cmd: BridgeCommand) => void;

/**
 * Start the bridge WebSocket server and wire a connected extension to the hub.
 * Returns a stop() handle, or null if the port is already bound (another daemon
 * owns the bridge — only one daemon hosts it).
 */
export function startBridgeWsServer(
  hub: BridgeHub,
  opts: { port?: number; allowedExtensionId?: string; log?: (m: string) => void } = {},
): { stop: () => void; port: number } | null {
  const port = opts.port ?? BRIDGE_WS_PORT;
  const allowed = opts.allowedExtensionId ?? BRIDGE_EXTENSION_ID;
  const log = opts.log ?? (() => {});

  try {
    const server = Bun.serve<{ sink: Sink | null }>({
      port,
      hostname: '127.0.0.1',
      fetch(req, srv) {
        const origin = req.headers.get('origin') || '';
        // Only our extension (or any chrome-extension origin if no id pinned).
        // BRIDGE_WS_ALLOW_ANY_ORIGIN=1 relaxes this for the integration test's
        // simulated client; never set in production.
        const relaxed = process.env.BRIDGE_WS_ALLOW_ANY_ORIGIN === '1';
        const okOrigin = relaxed
          || (allowed ? origin === `chrome-extension://${allowed}` : origin.startsWith('chrome-extension://'));
        if (!okOrigin) return new Response('forbidden', { status: 403 });
        if (srv.upgrade(req, { data: { sink: null } })) return undefined;
        return new Response('nightcrawl bridge', { status: 200 });
      },
      websocket: {
        open(ws) {
          const sink: Sink = (cmd) =>
            ws.send(JSON.stringify({ type: 'tool_call', requestId: cmd.id, payload: { name: cmd.command, args: cmd.args } }));
          ws.data.sink = sink;
          hub.attach(sink);
          ws.send(JSON.stringify({ type: 'hello_ack' }));
          log('real-browser bridge connected (ws)');
        },
        message(ws, raw) {
          let m: any;
          try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
          if (m?.type === 'tool_result') {
            const err = m.payload?.error;
            hub.deliver(m.responseToRequestId, m.payload?.data, err != null ? String(err) : undefined);
          } else if (m?.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
          // 'hello' needs no action beyond the hello_ack already sent on open.
        },
        close(ws) {
          // Connection-scoped: only detaches if this ws's sink is still current,
          // so a stale reconnect can't clobber a newer connection.
          hub.detach(ws.data.sink ?? undefined);
          log('real-browser bridge disconnected (ws)');
        },
      },
    });
    return { stop: () => { try { server.stop(true); } catch {} }, port: server.port };
  } catch (e: any) {
    // EADDRINUSE → another daemon already hosts the bridge; that's fine.
    log(`bridge ws server not started: ${e?.message ?? e}`);
    return null;
  }
}
