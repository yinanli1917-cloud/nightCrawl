/**
 * [INPUT]: None (reads/writes a small JSON file under ~/.nightcrawl).
 * [OUTPUT]: Exports BridgeEndpoint, bridgeEndpointPath, write/readBridgeEndpoint.
 * [POS]: Phase-3B bridge discovery. The native-messaging host is spawned by
 *        Chrome with no knowledge of which project's daemon is running, so the
 *        daemon publishes its {port, token} to a GLOBAL well-known file on
 *        startup and the host reads it. Owner-only (0600) — the token is a
 *        local capability, never leaves the machine.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface BridgeEndpoint {
  port: number;
  token: string;
  pid: number;
}

export function bridgeEndpointPath(): string {
  // Override for hermetic tests / multi-daemon isolation. Otherwise the global
  // well-known path the Chrome-spawned host knows to read.
  if (process.env.BRIDGE_ENDPOINT_FILE) return process.env.BRIDGE_ENDPOINT_FILE;
  return path.join(process.env.HOME || '/tmp', '.nightcrawl', 'bridge-endpoint.json');
}

export function writeBridgeEndpoint(ep: BridgeEndpoint): void {
  try {
    const dest = bridgeEndpointPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ep), { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch {}
}

export function readBridgeEndpoint(): BridgeEndpoint | null {
  try {
    const ep = JSON.parse(fs.readFileSync(bridgeEndpointPath(), 'utf-8'));
    if (typeof ep?.port === 'number' && typeof ep?.token === 'string') return ep;
  } catch {}
  return null;
}

export function clearBridgeEndpoint(): void {
  try { fs.unlinkSync(bridgeEndpointPath()); } catch {}
}
