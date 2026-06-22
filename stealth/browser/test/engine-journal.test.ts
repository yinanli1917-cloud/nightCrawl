/**
 * [INPUT]: Depends on engine-journal.ts (decision journal + learned routing).
 * [OUTPUT]: Verifies append/read round-trip, malformed-line resilience, per-engine
 *           aggregation, and that recommendations are DERIVED from history (not a
 *           preset rule) — including cold-start (no history → null) and confidence.
 * [POS]: A5 learned-routing test. The journal is the substrate the router learns
 *        from; this proves the learning, not a hardcoded table. Pure logic + I/O.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the journal into a temp stateDir (same mechanism as domain-strategy).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-journal-'));
process.env.BROWSE_STATE_FILE = path.join(TMP, 'state', 'browse.json');
fs.mkdirSync(path.dirname(process.env.BROWSE_STATE_FILE), { recursive: true });

import {
  recordDecision,
  readDecisions,
  aggregateByEngine,
  recommendFromStats,
  recommendForDomain,
  filterRecent,
  adviceRegret,
  formatEngineStats,
  journalPath,
  RECENCY_WINDOW_MS,
  type EngineDecisionRecord,
} from '../src/engine-journal';

function rec(over: Partial<EngineDecisionRecord>): EngineDecisionRecord {
  return {
    ts: 1, domain: 'example.com', engine: 'headless', command: 'goto',
    ok: true, latencyMs: 500, ...over,
  };
}

function clearJournal() {
  try { fs.unlinkSync(journalPath()); } catch {}
}

describe('engine-journal — aggregation (pure)', () => {
  test('groups by engine and computes success rate + timeout counts', () => {
    const records = [
      rec({ engine: 'real', ok: true, latencyMs: 800 }),
      rec({ engine: 'real', ok: true, latencyMs: 900 }),
      rec({ engine: 'headless', ok: false, axTimedOut: true, latencyMs: 5050 }),
      rec({ engine: 'headless', ok: true, latencyMs: 1200 }),
    ];
    const stats = aggregateByEngine(records);
    const real = stats.find((s) => s.engine === 'real')!;
    const headless = stats.find((s) => s.engine === 'headless')!;
    expect(real.attempts).toBe(2);
    expect(real.oks).toBe(2);
    expect(real.successRate).toBe(1);
    expect(headless.attempts).toBe(2);
    expect(headless.oks).toBe(1);
    expect(headless.successRate).toBe(0.5);
    expect(headless.timeouts).toBe(1);
  });
});

describe('engine-journal — recommendation is LEARNED from history', () => {
  test('clear winner: real 5/5 vs headless 2/6 → recommend real (learned)', () => {
    const records = [
      ...Array.from({ length: 5 }, () => rec({ engine: 'real', ok: true, latencyMs: 800 })),
      ...Array.from({ length: 2 }, () => rec({ engine: 'headless', ok: true, latencyMs: 1500 })),
      ...Array.from({ length: 4 }, () => rec({ engine: 'headless', ok: false, axTimedOut: true, latencyMs: 5050 })),
    ];
    const r = recommendFromStats(aggregateByEngine(records));
    expect(r).not.toBeNull();
    expect(r!.engine).toBe('real');
    expect(r!.confidence).toBe('learned');
    expect(r!.evidence).toContain('real');
    expect(r!.evidence).toContain('headless');
  });

  test('similar success → tie-break on lower latency', () => {
    const records = [
      ...Array.from({ length: 3 }, () => rec({ engine: 'real', ok: true, latencyMs: 500 })),
      ...Array.from({ length: 3 }, () => rec({ engine: 'headless', ok: true, latencyMs: 2500 })),
    ];
    const r = recommendFromStats(aggregateByEngine(records));
    expect(r!.engine).toBe('real');
  });

  test('thin history (1 sample) → recommends but confidence is thin', () => {
    const r = recommendFromStats(aggregateByEngine([rec({ engine: 'real', ok: true })]));
    expect(r!.engine).toBe('real');
    expect(r!.confidence).toBe('thin');
  });

  test('cold start: no history → null (caller falls back to a prior)', () => {
    expect(recommendFromStats(aggregateByEngine([]))).toBeNull();
  });
});

describe('engine-journal — recency window (gap #7: stale data must not poison)', () => {
  test('filterRecent drops records older than the window, keeps fresh ones', () => {
    const now = 1_000_000_000_000;
    const fresh = rec({ ts: now - 1000, engine: 'real', ok: true });
    const stale = rec({ ts: now - RECENCY_WINDOW_MS - 1, engine: 'headless', ok: false });
    const kept = filterRecent([fresh, stale], now);
    expect(kept).toContain(fresh);
    expect(kept).not.toContain(stale);
  });

  test('a record with no usable ts is kept (never silently lose older-schema data)', () => {
    const now = 1_000_000_000_000;
    const noTs = rec({ ts: undefined as any, engine: 'real' });
    expect(filterRecent([noTs], now)).toContain(noTs);
  });

  test('a months-old FAILURE no longer drags down a domain that recovered this week', () => {
    clearJournal();
    const now = 2_000_000_000_000;
    // Last month: real failed 4x (a wall that has since been fixed).
    for (let i = 0; i < 4; i++) recordDecision(rec({ domain: 'recovered.example', ts: now - RECENCY_WINDOW_MS - 1, engine: 'real', ok: false }));
    // This week: real succeeds 3x.
    for (let i = 0; i < 3; i++) recordDecision(rec({ domain: 'recovered.example', ts: now - 1000, engine: 'real', ok: true }));
    const r = recommendForDomain('recovered.example', process.env, now);
    expect(r!.engine).toBe('real');
    expect(r!.confidence).toBe('learned');
    // Evidence reflects only the recent window (3/3), not 3/7.
    expect(r!.evidence).toContain('3/3');
  });
});

describe('engine-journal — exploration (gap #6: discover an untried engine)', () => {
  test('one engine has history, the other has ZERO → recommendation flags it untried', () => {
    const r = recommendFromStats(aggregateByEngine([
      rec({ engine: 'headless', ok: true }),
      rec({ engine: 'headless', ok: true }),
      rec({ engine: 'headless', ok: true }),
    ]));
    expect(r!.engine).toBe('headless');
    expect(r!.untried).toBe('real'); // real never ran here — nudge to compare
  });

  test('both engines have history → nothing untried', () => {
    const r = recommendFromStats(aggregateByEngine([
      rec({ engine: 'headless', ok: true }),
      rec({ engine: 'real', ok: true }),
    ]));
    expect(r!.untried).toBeUndefined();
  });

  test('recommendation carries the winning sample count (for honest thin/learned prose)', () => {
    const r = recommendFromStats(aggregateByEngine([rec({ engine: 'real', ok: true })]));
    expect(r!.samples).toBe(1);
  });
});

describe('engine-journal — reflection (gap #9: was our own advice good?)', () => {
  test('adviceRegret splits outcomes by followed vs overridden recommendation', () => {
    const records = [
      // Followed the advice (chose what was recommended) → mostly succeeded.
      rec({ engine: 'real', recommended: 'real', ok: true }),
      rec({ engine: 'real', recommended: 'real', ok: true }),
      rec({ engine: 'real', recommended: 'real', ok: false }),
      // Overrode the advice (chose the other engine) → mostly failed.
      rec({ engine: 'headless', recommended: 'real', ok: false }),
      rec({ engine: 'headless', recommended: 'real', ok: false }),
      // No recommendation captured → ignored by the regret metric.
      rec({ engine: 'headless', ok: true }),
    ];
    const regret = adviceRegret(records);
    expect(regret.followed.attempts).toBe(3);
    expect(regret.followed.oks).toBe(2);
    expect(regret.overridden.attempts).toBe(2);
    expect(regret.overridden.oks).toBe(0);
    // Following the advice did better here.
    expect(regret.followed.successRate).toBeGreaterThan(regret.overridden.successRate);
  });

  test('records without a captured recommendation contribute to neither bucket', () => {
    const regret = adviceRegret([rec({ engine: 'real', ok: true })]);
    expect(regret.followed.attempts).toBe(0);
    expect(regret.overridden.attempts).toBe(0);
  });
});

describe('engine-journal — reflection view (engine-stats)', () => {
  const now = 1_700_000_000_000;
  const records: EngineDecisionRecord[] = [
    // uw.edu: real wins, and following the advice did better than overriding.
    rec({ ts: now - 1000, domain: 'uw.edu', engine: 'real', ok: true, recommended: 'real' }),
    rec({ ts: now - 1000, domain: 'uw.edu', engine: 'real', ok: true, recommended: 'real' }),
    rec({ ts: now - 1000, domain: 'uw.edu', engine: 'real', ok: true, recommended: 'real' }),
    rec({ ts: now - 1000, domain: 'uw.edu', engine: 'headless', ok: false, recommended: 'real' }),
    // example.com: only headless ever tried.
    rec({ ts: now - 1000, domain: 'example.com', engine: 'headless', ok: true }),
    rec({ ts: now - 1000, domain: 'example.com', engine: 'headless', ok: true }),
    rec({ ts: now - 1000, domain: 'example.com', engine: 'headless', ok: true }),
  ];

  test('summarizes per-domain recommendation + the advice-followed/overridden split', () => {
    const out = formatEngineStats(records, now);
    expect(out).toContain('uw.edu');
    expect(out).toContain('recommended: real (learned)');
    expect(out).toContain('example.com');
    // The reflection line shows whether following advice helped.
    expect(out.toLowerCase()).toContain('followed');
    expect(out.toLowerCase()).toContain('overridden');
    // example.com's untried alternative is surfaced.
    expect(out.toLowerCase()).toContain('untried');
  });

  test('a domain filter narrows the view to one site', () => {
    const out = formatEngineStats(records, now, 'uw.edu');
    expect(out).toContain('uw.edu');
    expect(out).not.toContain('example.com');
  });

  test('empty journal yields a friendly no-data message, not a crash', () => {
    expect(formatEngineStats([], now).toLowerCase()).toContain('no');
  });

  test('stale records are excluded from the view', () => {
    const stale = [rec({ ts: now - RECENCY_WINDOW_MS - 1, domain: 'ancient.example', engine: 'real', ok: true })];
    expect(formatEngineStats(stale, now)).not.toContain('ancient.example');
  });
});

describe('engine-journal — persistence (I/O)', () => {
  beforeEach(clearJournal);

  test('append then read round-trips records for a domain', () => {
    recordDecision(rec({ domain: 'uw.edu', engine: 'real', ok: true }));
    recordDecision(rec({ domain: 'uw.edu', engine: 'headless', ok: false }));
    recordDecision(rec({ domain: 'other.com', engine: 'real', ok: true }));
    expect(readDecisions('uw.edu').length).toBe(2);
    expect(readDecisions().length).toBe(3);
  });

  test('malformed lines are skipped, not thrown', () => {
    recordDecision(rec({ domain: 'uw.edu' }));
    fs.appendFileSync(journalPath(), 'not json\n{ also bad\n');
    recordDecision(rec({ domain: 'uw.edu' }));
    expect(readDecisions('uw.edu').length).toBe(2);
  });

  test('missing journal reads as empty (no throw)', () => {
    clearJournal();
    expect(readDecisions('never.seen')).toEqual([]);
  });

  test('recommendForDomain learns from the persisted journal', () => {
    clearJournal();
    const now = 1_700_000_000_000; // fixed "now" so recent records stay inside the window
    for (let i = 0; i < 4; i++) recordDecision(rec({ ts: now - 1000, domain: 'spa.example', engine: 'real', ok: true, latencyMs: 700 }));
    for (let i = 0; i < 4; i++) recordDecision(rec({ ts: now - 1000, domain: 'spa.example', engine: 'headless', ok: false, axTimedOut: true, latencyMs: 5050 }));
    const r = recommendForDomain('spa.example', process.env, now);
    expect(r!.engine).toBe('real');
    expect(r!.confidence).toBe('learned');
  });

  test('write is atomic-friendly — journal exists, no leftover .tmp', () => {
    recordDecision(rec({ domain: 'x.example' }));
    expect(fs.existsSync(journalPath())).toBe(true);
    expect(fs.existsSync(journalPath() + '.tmp')).toBe(false);
  });
});
