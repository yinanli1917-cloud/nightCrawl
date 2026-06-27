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
import {
  BUDGETS,
  normalize,
  score,
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
