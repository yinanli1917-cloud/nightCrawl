#!/usr/bin/env bun
/**
 * Phase B — capability + reliability head-to-head:
 *   nc-headless (CloakBrowser) · nc-real (Engine R, live Arc) · kimi (live Chrome).
 *
 * Neutral public sites only (no login), so the comparison is about raw capability
 * and stability in each tool's own best environment — Kimi in Chrome (its tested
 * home), nightCrawl in Arc. Tasks exercise the fixes verified this session:
 *   T1 navigate+read · T2 async JS (A1) · T3 trusted click (A2) · T4 reliability.
 */
import { ncRun, kimiCmd } from './lib/runners.mjs';
import { Recorder, makeRunDir } from './lib/recorder.mjs';

const { runDir, stamp } = makeRunDir();
const rec = new Recorder(runDir, stamp);

// Pull the meaningful value out of nc stdout ([real-browser] prefix / [browse] noise).
function ncVal(r) {
  return (r.stdout || '')
    .split('\n')
    .map((l) => l.replace(/^\[real-browser\]\s*/, '').trim())
    .filter((l) => l && !l.startsWith('[browse]') && !l.startsWith('──') && !l.startsWith('engine_used') && !l.startsWith('recommended') && !l.startsWith('signals') && !l.startsWith('why') && !l.startsWith('override') && !l.startsWith('evidence'))
    .join(' ')
    .trim();
}
const median = (xs) => { if (!xs.length) return 0; const s=[...xs].sort((a,b)=>a-b); const m=s.length>>1; return s.length%2?s[m]:Math.round((s[m-1]+s[m])/2); };

const INJECT = '(()=>{document.querySelectorAll("#nctb").forEach(e=>e.remove());const b=document.createElement("button");b.id="nctb";b.textContent="t";b.style.cssText="position:fixed;top:10px;left:10px;z-index:99999;padding:20px";window.__nctb="none";b.addEventListener("click",e=>window.__nctb=String(e.isTrusted));document.body.appendChild(b);return "ready"})()';
// A bare delayed Promise (no `await` keyword) — exercises real async on all three
// engines without tripping headless's wrapForEvaluate IIFE-wrapping convention.
const ASYNC = 'new Promise(r=>setTimeout(()=>r("OK_"+(2+2)),40))';

const results = {};

// ── T1: navigate + read ──────────────────────────────────────────────────
function t1nc(engine) {
  rec.step('T1', ncRun(['goto', 'https://example.com'], { engine, timeoutMs: 45_000 }));
  const t = rec.step('T1', ncRun(['text'], { engine, timeoutMs: 30_000 }));
  return /Example Domain/i.test(t.stdout);
}
function t1kimi() {
  rec.step('T1', kimiCmd('navigate', { url: 'https://example.com', newTab: true }, { timeoutMs: 30_000 }));
  const t = rec.step('T1', kimiCmd('evaluate', { code: 'document.body.innerText' }, { timeoutMs: 20_000 }));
  return /Example Domain/i.test(String(t.data?.value ?? ''));
}

// ── T2: async JS must return the resolved value (A1 parity) ───────────────
function t2nc(engine) { return ncVal(rec.step('T2', ncRun(['js', ASYNC], { engine, timeoutMs: 30_000 }))).includes('OK_4'); }
function t2kimi() { return String(rec.step('T2', kimiCmd('evaluate', { code: ASYNC }, { timeoutMs: 20_000 })).data?.value ?? '').includes('OK_4'); }

// ── T3: trusted click → event.isTrusted (A2) ─────────────────────────────
function t3nc(engine) {
  rec.step('T3', ncRun(['goto', 'https://example.com'], { engine, timeoutMs: 45_000 }));
  rec.step('T3', ncRun(['js', INJECT], { engine, timeoutMs: 20_000 }));
  rec.step('T3', ncRun(['click', '#nctb'], { engine, timeoutMs: 30_000 }));
  return ncVal(rec.step('T3', ncRun(['js', 'String(window.__nctb)'], { engine, timeoutMs: 20_000 }))).includes('true');
}
function t3kimi() {
  rec.step('T3', kimiCmd('navigate', { url: 'https://example.com', newTab: false }, { timeoutMs: 30_000 }));
  rec.step('T3', kimiCmd('evaluate', { code: INJECT }, { timeoutMs: 20_000 }));
  rec.step('T3', kimiCmd('mouse_click', { selector: '#nctb' }, { timeoutMs: 20_000 })); // Kimi's trusted variant
  // Settle: Kimi's socket calls fire back-to-back with no natural delay (nc gets
  // one for free from per-command subprocess spawn); let the click event flush.
  rec.step('T3', kimiCmd('evaluate', { code: 'new Promise(r=>setTimeout(()=>r(1),150))' }, { timeoutMs: 20_000 }));
  return String(rec.step('T3', kimiCmd('evaluate', { code: 'String(window.__nctb)' }, { timeoutMs: 20_000 }).data?.value ?? '')) === 'true';
}

// ── T4: reliability — N navigate+read cycles, success rate + latency ──────
function t4nc(engine, n = 5) {
  let ok = 0; const lat = [];
  for (let i = 0; i < n; i++) {
    const g = rec.step('T4', ncRun(['goto', `https://example.com/?b=${i}`], { engine, timeoutMs: 45_000 }));
    const t = rec.step('T4', ncRun(['text'], { engine, timeoutMs: 30_000 }));
    if (g.ok && /Example Domain/i.test(t.stdout) && !g.reloginPrompt) ok++;
    lat.push(g.durationMs + t.durationMs);
  }
  return { ok, n, successRate: ok / n, medianMs: median(lat) };
}
function t4kimi(n = 5) {
  let ok = 0; const lat = [];
  for (let i = 0; i < n; i++) {
    const started = Date.now();
    const g = rec.step('T4', kimiCmd('navigate', { url: `https://example.com/?b=${i}`, newTab: false }, { timeoutMs: 30_000 }));
    const t = rec.step('T4', kimiCmd('evaluate', { code: 'document.body.innerText' }, { timeoutMs: 20_000 }));
    if (g.ok && !g.hung && /Example Domain/i.test(String(t.data?.value ?? ''))) ok++;
    lat.push(Date.now() - started);
  }
  return { ok, n, successRate: ok / n, medianMs: median(lat) };
}

// ── Run the matrix ───────────────────────────────────────────────────────
for (const engine of ['headless', 'real']) {
  results[`nc-${engine}`] = {
    T1_read: safe(() => t1nc(engine)),
    T2_asyncJS: safe(() => t2nc(engine)),
    T3_trustedClick: safe(() => t3nc(engine)),
    T4_reliability: safe(() => t4nc(engine)),
  };
}
results['kimi-chrome'] = {
  T1_read: safe(() => t1kimi()),
  T2_asyncJS: safe(() => t2kimi()),
  T3_trustedClick: safe(() => t3kimi()),
  T4_reliability: safe(() => t4kimi()),
};

function safe(fn) { try { return fn(); } catch (e) { return { error: String(e?.message ?? e) }; } }

rec.manifest({ phase: 'B', kind: 'capability+reliability', results });
rec.finalize();
console.log('PHASE_B_RESULTS', JSON.stringify(results, null, 2));
console.log('RUN_DIR', runDir);
