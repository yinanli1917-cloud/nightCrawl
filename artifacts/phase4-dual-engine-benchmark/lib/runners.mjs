/**
 * [INPUT]: nightcrawl CLI (src/cli.ts) + Kimi WebBridge daemon (127.0.0.1:10086)
 * [OUTPUT]: ncRun, kimiCmd, verifyFile, verifyPage — uniform step records
 * [POS]: runner drivers for the Phase-4 dual-engine benchmark
 *
 * Every driver returns a normalized record so the recorder and comparison
 * report can treat all three runners (nc-headless, nc-real, kimi) uniformly.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { isReloginPrompt, isHeadedPop, isVerifyOk } from './guards.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
const NC_DIR = join(REPO, 'stealth/browser');

// Never let a hostile / blocklisted host into a benchmark command.
const FORBIDDEN_HOST = /xiaohongshu|xhslink|xhscdn|douyin|weibo\.com/i;

const BASE_ENV = {
  ...process.env,
  PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH || ''}`,
  BROWSE_EXTENSIONS: 'all',
  BROWSE_IGNORE_HTTPS_ERRORS: '1',
};

// ── nightcrawl CLI driver ────────────────────────────────────────────────
// engine: 'headless' | 'real' | 'auto'. Flag is appended AFTER the command,
// because cli.ts treats argv[0] as the command and strips --engine from the
// remaining args (cli.ts:640-652).
export function ncRun(args, { engine = 'auto', timeoutMs = 90_000, env = {} } = {}) {
  if (args.some((a) => FORBIDDEN_HOST.test(String(a)))) {
    throw new Error(`Refusing forbidden host in: nc ${args.join(' ')}`);
  }
  const fullArgs = engine === 'auto' ? [...args] : [...args, `--engine=${engine}`];
  const started = Date.now();
  const r = spawnSync('bun', ['run', 'src/cli.ts', ...fullArgs], {
    cwd: NC_DIR,
    env: { ...BASE_ENV, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 24 * 1024 * 1024,
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const hay = `${stdout}\n${stderr}`;
  return {
    runner: `nc-${engine}`,
    cmd: `nc ${fullArgs.join(' ')}`,
    durationMs: Date.now() - started,
    exitCode: r.status,
    ok: r.status === 0,
    timedOut: r.signal === 'SIGTERM' && Date.now() - started >= timeoutMs - 50,
    stdout: stdout.slice(0, 12_000),
    stderr: stderr.slice(0, 4_000),
    reloginPrompt: isReloginPrompt(hay),
    headedPop: isHeadedPop(hay),
  };
}

// ── Kimi WebBridge driver ────────────────────────────────────────────────
// Kimi takes {action, args, session} over HTTP POST /command. We use curl so
// a hung navigate is bounded by -m (curl's own timeout), matching how a real
// agent would call it.
export function kimiCmd(action, args = {}, { session = 'phase4', timeoutMs = 45_000 } = {}) {
  const url = args.url || args.code || '';
  if (FORBIDDEN_HOST.test(String(url))) {
    throw new Error(`Refusing forbidden host in Kimi ${action}`);
  }
  const payload = JSON.stringify({ action, args, session });
  const started = Date.now();
  const r = spawnSync(
    'curl',
    ['-s', '-m', String(Math.ceil(timeoutMs / 1000)), '-X', 'POST',
     'http://127.0.0.1:10086/command', '-H', 'Content-Type: application/json', '-d', payload],
    { encoding: 'utf8', timeout: timeoutMs + 5_000, maxBuffer: 24 * 1024 * 1024 },
  );
  const raw = r.stdout || '';
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* hung/empty body → null */ }
  const ok = !!(parsed && parsed.ok !== false && !parsed.error);
  return {
    runner: 'kimi',
    cmd: `kimi ${action} ${JSON.stringify(args).slice(0, 120)}`,
    durationMs: Date.now() - started,
    ok,
    // An empty body after the full curl timeout is Kimi's signature "hang".
    hung: raw.trim() === '' && Date.now() - started >= timeoutMs - 500,
    data: parsed?.data ?? null,
    error: parsed?.error?.message ?? (raw.trim() === '' ? 'empty body (hang/timeout)' : null),
    raw: raw.slice(0, 8_000),
  };
}

export function kimiHealth() {
  const r = spawnSync(
    `${process.env.HOME}/.kimi-webbridge/bin/kimi-webbridge`, ['status'],
    { encoding: 'utf8', timeout: 8_000 },
  );
  let parsed = null;
  try { parsed = JSON.parse(r.stdout || ''); } catch {}
  return parsed;
}

