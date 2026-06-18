#!/usr/bin/env bun
/**
 * Phase 0 — connection smoke + go/no-go matrix for the three runners.
 * Validates the harness plumbing (runners.mjs + recorder.mjs) against the
 * LIVE engines before any real task runs. Writes a real artifact directory.
 */
import { ncRun, kimiCmd, kimiHealth } from './lib/runners.mjs';
import { Recorder, makeRunDir } from './lib/recorder.mjs';

const { runDir, stamp } = makeRunDir();
const rec = new Recorder(runDir, stamp);
const matrix = {};

// ── nightcrawl headless ──────────────────────────────────────────────────
const hGoto = rec.step('phase0', ncRun(['goto', 'https://example.com'], { engine: 'headless' }));
const hText = rec.step('phase0', ncRun(['text'], { engine: 'headless' }));
matrix.headless = hGoto.ok && /Example Domain/i.test(hText.stdout) && !hGoto.headedPop;

// ── nightcrawl Engine R (live Arc) ───────────────────────────────────────
const rGoto = rec.step('phase0', ncRun(['goto', 'https://example.com'], { engine: 'real', timeoutMs: 45_000 }));
const rText = rec.step('phase0', ncRun(['text'], { engine: 'real', timeoutMs: 30_000 }));
matrix.engineR = /real-browser/i.test(rGoto.stdout + rText.stdout) && /Example Domain/i.test(rText.stdout);

// ── Kimi WebBridge ───────────────────────────────────────────────────────
const kh = kimiHealth();
const kList = rec.step('phase0', kimiCmd('list_tabs', {}, { session: 'phase0', timeoutMs: 12_000 }));
const kNav = rec.step('phase0', kimiCmd('navigate', { url: 'https://example.com', newTab: true }, { session: 'phase0', timeoutMs: 30_000 }));
matrix.kimi = {
  daemon: !!(kh && kh.running),
  extension: !!(kh && kh.extension_connected),
  extensionVersion: kh?.extension_version,
  daemonVersion: kh?.version,
  listTabsOk: kList.ok,
  navigateOk: kNav.ok && !kNav.hung,
  navigateHung: kNav.hung,
};

rec.manifest({ phase: 0, matrix, kimiHealth: kh });
rec.finalize();

console.log('PHASE0_MATRIX', JSON.stringify(matrix, null, 2));
console.log('RUN_DIR', runDir);
