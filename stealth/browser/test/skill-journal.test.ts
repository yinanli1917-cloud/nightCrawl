/**
 * [INPUT]: Depends on skill-journal.ts (the learned-skill journal, mirrors engine-journal).
 * [OUTPUT]: Verifies append/read round-trip + filter, malformed resilience, recency,
 *           aggregation by (goal|site-type, method, shape), and budget-scored recommend.
 * [POS]: Skill-library learned tier. Records which METHOD worked for a (task, site) so
 *        the router can reuse the best one. Pure logic + best-effort I/O.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-skill-'));
process.env.BROWSE_STATE_FILE = path.join(TMP, 'state', 'browse.json');
fs.mkdirSync(path.dirname(process.env.BROWSE_STATE_FILE), { recursive: true });

import {
  recordSkill,
  readSkills,
  pruneSkillJournal,
  filterRecentSkills,
  aggregateSkills,
  recommendSkill,
  skillJournalPath,
  SKILL_RECENCY_MS,
  type SkillRecord,
} from '../src/skill-journal';
import type { SiteProfile } from '../src/site-profile';

const OPEN: SiteProfile = { vendor: 'none', authKind: 'open', dynamism: 'static' };

function rec(over: Partial<SkillRecord>): SkillRecord {
  return {
    ts: 1, goalType: 'extract-data', siteType: 'none|open|static', domain: 'a.com',
    profile: OPEN, method: 'backend-api', shape: { verb: 'GET', urlPattern: '/api/x' },
    integritySensitive: false, metrics: { verifyOkRate: 1, latencyP95Ms: 800 }, ok: true, ...over,
  };
}
const clear = () => { try { fs.unlinkSync(skillJournalPath()); } catch {} };

describe('skill-journal — persistence + filter', () => {
  beforeEach(clear);
  test('append then read round-trips, filtered by goal/site/domain', () => {
    recordSkill(rec({ goalType: 'extract-data', domain: 'a.com' }));
    recordSkill(rec({ goalType: 'bulk-archive', domain: 'a.com' }));
    recordSkill(rec({ goalType: 'extract-data', domain: 'b.com' }));
    expect(readSkills().length).toBe(3);
    expect(readSkills({ goalType: 'extract-data' }).length).toBe(2);
    expect(readSkills({ domain: 'b.com' }).length).toBe(1);
  });
  test('malformed lines are skipped, not thrown', () => {
    recordSkill(rec({}));
    fs.appendFileSync(skillJournalPath(), 'not json\n{ bad\n');
    recordSkill(rec({}));
    expect(readSkills().length).toBe(2);
  });
  test('missing journal reads as empty', () => {
    clear();
    expect(readSkills()).toEqual([]);
  });
  test('atomic-friendly — no leftover .tmp', () => {
    recordSkill(rec({}));
    pruneSkillJournal();
    expect(fs.existsSync(skillJournalPath() + '.tmp')).toBe(false);
  });
});

describe('skill-journal — recency', () => {
  test('drops records older than the window, keeps ts-less', () => {
    const now = 2_000_000_000_000;
    const fresh = rec({ ts: now - 1000 });
    const stale = rec({ ts: now - SKILL_RECENCY_MS - 1 });
    const noTs = rec({ ts: undefined as any });
    const kept = filterRecentSkills([fresh, stale, noTs], now);
    expect(kept).toContain(fresh);
    expect(kept).toContain(noTs);
    expect(kept).not.toContain(stale);
  });
});

describe('skill-journal — aggregate + recommend (budget-scored)', () => {
  test('groups by (goal|site-type, method, shape) and recommends the best-scoring method', () => {
    const records = [
      // backend-api: 4/4 ok, verifies, fast → should win.
      ...Array.from({ length: 4 }, () => rec({ method: 'backend-api', ok: true, metrics: { verifyOkRate: 1, latencyP95Ms: 600 } })),
      // dom: 1/3 ok, slow → loses.
      rec({ method: 'dom', shape: { steps: ['click @e1', 'click @e2'] }, ok: true, metrics: { verifyOkRate: 0, latencyP95Ms: 9000 } }),
      ...Array.from({ length: 2 }, () => rec({ method: 'dom', shape: { steps: ['click @e1', 'click @e2'] }, ok: false, metrics: { verifyOkRate: 0, latencyP95Ms: 9000 } })),
    ];
    const stats = aggregateSkills(records);
    expect(stats.length).toBe(2); // two method/shape groups
    const r = recommendSkill(stats);
    expect(r!.record.method).toBe('backend-api');
    expect(r!.confidence).toBe('learned'); // 4 samples
    expect(r!.evidence).toContain('backend-api');
  });

  test('cold start (no stats) → null', () => {
    expect(recommendSkill([])).toBeNull();
  });

  test('a thin single sample recommends but stays thin', () => {
    const stats = aggregateSkills([rec({ method: 'backend-api', ok: true })]);
    expect(recommendSkill(stats)!.confidence).toBe('thin');
  });
});