// ── Deliverable verification gate (DVC) ──────────────────────────────────
export function verifyFile(filePath, opts = {}) {
  const args = ['verify', 'file', filePath];
  if (opts.kind) args.push('--kind', opts.kind);
  for (const c of opts.contains || []) args.push('--contains', c);
  for (const c of opts.notContains || []) args.push('--not-contains', c);
  if (opts.minPages != null) args.push('--min-pages', String(opts.minPages));
  if (opts.minBytes != null) args.push('--min-bytes', String(opts.minBytes));
  if (opts.allowBrowserPrint) args.push('--allow-browser-print');
  const rec = ncRun(args, { engine: 'auto', timeoutMs: 30_000 });
  rec.passed = isVerifyOk(rec.stdout);
  return rec;
}

export function verifyPage({ engine = 'headless', urlIncludes = [], urlExcludes = [], textIncludes = [], textExcludes = [] } = {}) {
  const args = ['verify', 'page'];
  for (const u of urlIncludes) args.push('--url-includes', u);
  for (const u of urlExcludes) args.push('--url-excludes', u);
  for (const t of textIncludes) args.push('--text-includes', t);
  for (const t of textExcludes) args.push('--text-excludes', t);
  const rec = ncRun(args, { engine, timeoutMs: 45_000 });
  rec.passed = isVerifyOk(rec.stdout);
  return rec;
}

// ── Fair-latency drivers: in-process fetch, no subprocess per command ─────
// The PERFORMANCE axis must compare the browsers, not the test harness. ncRun
// spawns `bun run src/cli.ts` per command and kimiCmd spawns `curl` per command —
// both add a cold process start (tens to hundreds of ms) that has nothing to do
// with the browser. These two drivers instead hit each tool's PERSISTENT daemon
// socket via one in-process fetch, so durationMs is the command round-trip only.
// Prereq: the daemon must already be warm (run `ncRun(['status'])` once first).

const STATE_FILE = join(REPO, '.nightcrawl', 'browse.json');

let _daemonState = null;
export function readDaemonState({ refresh = false } = {}) {
  if (_daemonState && !refresh) return _daemonState;
  try {
    _daemonState = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    _daemonState = null; // daemon not started yet
  }
  return _daemonState;
}

// nightcrawl over its unix socket. args[0] is the command; engine/force ride in
// the JSON body (the daemon's native shape), not appended to argv.
export async function ncSocket(args, { engine = 'auto', force = false, timeoutMs = 90_000 } = {}) {
  if (args.some((a) => FORBIDDEN_HOST.test(String(a)))) {
    throw new Error(`Refusing forbidden host in: nc ${args.join(' ')}`);
  }
  const st = readDaemonState();
  const base = { runner: `nc-${engine}`, cmd: `nc ${args.join(' ')} [socket]`, reloginPrompt: false, headedPop: false };
  if (!st || !st.socket || !st.token) {
    return { ...base, durationMs: 0, ok: false, timedOut: false, stdout: '', stderr: 'no daemon state', error: 'NO_DAEMON' };
  }
  const [command, ...rest] = args;
  const body = JSON.stringify({ command, args: rest, engine, force });
  const started = Date.now();
  try {
    const resp = await fetch('http://localhost/command', {
      unix: st.socket,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${st.token}` },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await resp.text();
    return {
      ...base,
      durationMs: Date.now() - started,
      exitCode: resp.ok ? 0 : 1,
      ok: resp.ok,
      timedOut: false,
      stdout: text.slice(0, 12_000),
      stderr: '',
      reloginPrompt: isReloginPrompt(text),
      headedPop: isHeadedPop(text),
    };
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || /timed out|timeout/i.test(String(e?.message ?? ''));
    return { ...base, durationMs: Date.now() - started, ok: false, timedOut, stdout: '', stderr: String(e?.message ?? e), error: String(e?.message ?? e) };
  }
}

// Kimi over its HTTP port, in-process (mirror of kimiCmd without the curl spawn).
export async function kimiFetch(action, args = {}, { session = 'phase4', timeoutMs = 45_000 } = {}) {
  const url = args.url || args.code || '';
  if (FORBIDDEN_HOST.test(String(url))) throw new Error(`Refusing forbidden host in Kimi ${action}`);
  const payload = JSON.stringify({ action, args, session });
  const started = Date.now();
  try {
    const resp = await fetch('http://127.0.0.1:10086/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* non-JSON body */ }
    const ok = !!(parsed && parsed.ok !== false && !parsed.error);
    return {
      runner: 'kimi',
      cmd: `kimi ${action} ${JSON.stringify(args).slice(0, 120)}`,
      durationMs: Date.now() - started,
      ok,
      hung: false,
      data: parsed?.data ?? null,
      error: parsed?.error?.message ?? (raw.trim() === '' ? 'empty body' : null),
      raw: raw.slice(0, 8_000),
    };
  } catch (e) {
    const hung = e?.name === 'TimeoutError';
    return { runner: 'kimi', cmd: `kimi ${action}`, durationMs: Date.now() - started, ok: false, hung, data: null, error: String(e?.message ?? e), raw: '' };
  }
}

export { REPO, NC_DIR };
