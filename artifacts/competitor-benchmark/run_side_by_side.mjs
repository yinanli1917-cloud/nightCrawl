#!/usr/bin/env node
/**
 * Side-by-side nightCrawl gates + optional Kimi health.
 * No XHS / 小红书 URLs — ever.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
const NC_DIR = join(REPO, 'stealth/browser');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(REPO, 'artifacts/competitor-benchmark', `run-${STAMP}`);
mkdirSync(RUN_DIR, { recursive: true });

const FORBIDDEN_HOST = /xiaohongshu|xhslink|xhscdn/i;

const env = {
  ...process.env,
  PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH || ''}`,
  BROWSE_EXTENSIONS: 'all',
  BROWSE_IGNORE_HTTPS_ERRORS: '1',
  BROWSE_AUTO_HANDOVER: '0',
};

const results = [];
const gates = {};

function log(step, data) {
  const row = { ts: new Date().toISOString(), step, ...data };
  results.push(row);
  return row;
}

function nc(args, timeoutMs = 90_000) {
  if (args.some((a) => FORBIDDEN_HOST.test(a))) {
    throw new Error('Refusing forbidden hostile URL in benchmark');
  }
  const started = Date.now();
  const r = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: NC_DIR,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  const rec = {
    command: `nc ${args.join(' ')}`,
    durationMs: Date.now() - started,
    exitCode: r.status,
    ok: r.status === 0,
    stdout: (r.stdout || '').slice(0, 8000),
    stderr: (r.stderr || '').slice(0, 4000),
    headed_windows: 0,
  };
  if (/launchHeaded|open-handoff|headed Chromium/i.test(rec.stdout + rec.stderr)) {
    rec.headed_windows = 1;
  }
  log('nc', rec);
  return rec;
}

function kimiHealth() {
  const r = spawnSync('curl', ['-s', '-m', '3', 'http://127.0.0.1:10086/health'], { encoding: 'utf8' });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  log('kimi_health', { ok: r.status === 0, body: (r.stdout || '').slice(0, 500), parsed });
  return parsed;
}

// Manifest
const manifest = {
  stamp: STAMP,
  git: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout?.trim(),
  profile: `${process.env.HOME}/.nightcrawl/chromium-profile`,
  engineSeed: existsSync(`${process.env.HOME}/.nightcrawl/state/engine-seed.json`),
  browseCookies: existsSync(`${process.env.HOME}/.nightcrawl/browse-cookies.json`),
  BROWSE_AUTO_HANDOVER: env.BROWSE_AUTO_HANDOVER,
};
writeFileSync(join(RUN_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

// S2 public
const ex = nc(['goto', 'https://example.com']);
const title = nc(['js', 'document.title']);
gates.S2_example = ex.ok && title.stdout.includes('Example Domain') && ex.headed_windows === 0;

// Hostile unit tests only (no live XHS)
const hostileTest = spawnSync('bun', ['test', 'test/url-validation-hostile.test.ts'], {
  cwd: NC_DIR,
  encoding: 'utf8',
  timeout: 60_000,
});
gates.S5_hostile_unit = hostileTest.status === 0;
log('hostile_unit_test', { exitCode: hostileTest.status });

// Canvas S1 (may fail if not authed — record honestly)
const canvas = nc(['goto', 'https://canvas.uw.edu/']);
const canvasSnap = nc(['snapshot'], 60_000);
const canvasHay = `${canvas.stdout}\n${canvasSnap.stdout}`;
gates.S1_canvas =
  canvasHay.toLowerCase().includes('dashboard') &&
  !/login_required|sign in to/i.test(canvasHay) &&
  canvas.headed_windows === 0 &&
  canvasSnap.headed_windows === 0;

// S4 restart
const stateFile = join(REPO, '.nightcrawl/browse.json');
nc(['goto', 'https://example.com']);
let pid = null;
if (existsSync(stateFile)) {
  try { pid = JSON.parse(readFileSync(stateFile, 'utf8')).pid; } catch {}
}
if (pid) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
  spawnSync('sleep', ['3']);
}
const after = nc(['goto', 'https://example.com']);
const afterTitle = nc(['js', 'document.title']);
gates.S4_restart =
  after.ok &&
  afterTitle.stdout.includes('Example Domain') &&
  after.headed_windows === 0 &&
  afterTitle.headed_windows === 0;

// S4b sync
const sync = nc(['sync', 'now'], 120_000);
gates.S4b_sync = sync.ok && sync.headed_windows === 0;

// S6 CF dash probe (read-only)
const cf = nc(['goto', 'https://dash.cloudflare.com/'], 75_000);
const cfHay = cf.stdout + cf.stderr;
gates.S6_cf_dash =
  cf.ok &&
  cf.headed_windows === 0 &&
  !/LOGIN_REQUIRED.*cloudflare/i.test(cfHay) || cfHay.toLowerCase().includes('cloudflare');

// Kimi
const kimi = kimiHealth();
gates.kimi_daemon = !!(kimi && (kimi.running || kimi.extension_connected));

writeFileSync(join(RUN_DIR, 'results.jsonl'), results.map((r) => JSON.stringify(r)).join('\n'));
writeFileSync(join(RUN_DIR, 'gates.json'), JSON.stringify(gates, null, 2));

const md = `# Benchmark run ${STAMP}

## Gates (nightCrawl)

| Gate | Pass |
|------|------|
${Object.entries(gates).map(([k, v]) => `| ${k} | ${v ? 'yes' : 'no'} |`).join('\n')}

## Notes

- No XHS URLs in this run.
- \`BROWSE_AUTO_HANDOVER=0\` (headless-only product path).
- Artifacts: \`${RUN_DIR}\`

## Hybrid decision (Phase 2)

- **Default:** headless nightCrawl + Arc cookie sync; no Kimi runtime dependency.
- **Kimi:** competitor benchmark only; optional adapter only if Tier-2 auth gaps remain after persistence fixes.
- **Real-browser bridge:** background cookie sync first; visible bridge only if scorecard proves sync insufficient for fingerprint-pinned SSO.

`;
writeFileSync(join(RUN_DIR, 'comparison.md'), md);

console.log('RUN_DIR', RUN_DIR);
console.log('gates', gates);
process.exit(Object.values(gates).every(Boolean) ? 0 : 1);
