/**
 * [INPUT]: nightcrawl CLI (src/cli.ts) + Kimi WebBridge daemon (127.0.0.1:10086)
 * [OUTPUT]: ncRun, kimiCmd, verifyFile, verifyPage — uniform step records
 * [POS]: runner drivers for the Phase-4 dual-engine benchmark
 *
 * Every driver returns a normalized record so the recorder and comparison
 * report can treat all three runners (nc-headless, nc-real, kimi) uniformly.
 */
import { spawnSync } from 'node:child_process';
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

export { REPO, NC_DIR };
