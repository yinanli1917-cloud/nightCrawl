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
  journalPath,
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
    for (let i = 0; i < 4; i++) recordDecision(rec({ domain: 'spa.example', engine: 'real', ok: true, latencyMs: 700 }));
    for (let i = 0; i < 4; i++) recordDecision(rec({ domain: 'spa.example', engine: 'headless', ok: false, axTimedOut: true, latencyMs: 5050 }));
    const r = recommendForDomain('spa.example');
    expect(r!.engine).toBe('real');
    expect(r!.confidence).toBe('learned');
  });

  test('write is atomic-friendly — journal exists, no leftover .tmp', () => {
    recordDecision(rec({ domain: 'x.example' }));
    expect(fs.existsSync(journalPath())).toBe(true);
    expect(fs.existsSync(journalPath() + '.tmp')).toBe(false);
  });
});
