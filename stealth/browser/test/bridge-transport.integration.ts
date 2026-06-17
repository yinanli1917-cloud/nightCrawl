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

await nextFrame((f) => f.type === 'bridge-ready');
console.log('   ✓ host connected to daemon SSE (bridge-ready)');

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

console.log('\n✅ PASS: daemon↔host bridge transport works end-to-end (Chrome hop excluded).');
try { host.kill(); } catch {}
cleanup();
process.exit(0);
