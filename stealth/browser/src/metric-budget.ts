/**
 * [INPUT]: Depends on config.resolveConfig (stateDir) for the per-type budget store.
 *          Pure scoring core has no other imports. Consumed by engine-journal.ts
 *          (recommendFromStats scoring), self-tune, the server policy gate, and the
 *          offline benchmark scorer (artifacts/.../lib/guards.mjs re-exports the
 *          policy predicates from here).
 * [OUTPUT]: Exports Direction, MetricSpec, MetricVector, Normalized, BUDGETS,
 *           normalize, score, BudgetObservation, refineBudget, budgetsFor,
 *           saveRefinedBudget, isReloginViolation, isHeadedPopViolation, isVerifyOk.
 * [POS]: A5 learned routing — the SINGLE SOURCE OF TRUTH for the metric vocabulary,
 *        the best-practice budgets, and the policy gates. Both the online router and
 *        the offline benchmark score and gate against the SAME definitions, so the
 *        number the benchmark publishes per engine is the number the router optimizes
 *        — no vocabulary drift. Seed budgets live here; refineBudget tunes them per
 *        site type (tighten freely, loosen only on sustained regression, capped).
 *
 * Why budgets instead of a lexicographic sort: "did it load" is one axis. The real
 * cost of an engine is multi-dimensional — speed, CPU, memory, focus-theft, tab
 * leak, banner noise, correctness — and a digital twin that hijacks the user's
 * browser to load 5% faster is a worse twin. Scoring every outcome against an
 * explicit budget per axis is how the loop optimizes the things that actually matter,
 * not just success rate.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveConfig } from './config';

export type Direction = 'lower-better' | 'higher-better';

export interface MetricSpec {
  key: string;
  direction: Direction;
  budget: number;
  weight: number;
  hard?: boolean; // a gate: violation disqualifies the whole config (never a score)
}

/** Observed value per metric key. A missing key is N/A by design — never scored 0. */
export type MetricVector = Record<string, number | undefined>;

/** Result of normalizing one metric against its spec. */
export type Normalized =
  | { kind: 'soft'; ratio: number } // soft metric, budget-relative reward in [0, MAX_RATIO]
  | { kind: 'pass' }                // hard gate satisfied
  | { kind: 'fail' }                // hard gate violated → disqualifies the config
  | { kind: 'na' };                 // metric absent → excluded from the weighted mean

// ─── Tuning constants ──────────────────────────────────────
// Reward is capped so one stellar axis can't mask a budget blown elsewhere. EPS lets
// a zero-target budget (focus-theft must be 0) normalize cleanly: value 0 → ratio 1,
// any violation → ratio ~0, without a divide-by-zero special case.
const MAX_RATIO = 1.25;
const EPS = 1e-9;

// ─── Seed budgets (best-practice SLOs) ─────────────────────
// Grounded in the real Gmail run (≈468 MB RSS, ~333 banners over ~980 calls) and the
// benchmark families (speed p95, CPU, correctness, focus, tab cleanup,
// completion-under-policy). These are the FLOOR; per-site-type refinement may tighten
// them, and may only loosen slowly + capped (a bad run can't destroy the seed SLO).
export const BUDGETS: MetricSpec[] = [
  { key: 'successRate', direction: 'higher-better', budget: 0.95, weight: 3 },
  { key: 'latencyP95Ms', direction: 'lower-better', budget: 8000, weight: 2 }, // navMs only, not recoveryMs
  { key: 'cpuPctMean', direction: 'lower-better', budget: 60, weight: 1 },
  { key: 'rssMbPeak', direction: 'lower-better', budget: 600, weight: 1 },
  { key: 'verifyOkRate', direction: 'higher-better', budget: 0.9, weight: 2 },
  { key: 'focusStolenRate', direction: 'lower-better', budget: 0, weight: 2 },
  { key: 'tabLeakRate', direction: 'lower-better', budget: 0, weight: 1 },
  { key: 'bannerNoiseRate', direction: 'lower-better', budget: 0.34, weight: 1 },
  { key: 'completionUnderPolicy', direction: 'higher-better', budget: 1.0, weight: 0, hard: true },
];

// ─── Normalization (pure) ──────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Normalize one observed value against its spec. A hard spec is a PASS/FAIL gate; a
 * soft spec becomes a budget-relative ratio (1.0 == exactly at budget, >1 == better,
 * capped); a missing value is N/A. Pure and total — never throws.
 */
export function normalize(value: number | undefined, spec: MetricSpec): Normalized {
  if (value === undefined || Number.isNaN(value)) return { kind: 'na' };
  if (spec.hard) {
    const meets = spec.direction === 'higher-better' ? value >= spec.budget : value <= spec.budget;
    return meets ? { kind: 'pass' } : { kind: 'fail' };
  }
  const ratio =
    spec.direction === 'lower-better'
      ? (spec.budget + EPS) / (value + EPS)
      : (value + EPS) / (spec.budget + EPS);
  return { kind: 'soft', ratio: clamp(ratio, 0, MAX_RATIO) };
}

// ─── Scoring (pure) ────────────────────────────────────────

/**
 * Score a metric vector against the budgets. A violated hard gate disqualifies the
 * whole config (-Infinity) — a config that completes by tripping a safety gate can
 * never win, mirroring the benchmark's Completion-under-Policy. Soft metrics are a
 * weighted mean over only the PRESENT axes, so a config measured on fewer dimensions
 * is N/A there, never penalized to 0. An all-missing vector scores 0. Pure.
 */
