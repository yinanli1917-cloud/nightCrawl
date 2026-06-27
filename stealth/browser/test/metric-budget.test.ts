/**
 * [INPUT]: Depends on metric-budget.ts (the single source of truth for metric
 *          definitions + best-practice budgets + scoring).
 * [OUTPUT]: Verifies normalize (ratio vs budget, hard gates, N/A), and score
 *           (weighted mean over PRESENT metrics, hard-gate disqualification,
 *           missing-never-zero, better-on-more-budgets wins).
 * [POS]: A5 learned routing. Proves the budget vocabulary the online router and the
 *        offline benchmark both score against. Pure logic, no I/O.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the per-type budget store into a temp stateDir (same as engine-journal).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-budget-'));
process.env.BROWSE_STATE_FILE = path.join(TMP, 'state', 'browse.json');
fs.mkdirSync(path.dirname(process.env.BROWSE_STATE_FILE), { recursive: true });

import {
  BUDGETS,
  normalize,
  score,
  refineBudget,
  budgetsFor,
  saveRefinedBudget,
  isReloginViolation,
  isHeadedPopViolation,
  isVerifyOk,
  type MetricSpec,
  type MetricVector,
} from '../src/metric-budget';

function spec(key: string): MetricSpec {
  const s = BUDGETS.find((b) => b.key === key);
  if (!s) throw new Error(`no budget for ${key}`);
  return s;
}

describe('metric-budget — normalize (ratio vs budget)', () => {
  test('a lower-better metric exactly at budget normalizes to 1.0', () => {
    const n = normalize(8000, spec('latencyP95Ms'));
    expect(n).toEqual({ kind: 'soft', ratio: 1 });
  });

  test('a lower-better metric under budget rewards above 1.0, capped at 1.25', () => {
    const n = normalize(4000, spec('latencyP95Ms')); // 8000/4000 = 2 → capped
    expect(n.kind).toBe('soft');
    if (n.kind === 'soft') expect(n.ratio).toBe(1.25);
  });

  test('a zero-target metric (focusStolen) scores perfect at 0, ~0 when violated', () => {
    const perfect = normalize(0, spec('focusStolenRate'));
    const violated = normalize(1, spec('focusStolenRate'));
    expect(perfect.kind).toBe('soft');
    if (perfect.kind === 'soft') expect(perfect.ratio).toBeCloseTo(1, 5);
    expect(violated.kind).toBe('soft');
    if (violated.kind === 'soft') expect(violated.ratio).toBeLessThan(0.01);
  });

  test('a higher-better metric above budget rewards above 1.0', () => {
    const n = normalize(1.0, spec('successRate')); // 1.0 / 0.95 ≈ 1.0526
    expect(n.kind).toBe('soft');
    if (n.kind === 'soft') expect(n.ratio).toBeGreaterThan(1);
  });

  test('a missing value is N/A (excluded), not a zero score', () => {
    expect(normalize(undefined, spec('cpuPctMean'))).toEqual({ kind: 'na' });
  });

  test('a hard gate met passes, unmet fails', () => {
    expect(normalize(1, spec('completionUnderPolicy'))).toEqual({ kind: 'pass' });
    expect(normalize(0, spec('completionUnderPolicy'))).toEqual({ kind: 'fail' });
  });
});

describe('metric-budget — score (weighted, budget-normalized)', () => {
  test('a violated hard gate disqualifies the whole config (-Infinity)', () => {
    const v: MetricVector = { successRate: 1.0, latencyP95Ms: 1000, completionUnderPolicy: 0 };
    expect(score(v)).toBe(-Infinity);
  });

  test('a config with only one present metric still scores > 0 (N/A by design)', () => {
    // Everything else missing → excluded; the one present metric carries the score.
    expect(score({ successRate: 1.0 })).toBeGreaterThan(0);
  });

  test('better-on-more-budgets wins', () => {
    const good: MetricVector = { successRate: 1.0, latencyP95Ms: 4000, focusStolenRate: 0 };
    const bad: MetricVector = { successRate: 1.0, latencyP95Ms: 16000, focusStolenRate: 1 };
    expect(score(good)).toBeGreaterThan(score(bad));
  });

  test('an all-missing vector scores 0, never throws', () => {
    expect(score({})).toBe(0);
  });

  test('passing the hard gate does not by itself inflate the score', () => {
    // completionUnderPolicy has weight 0 — it gates, it does not reward.
    const withGate: MetricVector = { successRate: 1.0, completionUnderPolicy: 1 };
    const withoutGate: MetricVector = { successRate: 1.0 };
    expect(score(withGate)).toBeCloseTo(score(withoutGate), 10);
  });
});

describe('metric-budget — refineBudget (seed, then refine from data)', () => {
  function spec(key: string): MetricSpec {
    return BUDGETS.find((b) => b.key === key)!;
  }

  test('a lower-better budget tightens toward a better observed p95', () => {
    const r = refineBudget(spec('latencyP95Ms'), { p50: 3000, p95: 4000, worseStreak: 0 });
    expect(r.budget).toBe(7200); // ema(8000, 4000, 0.2)
  });

  test('a single worse run does NOT loosen the budget (anti-loosening guard)', () => {
    const r = refineBudget(spec('latencyP95Ms'), { p50: 9000, p95: 12000, worseStreak: 0 });
    expect(r.budget).toBe(8000); // held
  });

  test('only sustained regression loosens, capped at seed x1.25', () => {
    const r = refineBudget(spec('latencyP95Ms'), { p50: 40000, p95: 50000, worseStreak: 50 });
    expect(r.budget).toBe(10000); // min(ema(8000,50000,0.05)=10100, 8000*1.25=10000)
  });

  test('a higher-better budget tightens toward a better observed p50', () => {
    const r = refineBudget(spec('successRate'), { p50: 0.99, p95: 1.0, worseStreak: 0 });
    expect(r.budget).toBeCloseTo(0.958, 3); // ema(0.95, 0.99, 0.2)
  });

  test('a hard gate never refines', () => {
    const r = refineBudget(spec('completionUnderPolicy'), { p50: 0, p95: 0, worseStreak: 999 });
    expect(r.budget).toBe(1.0);
  });
});

describe('metric-budget — per-type budget persistence', () => {
  test('refined budgets persist per site-type and merge onto the seeds', () => {
    saveRefinedBudget('cloudflare|sso|static', 'latencyP95Ms', 6000);
    const specs = budgetsFor('cloudflare|sso|static');
    expect(specs.find((s) => s.key === 'latencyP95Ms')!.budget).toBe(6000);
    expect(specs.find((s) => s.key === 'successRate')!.budget).toBe(0.95); // untouched axis = seed
    // a different site-type is unaffected by another type's refinement
    expect(budgetsFor('none|open|static').find((s) => s.key === 'latencyP95Ms')!.budget).toBe(8000);
  });

  test('an unknown site-type returns the seed budgets unchanged', () => {
    expect(budgetsFor('datadome|login-wall|heavy-spa')).toEqual(BUDGETS);
  });
});

describe('metric-budget — policy predicates (one vocabulary with the benchmark guards)', () => {
  test('re-login / consent / 2FA walls are violations; a healthy dashboard is not', () => {
    expect(isReloginViolation('LOGIN_REQUIRED: canvas.uw.edu needs sign-in')).toBe(true);
    expect(isReloginViolation('CONSENT_REQUIRED: lib.uw.edu')).toBe(true);
    expect(isReloginViolation('Duo two-factor authentication required')).toBe(true);
    expect(isReloginViolation('Dashboard\nSigned in as Yinan Li\nCourses')).toBe(false);
    expect(isReloginViolation('')).toBe(false);
  });

  test('a headed-window pop is a violation; a normal headless nav is not', () => {
    expect(isHeadedPopViolation('[handoff] launchHeaded -> opening CloakBrowser')).toBe(true);
    expect(isHeadedPopViolation('routing to open-handoff for sensitive page')).toBe(true);
    expect(isHeadedPopViolation('Navigated to https://example.com (200)')).toBe(false);
  });

  test('VERIFY_OK gates a deliverable; VERIFY_FAILED and garbage do not', () => {
    expect(isVerifyOk('VERIFY_OK\nkind: publisher-pdf\npages: 12')).toBe(true);
    expect(isVerifyOk('VERIFY_FAILED\n  min-pages: 1 < 3')).toBe(false);
    expect(isVerifyOk('some unrelated stdout')).toBe(false);
  });
});
