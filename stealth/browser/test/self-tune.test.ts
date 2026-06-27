/**
 * [INPUT]: Depends on self-tune.ts (multi-level resolve + tuning knobs) and the
 *          engine-journal record/profile types.
 * [OUTPUT]: Verifies the L1-domain / L2-site-type / L3-cold-start resolve fallback
 *           (with self-domain excluded from type aggregation) and the clamped knob
 *           selection (timeout from learned p95, viewport only for static+unpinned).
 * [POS]: A5 learned routing — the generalization payoff. Proves a domain with no
 *        history of its own inherits its site-TYPE's experience, and that the knobs
 *        stay inside safe clamps. Pure logic, no I/O.
 */

import { describe, test, expect } from 'bun:test';
import {
  resolveFrom,
  selfTune,
  type ResolveResult,
  type ResolveDeps,
} from '../src/self-tune';
import type { EngineDecisionRecord } from '../src/engine-journal';
import type { SiteProfile } from '../src/site-profile';

const OPEN: SiteProfile = { vendor: 'none', authKind: 'open', dynamism: 'static' };

function rec(over: Partial<EngineDecisionRecord>): EngineDecisionRecord {
  return {
    ts: 1, domain: 'a.com', engine: 'real', command: 'goto',
    ok: true, latencyMs: 700, profile: OPEN, ...over,
  };
}

// vendorOf that always reports unpinned, so every plain URL profiles as none|open|static.
const deps = (records: EngineDecisionRecord[]): ResolveDeps => ({ records, vendorOf: () => null });

describe('self-tune — multi-level resolve (the generalization)', () => {
  test('L1: a domain with enough of its OWN history resolves from the domain', () => {
    const records = Array.from({ length: 3 }, () => rec({ domain: 'a.com', engine: 'real', ok: true }));
    const r = resolveFrom('https://a.com', deps(records));
    expect(r.source).toBe('domain');
    expect(r.recommendation!.engine).toBe('real');
  });

  test('L2: a domain with NO history inherits its site-TYPE (3+ domains, 8+ samples)', () => {
    const records = [
      ...Array.from({ length: 3 }, () => rec({ domain: 'a.com', engine: 'real', ok: true })),
      ...Array.from({ length: 3 }, () => rec({ domain: 'b.com', engine: 'real', ok: true })),
      ...Array.from({ length: 3 }, () => rec({ domain: 'c.com', engine: 'real', ok: true })),
    ];
    const r = resolveFrom('https://never-seen.com', deps(records));
    expect(r.source).toBe('site-type');
    expect(r.recommendation!.engine).toBe('real');
  });

  test('L2 excludes the target domain itself from the type pool', () => {
    // Target a.com has 2 thin records (not learned). Only b.com + c.com share the
    // type. With a.com EXCLUDED that is 2 distinct domains (< 3) → falls to cold-start.
    const records = [
      ...Array.from({ length: 2 }, () => rec({ domain: 'a.com', engine: 'headless', ok: true })),
      ...Array.from({ length: 4 }, () => rec({ domain: 'b.com', engine: 'real', ok: true })),
      ...Array.from({ length: 4 }, () => rec({ domain: 'c.com', engine: 'real', ok: true })),
    ];
    const r = resolveFrom('https://a.com', deps(records));
    expect(r.source).toBe('cold-start'); // proves a.com's own records didn't pad the type to 3
  });

  test('L3: too few samples for the type → cold-start', () => {
    const records = [
      ...Array.from({ length: 2 }, () => rec({ domain: 'a.com', engine: 'real', ok: true })),
      ...Array.from({ length: 2 }, () => rec({ domain: 'b.com', engine: 'real', ok: true })),
      ...Array.from({ length: 2 }, () => rec({ domain: 'c.com', engine: 'real', ok: true })),
    ];
    const r = resolveFrom('https://never-seen.com', deps(records)); // 3 domains but only 6 samples
    expect(r.source).toBe('cold-start');
  });

  test('cold start with no history at all → cold-start, null recommendation', () => {
    const r = resolveFrom('https://fresh.com', deps([]));
    expect(r.source).toBe('cold-start');
    expect(r.recommendation).toBeNull();
  });
});

describe('self-tune — knob selection (clamped, conservative)', () => {
  function res(over: Partial<ResolveResult>): ResolveResult {
    return { recommendation: null, source: 'domain', profile: OPEN, winner: null, ...over };
  }
  const winner = (latencyP95Ms: number) => ({
    engine: 'real' as const, attempts: 5, oks: 5, successRate: 1,
    medianLatencyMs: 0, timeouts: 0, relogins: 0, metrics: { latencyP95Ms },
  });

  test('timeout budget = learned p95 x1.5, clamped to [10s, 90s]', () => {
    expect(selfTune(res({ winner: winner(12000) })).timeoutBudgetMs).toBe(18000);
    expect(selfTune(res({ winner: winner(80000) })).timeoutBudgetMs).toBe(90000); // 120s → capped
    expect(selfTune(res({ winner: winner(1000) })).timeoutBudgetMs).toBe(10000); // 1.5s → floored
  });

  test('no learned latency → the default timeout', () => {
    expect(selfTune(res({ winner: null })).timeoutBudgetMs).toBe(30000);
  });

  test('viewport shrinks only for a static, UNPINNED site', () => {
    expect(selfTune(res({ profile: { vendor: 'none', authKind: 'open', dynamism: 'static' } })).viewport)
      .toEqual({ width: 1280, height: 720 });
    // pinned site → keep full viewport (it's a fingerprint surface)
    expect(selfTune(res({ profile: { vendor: 'cloudflare', authKind: 'open', dynamism: 'static' } })).viewport)
      .toEqual({ width: 1920, height: 1080 });
    // heavy SPA → keep full viewport (needs the room to render)
    expect(selfTune(res({ profile: { vendor: 'none', authKind: 'open', dynamism: 'heavy-spa' } })).viewport)
      .toEqual({ width: 1920, height: 1080 });
  });

  test('idle shutdown stays inside [5min, 60min]', () => {
    const idle = selfTune(res({})).idleShutdownMs;
    expect(idle).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(idle).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  test('carries the resolve source through to the advice', () => {
    expect(selfTune(res({ source: 'site-type' })).source).toBe('site-type');
  });
});
