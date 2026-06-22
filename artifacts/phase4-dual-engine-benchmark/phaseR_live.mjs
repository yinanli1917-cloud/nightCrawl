/**
 * [INPUT]: lib/runners.mjs (ncSocket socket-fair driver, kimiFetch) + the live
 *          nightcrawl daemon (project .nightcrawl/browse.json) + Engine R bridge.
 * [OUTPUT]: artifacts/phase4-real-task-benchmark/run-<stamp>/results.json — the
 *           nightCrawl side of the head-to-head, run LIVE over the persistent
 *           socket (no per-command cold start), plus a Kimi reachability probe.
 * [POS]: Phase-R live runner. Answers "does our CURRENT version work as expected"
 *        across capability / performance / stability / durability / reflection,
 *        graded against the first-principles + UX axes in benchmark-design-2026-06-19.md.
 *
 * Socket-fair: every command goes through the daemon's unix socket in-process, so
 * latency measures the BROWSER, not a `bun run` cold start (the fairness fix).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ncSocket, kimiFetch } from './lib/runners.mjs';

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(import.meta.dirname, 'run-live-' + STAMP);
mkdirSync(RUN_DIR, { recursive: true });

const results = { stamp: STAMP, axes: {}, notes: [] };
const log = (...a) => console.log(...a);

// ── helpers ──────────────────────────────────────────────────
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function p95(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── AXIS: Capability (both engines) ──────────────────────────
async function capability() {
  log('\n=== CAPABILITY ===');
  const cap = {};

  // C1 round-trip: goto + text on each engine returns the page's real content.
  for (const engine of ['headless', 'real']) {
    const g = await ncSocket(['goto', 'https://example.com'], { engine });
    const t = await ncSocket(['text'], { engine });
    const hasContent = /Example Domain/i.test(t.stdout || '');
    cap[`roundtrip_${engine}`] = { ok: g.ok && t.ok && hasContent, gotoMs: g.durationMs, readMs: t.durationMs, hasContent, sample: (t.stdout || '').slice(0, 80) };
    log(`  roundtrip ${engine}: ok=${g.ok && t.ok && hasContent} goto=${g.durationMs}ms read=${t.durationMs}ms`);
  }

  // C2 async JS (the awaitPromise fix) on Engine R — a Promise must resolve, not return {}.
  const asyncExpr = "(async()=>{await new Promise(r=>setTimeout(r,50));return 'async-ok-'+(40+2)})()";
  const aj = await ncSocket(['js', asyncExpr], { engine: 'real' });
  const asyncResolved = /async-ok-42/.test(aj.stdout || '');
  cap.async_js_real = { ok: asyncResolved, ms: aj.durationMs, sample: (aj.stdout || '').slice(0, 120) };
  log(`  async-js real: resolved=${asyncResolved} (${aj.durationMs}ms) :: ${(aj.stdout || '').slice(0, 90)}`);

  // C3 trusted click (A2) on Engine R — inject a button, click via the bridge, read isTrusted.
  await ncSocket(['goto', 'https://example.com'], { engine: 'real' });
  const setup = "(()=>{const b=document.createElement('button');b.id='nctrust';b.textContent='x';document.body.appendChild(b);window.__t=null;b.addEventListener('click',e=>{window.__t=e.isTrusted});return 'setup'})()";
  await ncSocket(['js', setup], { engine: 'real' });
  const click = await ncSocket(['click', '#nctrust'], { engine: 'real' });
  await sleep(150);
  const readT = await ncSocket(['js', 'String(window.__t)'], { engine: 'real' });
  const trusted = /true/.test(readT.stdout || '');
  cap.trusted_click_real = { ok: trusted, clickOk: click.ok, sample: (readT.stdout || '').slice(0, 60) };
  log(`  trusted-click real: isTrusted=${trusted} (clickOk=${click.ok})`);

  // C4 snapshot honesty on Engine R — must redirect, never mislabel HTML as @refs.
  const snap = await ncSocket(['snapshot'], { engine: 'real' });
  const honest = /SNAPSHOT_UNSUPPORTED_ON_REAL/.test(snap.stdout || '');
  cap.snapshot_honest_real = { ok: honest, sample: (snap.stdout || '').slice(0, 80) };
  log(`  snapshot-honest real: redirect=${honest}`);

  // C5 untrusted-content boundary on Engine R reads (prompt-injection defense).
  const html = await ncSocket(['html'], { engine: 'real' });
  const wrapped = /BEGIN UNTRUSTED EXTERNAL CONTENT/.test(html.stdout || '');
  cap.untrusted_wrap_real = { ok: wrapped };
  log(`  untrusted-wrap real: wrapped=${wrapped}`);

  results.axes.capability = cap;
}

// ── AXIS: Performance (socket-driven, median + p95) ──────────
async function performance() {
  log('\n=== PERFORMANCE (per-command latency, N=8) ===');
  const perf = {};
  const N = 8;
  for (const engine of ['headless', 'real']) {
    await ncSocket(['goto', 'https://example.com'], { engine }); // load once
    const reads = [];
    for (let i = 0; i < N; i++) {
      const r = await ncSocket(['text'], { engine });
      if (r.ok) reads.push(r.durationMs);
    }
    perf[`read_${engine}`] = { n: reads.length, median: median(reads), p95: p95(reads), raw: reads };
    log(`  read ${engine}: median=${median(reads)}ms p95=${p95(reads)}ms (n=${reads.length})`);
  }
  results.axes.performance = perf;
}

// ── AXIS: Stability (success rate over N cycles) ─────────────
async function stability() {
  log('\n=== STABILITY (nav+read cycles, N=8) ===');
  const stab = {};
  const N = 8;
  for (const engine of ['headless', 'real']) {
    let ok = 0;
    const errs = [];
    for (let i = 0; i < N; i++) {
      const g = await ncSocket(['goto', 'https://example.com'], { engine });
      const t = await ncSocket(['text'], { engine });
      const good = g.ok && t.ok && /Example Domain/i.test(t.stdout || '') && !t.reloginPrompt;
      if (good) ok++;
      else errs.push({ i, gotoOk: g.ok, readOk: t.ok, relogin: t.reloginPrompt });
    }
    stab[engine] = { runs: N, ok, successRate: ok / N, errs };
    log(`  ${engine}: ${ok}/${N} ok (${Math.round((ok / N) * 100)}%)`);
  }
  results.axes.stability = stab;
}

// ── AXIS: Durability (sustained loop + latency drift) ────────
async function durability() {
  log('\n=== DURABILITY (16-cycle sustained loop on Engine R) ===');
  const N = 16;
  const lat = [];
  let ok = 0;
  for (let i = 0; i < N; i++) {
    const g = await ncSocket(['goto', 'https://example.com'], { engine: 'real' });
    const t = await ncSocket(['text'], { engine: 'real' });
    if (g.ok && t.ok && /Example Domain/i.test(t.stdout || '')) { ok++; lat.push(g.durationMs + t.durationMs); }
  }
  const first = lat.slice(0, Math.floor(lat.length / 2));
  const last = lat.slice(Math.floor(lat.length / 2));
  const drift = median(last) - median(first);
  results.axes.durability = {
    runs: N, ok, successRate: ok / N,
    firstHalfMedian: median(first), lastHalfMedian: median(last), driftMs: drift,
  };
  log(`  sustained: ${ok}/${N} ok · first-half ${median(first)}ms · last-half ${median(last)}ms · drift ${drift}ms`);
}

// ── AXIS: Reflection (decision lifecycle) ────────────────────
async function reflection() {
  log('\n=== REFLECTION (engine-stats + honest journal) ===');
  const stats = await ncSocket(['engine-stats'], { engine: 'headless' });
  results.axes.reflection = {
    ok: stats.ok && /engine reflection/.test(stats.stdout || ''),
    excerpt: (stats.stdout || '').slice(0, 1200),
  };
  log((stats.stdout || '').slice(0, 600));
}

// ── Kimi reachability (honest: cannot compare live if it's down) ─
async function kimiProbe() {
  log('\n=== KIMI PROBE (:10086) ===');
  let reachable = false, detail = '';
  try {
    const k = await kimiFetch('tabs', {}, { timeoutMs: 5000 });
    reachable = !!k.ok;
    detail = k.error || (k.ok ? 'ok' : 'no ok');
  } catch (e) { detail = String(e?.message ?? e); }
  results.axes.kimi = { reachable, detail };
  log(`  kimi reachable: ${reachable} (${detail})`);
  if (!reachable) results.notes.push('Kimi WebBridge daemon (:10086) not running — live head-to-head deferred; Kimi side graded from documented 2026-05/06 benchmarks.');
}

// ── main ─────────────────────────────────────────────────────
await capability();
await performance();
await stability();
await durability();
await reflection();
await kimiProbe();

const out = join(RUN_DIR, 'results.json');
writeFileSync(out, JSON.stringify(results, null, 2));
log('\nRESULTS_WRITTEN', out);