export function score(vector: MetricVector, specs: MetricSpec[] = BUDGETS): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const spec of specs) {
    const n = normalize(vector[spec.key], spec);
    if (n.kind === 'fail') return -Infinity;
    if (n.kind !== 'soft') continue; // 'pass' gates only; 'na' is excluded
    weighted += n.ratio * spec.weight;
    totalWeight += spec.weight;
  }
  return totalWeight === 0 ? 0 : weighted / totalWeight;
}

// ─── Refinement (seed, then refine from data) ──────────────
// A budget may TIGHTEN freely toward better observed reality, but may LOOSEN only
// after a sustained run of worse outcomes, and never past seed x1.25 (lower-better)
// / seed /1.25 (higher-better). So a single bad day can't permanently destroy an SLO,
// and a hard gate is never relaxed at all.
const REFINE_ALPHA = 0.2;
const LOOSEN_ALPHA = 0.05;
const REGRESSION_WINDOW = 50;
const LOOSEN_CAP_RATIO = 1.25;

export interface BudgetObservation {
  p50: number;
  p95: number;
  worseStreak: number; // consecutive refinement windows observed worse than the budget
}

function ema(current: number, target: number, alpha: number): number {
  return current + alpha * (target - current);
}

/** Refine one budget from observed percentiles. Pure. seedBudget is the floor ref. */
export function refineBudget(
  spec: MetricSpec,
  obs: BudgetObservation,
  seedBudget: number = spec.budget,
): MetricSpec {
  if (spec.hard) return spec;
  const lower = spec.direction === 'lower-better';
  const target = lower ? obs.p95 : obs.p50;
  const tighter = lower ? target < spec.budget : target > spec.budget;
  let budget = spec.budget;
  if (tighter) {
    budget = ema(spec.budget, target, REFINE_ALPHA);
  } else if (obs.worseStreak >= REGRESSION_WINDOW) {
    const eased = ema(spec.budget, target, LOOSEN_ALPHA);
    const cap = lower ? seedBudget * LOOSEN_CAP_RATIO : seedBudget / LOOSEN_CAP_RATIO;
    budget = lower ? Math.min(eased, cap) : Math.max(eased, cap);
  }
  return { ...spec, budget };
}

// ─── Per-site-type budget persistence ──────────────────────

interface BudgetStore {
  version: number;
  perType: Record<string, Record<string, number>>; // profileKey -> metricKey -> budget
}

function budgetsPath(env: Record<string, string | undefined>): string {
  return path.join(resolveConfig(env).stateDir, 'metric-budgets.json');
}

function readStore(env: Record<string, string | undefined>): BudgetStore {
  try {
    const raw = JSON.parse(fs.readFileSync(budgetsPath(env), 'utf-8'));
    if (raw && typeof raw === 'object' && raw.perType) return raw as BudgetStore;
  } catch {}
  return { version: 1, perType: {} };
}

/** Seed budgets with this site-type's refined overrides merged on. Never throws. */
export function budgetsFor(
  profileKey: string,
  env: Record<string, string | undefined> = process.env,
): MetricSpec[] {
  const overrides = readStore(env).perType[profileKey] ?? {};
  return BUDGETS.map((s) => (overrides[s.key] !== undefined ? { ...s, budget: overrides[s.key] } : s));
}

/** Persist one refined budget for a site type. Best-effort, atomic, never throws. */
export function saveRefinedBudget(
  profileKey: string,
  key: string,
  budget: number,
  env: Record<string, string | undefined> = process.env,
): void {
  try {
    const store = readStore(env);
    (store.perType[profileKey] ??= {})[key] = budget;
    const dest = budgetsPath(env);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch {}
}

// ─── Policy gates (shared with the benchmark harness) ──────
// The benchmark's hard rules and the online router's Completion-under-Policy gate are
// ONE vocabulary. guards.mjs re-exports these so a task that completes by tripping a
// gate counts as a failure in both places identically.
const RELOGIN_RE = new RegExp(
  [
    'LOGIN_REQUIRED',
    'CONSENT_REQUIRED',
    'AUTH_REQUIRED',
    'sign in to',
    'sign in with',
    'please sign in',
    'log in to',
    'please log in',
    'enter your (net\\s?id|password|credentials)',
    'two-factor',
    'two factor',
    '\\bDuo\\b',
    'verify your identity',
  ].join('|'),
  'i',
);

const HEADED_RE = /launchHeaded|open-handoff|headed Chromium|opening headed|launchCloakBrowser\b.*headed/i;

/** A re-login / consent / 2FA wall — the engine failed to leverage the live session. */
export function isReloginViolation(out?: string | null): boolean {
  return !!out && RELOGIN_RE.test(String(out));
}

/** An unexpected headed-window pop during a headless run — a boundary violation. */
export function isHeadedPopViolation(out?: string | null): boolean {
  return !!out && HEADED_RE.test(String(out));
}

/** A deliverable passed verification: the OK token present AND the failure token absent. */
export function isVerifyOk(out?: string | null): boolean {
  if (!out) return false;
  const s = String(out);
  return s.includes('VERIFY_OK') && !s.includes('VERIFY_FAILED');
}
