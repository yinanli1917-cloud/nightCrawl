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

import { encodeMessage, FrameDecoder } from './bridge-protocol';
import { readBridgeEndpoint } from './bridge-endpoint';

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
  signal: AbortSignal,
): Promise<void> {
  const resp = await fetch(`http://127.0.0.1:${port}/bridge/stream?token=${encodeURIComponent(token)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal,
  });
  if (!resp.ok || !resp.body) throw new Error(`bridge stream HTTP ${resp.status}`);

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
  const ep = readBridgeEndpoint();
  if (!ep) {
    sendToExtension({ type: 'bridge-error', error: 'no daemon endpoint — start nightcrawl first' });
    return;
  }

  // stdin → extension results → daemon. The extension frames each result as
  // {id, ok, result, error}; we relay it to the daemon's /bridge/result.
  const decoder = new FrameDecoder();
  process.stdin.on('data', (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) {
      if (msg && typeof msg.id === 'string') {
        void postResult(ep.port, ep.token, msg);
      }
    }
  });

  // daemon → command stream → extension, with reconnect-on-drop (graceful, NOT
  // Kimi's tight 5s loop: a fixed backoff, and the connection lives here in the
  // host process, so a service-worker eviction doesn't kill it).
  const abort = new AbortController();
  process.stdin.on('end', () => abort.abort());
  process.on('SIGTERM', () => abort.abort());
  process.on('SIGINT', () => abort.abort());

  sendToExtension({ type: 'bridge-ready' });
  while (!abort.signal.aborted) {
    try {
      await streamCommands(ep.port, ep.token, (cmd) => sendToExtension(cmd), abort.signal);
    } catch (err: any) {
      if (abort.signal.aborted) break;
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
