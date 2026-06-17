/**
 * Daemon↔host bridge transport integration check (NO Chrome).
 *
 * Proves the reliability-critical path that Kimi got wrong, end-to-end minus the
 * chrome.debugger hop: a `--engine=real` command dispatched by the daemon is
 * pushed over SSE to the native-messaging host, framed to its stdout (where the
 * extension would read it); we simulate the extension by framing a result back
 * to the host's stdin; the host POSTs it to /bridge/result and the original
 * command resolves with that result.
 *
 * Not a *.test.ts (it orchestrates real subprocesses) — run directly:
 *   bun test/bridge-transport.integration.ts
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

function sh(cmd: string, args: string[]) {
  return Bun.spawn(['bun', 'run', cmd, ...args], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' });
}
async function out(proc: any): Promise<string> {
  return (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
}
function fail(msg: string): never { console.error(`\n❌ FAIL: ${msg}`); cleanup(); process.exit(1); }
function cleanup() {
  try { const pid = JSON.parse(fs.readFileSync(env.BROWSE_STATE_FILE, 'utf-8')).pid; process.kill(pid); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log('1. booting daemon...');
const bootOut = await out(sh(cli, ['goto', 'https://example.com']));
// Endpoint is written during server startup; poll briefly in case of races.
let waited = 0;
while (!fs.existsSync(endpointFile) && waited < 5000) { await Bun.sleep(200); waited += 200; }
if (!fs.existsSync(endpointFile)) fail(`daemon did not publish bridge-endpoint.json.\nboot output:\n${bootOut}`);
console.log('   ✓ endpoint published:', fs.readFileSync(endpointFile, 'utf-8'));

console.log('2. spawning native-messaging host (simulating Chrome)...');
const host = Bun.spawn(['bun', 'run', hostScript], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' });
const dec = new FrameDecoder();
const reader = host.stdout.getReader();
const hostStdin = host.stdin; // Bun FileSink: .write()/.flush()

// Pump host stdout frames into a queue.
const frames: any[] = [];
let resolveFrame: (() => void) | null = null;
(async () => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const f of dec.push(Buffer.from(value))) { frames.push(f); resolveFrame?.(); }
  }
})();
async function nextFrame(predicate: (f: any) => boolean, timeoutMs = 8000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const hit = frames.find(predicate);
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) fail('timed out waiting for a host stdout frame');
    await new Promise<void>((r) => { resolveFrame = r; setTimeout(r, 200); });
  }
}

await nextFrame((f) => f.type === 'bridge-connected');
console.log('   ✓ host connected to daemon SSE (bridge-connected)');

console.log('3. dispatching `goto --engine=real` (daemon → host push)...');
const realCmd = sh(cli, ['goto', 'https://example.com', '--engine=real']);
const cmdFrame = await nextFrame((f) => f.command === 'goto' && typeof f.id === 'string');
console.log('   ✓ command reached host stdout:', JSON.stringify(cmdFrame));

console.log('4. simulating extension result (host stdin → daemon /bridge/result)...');
hostStdin.write(encodeMessage({ id: cmdFrame.id, ok: true, result: 'NAV-OK-REAL-BROWSER' }));
hostStdin.flush();

const realOut = await out(realCmd);
if (!realOut.includes('NAV-OK-REAL-BROWSER')) {
  fail(`--engine=real did not return the bridge result. Got:\n${realOut}`);
}
console.log('   ✓ --engine=real resolved with the real-browser result');

// ── Rediscover scenario (the real-Arc bug): the SAME long-lived host must pick
//    up a NEW daemon endpoint after a daemon restart (ports change each run).
console.log('5. restarting daemon (new port) — host must rediscover...');
try { const pid = JSON.parse(fs.readFileSync(env.BROWSE_STATE_FILE, 'utf-8')).pid; process.kill(pid); } catch {}
fs.rmSync(endpointFile, { force: true });
await Bun.sleep(1500);
await out(sh(cli, ['goto', 'https://example.com']));   // fresh daemon, new endpoint
let w2 = 0; while (!fs.existsSync(endpointFile) && w2 < 5000) { await Bun.sleep(200); w2 += 200; }
// Wait for the host to REDISCOVER the new daemon (a 2nd bridge-connected) — this
// is the fix under test: a long-lived host re-reads the endpoint each reconnect.
let recon = 0;
while (frames.filter((f) => f.type === 'bridge-connected').length < 2 && recon < 14000) { await Bun.sleep(300); recon += 300; }
if (frames.filter((f) => f.type === 'bridge-connected').length < 2) fail('host did not reconnect to the restarted daemon (no 2nd bridge-connected)');
console.log('   ✓ host re-read endpoint and reconnected to the new daemon');
// The new daemon has a fresh hub, so its first command id is also "b1" — match
// by NEW frame arrival (after this point), not by id.
const beforeIdx = frames.length;
const realCmd2 = sh(cli, ['goto', 'https://example.com', '--engine=real']);
let cmdFrame2 = null, w3 = 0;
while (!cmdFrame2 && w3 < 12000) {
  cmdFrame2 = frames.slice(beforeIdx).find((f) => f.command === 'goto');
  if (!cmdFrame2) { await Bun.sleep(200); w3 += 200; }
}
if (!cmdFrame2) {
  const diag = await out(realCmd2).catch(() => '(no output)');
  fail(`post-restart goto command never reached the host.\nrealCmd2 output:\n${diag}`);
}
hostStdin.write(encodeMessage({ id: cmdFrame2.id, ok: true, result: 'NAV-AFTER-RESTART' }));
hostStdin.flush();
const realOut2 = await out(realCmd2);
if (!realOut2.includes('NAV-AFTER-RESTART')) fail(`host did not rediscover the restarted daemon. Got:\n${realOut2}`);
console.log('   ✓ host rediscovered the restarted daemon and the command resolved');

console.log('\n✅ PASS: daemon↔host bridge transport works end-to-end + survives daemon restart (Chrome hop excluded).');
try { host.kill(); } catch {}
cleanup();
process.exit(0);
