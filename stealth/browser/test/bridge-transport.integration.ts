/**
 * Engine-R WebSocket transport integration check (NO Chrome).
 *
 * Proves the daemon↔extension path end-to-end minus chrome.debugger: a
 * --engine=real command flows daemon → hub → WS server → (simulated extension
 * WS client) → tool_result → resolved. Also proves the client REDISCOVERS the
 * daemon after a restart (the extension's reconnect behavior).
 *
 * The "extension" is a WebSocket CLIENT (mirroring the real MV3 extension, which
 * dials out) that auto-replies to every tool_call. Assertions poll the real
 * --engine=real round-trip, so they tolerate reconnect timing.
 *
 * Run: BRIDGE_WS_ALLOW_ANY_ORIGIN=1 bun test/bridge-transport.integration.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const browserDir = path.resolve(import.meta.dir, '..');
const cli = path.join(browserDir, 'src/cli.ts');
const WS_PORT = 18791; // unique test port (real default is 10087)
const WS_URL = `ws://127.0.0.1:${WS_PORT}/`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wsbridge-'));
const env = {
  ...process.env,
  PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
  BROWSE_STATE_FILE: path.join(TMP, 'state', 'browse.json'),
  BROWSE_PROFILE_DIR: path.join(TMP, 'profile'),
  BROWSE_AUTO_HANDOVER: '0',
  BRIDGE_WS_PORT: String(WS_PORT),
  BRIDGE_WS_ALLOW_ANY_ORIGIN: '1',
};
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });

function sh(args: string[]) {
  return Bun.spawn(['bun', 'run', cli, ...args], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' });
}
async function out(proc: any): Promise<string> {
  return (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
}
function bootDaemon() { return out(sh(['goto', 'https://example.com'])); }
function daemonPid(): number | undefined {
  try { return JSON.parse(fs.readFileSync(env.BROWSE_STATE_FILE, 'utf-8')).pid; } catch { return undefined; }
}
function fail(msg: string): never { console.error(`\n❌ FAIL: ${msg}`); cleanup(); process.exit(1); }
function cleanup() {
  const pid = daemonPid(); if (pid) { try { process.kill(pid); } catch {} }
  try { client?.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

// ── Simulated extension: a self-reconnecting WS client that auto-replies. ──
let client: WebSocket | null = null;
function startClient() {
  let c: WebSocket;
  try { c = new (globalThis as any).WebSocket(WS_URL); } catch { setTimeout(startClient, 500); return; }
  client = c;
  c.onmessage = (ev: any) => {
    let m: any; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'tool_call') {
      c.send(JSON.stringify({ type: 'tool_result', responseToRequestId: m.requestId, payload: { data: `SIM-OK:${m.payload?.name}` } }));
    }
  };
  c.onclose = () => { setTimeout(startClient, 500); };  // reconnect like the real extension
  c.onerror = () => { try { c.close(); } catch {} };
}

async function realRoundTrips(): Promise<boolean> {
  const o = await out(sh(['goto', 'https://example.com', '--engine=real']));
  return o.includes('[real-browser]');
}
async function pollReal(label: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await realRoundTrips()) { console.log(`   ✓ ${label}`); return; }
    await Bun.sleep(500);
  }
  fail(`${label} — --engine=real never round-tripped within ${timeoutMs}ms`);
}

console.log('1. booting daemon (starts WS bridge server)...');
await bootDaemon();
console.log('   ✓ daemon up');

console.log('2. connecting simulated extension (WS client + auto-replier)...');
startClient();
await Bun.sleep(800);

console.log('3. --engine=real round-trips daemon → WS → (extension) → daemon...');
await pollReal('round-trip works', 15000);

console.log('4. restarting daemon — extension must reconnect + rediscover...');
const oldPid = daemonPid();
if (oldPid) {
  try { process.kill(oldPid); } catch {}
  let k = 0; while (k < 10000) { try { process.kill(oldPid, 0); } catch { break; } await Bun.sleep(200); k += 200; }
}
await Bun.sleep(500);
await bootDaemon();
await pollReal('extension reconnected to the restarted daemon and round-trips again', 25000);

console.log('\n✅ PASS: Engine-R WebSocket transport works + survives daemon restart (Chrome hop excluded).');
cleanup();
process.exit(0);
