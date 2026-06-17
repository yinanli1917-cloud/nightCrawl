/**
 * [INPUT]: Depends on bridge-protocol (stdio framing), bridge-endpoint (daemon
 *          discovery). Spawned by Chrome as a native-messaging host.
 * [OUTPUT]: A runnable process — relays daemon commands ↔ the bridge extension.
 * [POS]: Phase-3B bridge transport. The DURABLE link that fixes Kimi's failure:
 *        the long-lived daemon connection lives in THIS OS-managed process, not
 *        in the evictable MV3 service worker. Chrome spawns it; it discovers the
 *        daemon via ~/.nightcrawl/bridge-endpoint.json and authenticates with the
 *        daemon's Bearer token — the daemon stays the only listener (the explicit
 *        security fix vs Kimi's open, unauthenticated port).
 *
 * Flow:
 *   daemon  --SSE /bridge/stream-->  host  --stdout(framed)-->  extension
 *   extension  --stdin(framed)-->  host  --POST /bridge/result-->  daemon
 *
 * Run standalone: `bun run bridge-host.ts` (the install script wraps this).
 */

import * as fs from 'fs';
import * as path from 'path';
import { encodeMessage, FrameDecoder } from './bridge-protocol';
import { readBridgeEndpoint } from './bridge-endpoint';

// ─── Diagnostic log ─────────────────────────────────────────
// The host is spawned by Chrome/Arc with stdout reserved for framed messages and
// stderr swallowed, so debug goes to a file. Lets us see, post-hoc, whether the
// browser spawned the host, found the daemon, and connected.
const LOG_FILE = path.join(process.env.HOME || '/tmp', '.nightcrawl', 'bridge-host.log');
function hlog(msg: string): void {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

// ─── stdout: write framed messages to the extension ─────────
function sendToExtension(obj: unknown): void {
  try {
    process.stdout.write(encodeMessage(obj));
  } catch {
    // Extension gone — Chrome will close us; nothing to recover here.
  }
}

// ─── Daemon client ──────────────────────────────────────────
async function postResult(port: number, token: string, payload: unknown): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/bridge/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
  } catch {
    // Daemon unreachable — drop the result; the daemon-side dispatch will time out.
  }
}

/**
 * Subscribe to the daemon's command stream (SSE). Each `data:` line is a
 * {id, command, args} command we forward to the extension. Returns when the
 * stream ends (daemon gone / network drop); the caller decides whether to retry.
 */
async function streamCommands(
  port: number,
  token: string,
  onCommand: (cmd: any) => void,
  onConnect: () => void,
  signal: AbortSignal,
): Promise<void> {
  const resp = await fetch(`http://127.0.0.1:${port}/bridge/stream?token=${encodeURIComponent(token)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal,
  });
  if (!resp.ok || !resp.body) throw new Error(`bridge stream HTTP ${resp.status}`);
  onConnect();

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) {
          const json = line.slice(5).trim();
          if (json) {
            try { onCommand(JSON.parse(json)); } catch {}
          }
        }
      }
    }
  }
}

// ─── Main loop ──────────────────────────────────────────────
export async function runBridgeHost(): Promise<void> {
  hlog(`host spawned (argv: ${process.argv.slice(2).join(' ') || 'none'})`);
  const abort = new AbortController();
  // The CURRENT daemon endpoint. Re-read every loop iteration so the host
  // follows a daemon restart (the port changes each run) — the bug a real-Arc
  // E2E surfaced: reading once at startup left the host pinned to a dead port.
  let currentEp = readBridgeEndpoint();

  // stdin → extension results → daemon. The extension frames each result as
  // {id, ok, result, error}; we relay it to whatever daemon we're bound to now.
  const decoder = new FrameDecoder();
  process.stdin.on('data', (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) {
      if (msg && typeof msg.id === 'string' && currentEp) {
        void postResult(currentEp.port, currentEp.token, msg);
      }
    }
  });
  process.stdin.on('end', () => abort.abort());
  process.on('SIGTERM', () => abort.abort());
  process.on('SIGINT', () => abort.abort());

  sendToExtension({ type: 'bridge-ready' }); // host process is up (not yet daemon-connected)

  // daemon → command stream → extension, with calm reconnect (NOT Kimi's tight
  // 5s thrash): the durable link lives in THIS process, and we re-discover the
  // daemon endpoint on every attempt so restarts are handled transparently.
  while (!abort.signal.aborted) {
    currentEp = readBridgeEndpoint();
    if (!currentEp) {
      hlog('no daemon endpoint yet — waiting');
      await new Promise((r) => setTimeout(r, 2000)); // no daemon yet — wait, don't exit
      continue;
    }
    try {
      hlog(`connecting to daemon :${currentEp.port}`);
      await streamCommands(
        currentEp.port,
        currentEp.token,
        (cmd) => sendToExtension(cmd),
        () => { hlog('connected'); sendToExtension({ type: 'bridge-connected' }); },
        abort.signal,
      );
      hlog('stream ended');
    } catch (err: any) {
      if (abort.signal.aborted) break;
      hlog(`stream error: ${String(err?.message ?? err)}`);
      sendToExtension({ type: 'bridge-reconnect', error: String(err?.message ?? err) });
    }
    if (abort.signal.aborted) break;
    await new Promise((r) => setTimeout(r, 2000)); // calm backoff before re-subscribe
  }
}

// Run when invoked directly (Chrome spawns this file as the host executable).
if (import.meta.main) {
  runBridgeHost().catch((err) => {
    try { process.stderr.write(`[bridge-host] fatal: ${err?.message ?? err}\n`); } catch {}
    process.exit(1);
  });
}
