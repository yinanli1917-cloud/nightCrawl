/**
 * Daemon↔host bridge transport integration check (NO Chrome).
 *
 * Proves the reliability-critical path Kimi got wrong, end-to-end minus the
 * chrome.debugger hop: --engine=real commands flow daemon → SSE → native host →
 * (simulated extension) → /bridge/result → resolved. Also proves a long-lived
 * host REDISCOVERS the daemon after a restart (ports change per run) — the bug a
 * real-Arc E2E surfaced.
 *
 * The "extension" is simulated by an auto-replier that answers every command the
 * host forwards on its stdout with a result on its stdin. The assertions poll
 * the real `--engine=real` round-trip, so they tolerate reconnect latency
 * instead of racing on connection-event ordering.
 *
 * Not a *.test.ts (orchestrates real subprocesses) — run: bun test/bridge-transport.integration.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeMessage, FrameDecoder } from '../src/bridge-protocol';

const browserDir = path.resolve(import.meta.dir, '..');
const cli = path.join(browserDir, 'src/cli.ts');
const hostScript = path.join(browserDir, 'src/bridge-host.ts');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bridge-int-'));
const endpointFile = path.join(TMP, 'bridge-endpoint.json');
const env = {
  ...process.env,
  PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
  BROWSE_STATE_FILE: path.join(TMP, 'state', 'browse.json'),
  BROWSE_PROFILE_DIR: path.join(TMP, 'profile'),
  BRIDGE_ENDPOINT_FILE: endpointFile,
  BROWSE_AUTO_HANDOVER: '0',
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
  try { host?.kill(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

// ── Run `--engine=real` and report whether it round-tripped through the bridge.
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

let host: any;

console.log('1. booting daemon...');
await bootDaemon();
let w = 0; while (!fs.existsSync(endpointFile) && w < 5000) { await Bun.sleep(200); w += 200; }
if (!fs.existsSync(endpointFile)) fail('daemon did not publish bridge-endpoint.json');
console.log('   ✓ endpoint published');

console.log('2. spawning native host + auto-replier (simulating the extension)...');
host = Bun.spawn(['bun', 'run', hostScript], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' });
const dec = new FrameDecoder();
const reader = host.stdout.getReader();
// Auto-replier: answer every command the host forwards. This is the "extension".
(async () => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const f of dec.push(Buffer.from(value))) {
      if (f && typeof f.id === 'string' && f.command) {
        host.stdin.write(encodeMessage({ id: f.id, ok: true, result: `SIM-OK:${f.command}` }));
        host.stdin.flush();
      }
    }
  }
})();

console.log('3. --engine=real round-trips daemon → host → (extension) → daemon...');
await pollReal('round-trip works', 15000);

console.log('4. restarting daemon (new port) — host must REDISCOVER...');
const oldPid = daemonPid();
if (oldPid) {
  try { process.kill(oldPid); } catch {}
  let k = 0; while (k < 10000) { try { process.kill(oldPid, 0); } catch { break; } await Bun.sleep(200); k += 200; }
}
fs.rmSync(endpointFile, { force: true });
await Bun.sleep(500);
await bootDaemon();
let w2 = 0; while (!fs.existsSync(endpointFile) && w2 < 5000) { await Bun.sleep(200); w2 += 200; }
await pollReal('host rediscovered the restarted daemon (new port) and round-trips again', 25000);

console.log('\n✅ PASS: daemon↔host transport works + survives daemon restart (Chrome hop excluded).');
cleanup();
process.exit(0);
