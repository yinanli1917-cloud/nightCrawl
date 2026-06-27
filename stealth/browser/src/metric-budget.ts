/**
 * [INPUT]: Pure module — no runtime imports. Consumed by engine-journal.ts
 *          (recommendFromStats scoring) and the offline benchmark scorer.
 * [OUTPUT]: Exports Direction, MetricSpec, MetricVector, Normalized, BUDGETS,
 *           normalize, score.
 * [POS]: A5 learned routing — the SINGLE SOURCE OF TRUTH for the metric vocabulary
 *        and the best-practice budgets. Both the online router and the offline
 *        benchmark score against the SAME budgets, so the number the benchmark
 *        publishes per engine is the number the router optimizes. Seed budgets live
 *        here; budget refinement (a later slice) tunes them per site type.
 *
 * Why budgets instead of a lexicographic sort: "did it load" is one axis. The real
 * cost of an engine is multi-dimensional — speed, CPU, memory, focus-theft, tab
 * leak, banner noise, correctness — and a digital twin that hijacks the user's
 * browser to load 5% faster is a worse twin. Scoring every outcome against an
 * explicit budget per axis is how the loop optimizes the things that actually matter,
 * not just success rate.
 */

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
