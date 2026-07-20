/**
 * [INPUT]: Depends on skill-router.ts (tiered method resolution + advisory surfacing).
 * [OUTPUT]: Verifies L1 domain → L2 site-type → L4 curated (recipe-registry) → L5
 *           cold-start, and that surfaceSkill is advisory: a safe backend shortcut is
 *           runnable, an integrity-sensitive one is CONFIRM_REQUIRED with no runnable line.
 * [POS]: Skill-library heart — generalizes "which engine" to "which method", layered on
 *        the curated recipe-registry exactly as engine-journal layers on strategy-advisor.
 */

import { describe, test, expect } from 'bun:test';
import { resolveSkillFrom, surfaceSkill, methodAdviceForNav, type SkillResolveDeps } from '../src/skill-router';
import type { SkillRecord } from '../src/skill-journal';
import type { SiteProfile } from '../src/site-profile';
import type { Recipe } from '../src/recipe-registry';

const OPEN: SiteProfile = { vendor: 'none', authKind: 'open', dynamism: 'static' };
function rec(over: Partial<SkillRecord>): SkillRecord {
  return {
    ts: 1, goalType: 'extract-data', siteType: 'none|open|static', domain: 'a.com',
    profile: OPEN, method: 'backend-api', shape: { verb: 'GET', urlPattern: '/api/x' },
    integritySensitive: false, metrics: { verifyOkRate: 1, latencyP95Ms: 600 }, ok: true, ...over,
  };
}
function deps(over: Partial<SkillResolveDeps> = {}): SkillResolveDeps {
  return { records: [], matchRecipe: () => null, profileOf: () => OPEN, ...over };
}
const FAKE_RECIPE: Recipe = { id: 'xapi-course', engine: 'real', title: 'SCORM course', steps: ['use the LMS driver'], match: {} };

describe('skill-router — tiered resolve', () => {
  test('L1: enough of the domain\'s OWN history for this goal → source domain', () => {
    const records = Array.from({ length: 3 }, () => rec({ domain: 'a.com', goalType: 'extract-data' }));
    const r = resolveSkillFrom('extract-data', 'https://a.com', undefined, deps({ records }));
    expect(r.source).toBe('domain');
    expect(r.recommendation!.record.method).toBe('backend-api');
  });

  test('L2: no domain history, but the site-TYPE has 3 domains / 8 samples → site-type', () => {
    const records = [
      ...Array.from({ length: 3 }, () => rec({ domain: 'a.com' })),
      ...Array.from({ length: 3 }, () => rec({ domain: 'b.com' })),
      ...Array.from({ length: 3 }, () => rec({ domain: 'c.com' })),
    ];
    const r = resolveSkillFrom('extract-data', 'https://never-seen.com', undefined, deps({ records }));
    expect(r.source).toBe('site-type');
  });

  test('L2 does NOT promote a FLAKY site-type method (low pooled success rate)', () => {
    // 3 domains, 9 samples, but the pooled method only succeeds 3/9 (~33%) — a flaky
    // trick, not a trustworthy shortcut. It must not surface as a confident learned skill.
    const flaky = (domain: string, ok: boolean) =>
      rec({ domain, ok, metrics: { verifyOkRate: ok ? 1 : 0, latencyP95Ms: 600 } });
    const records = [
      flaky('a.com', true), flaky('a.com', false), flaky('a.com', false),
      flaky('b.com', true), flaky('b.com', false), flaky('b.com', false),
      flaky('c.com', true), flaky('c.com', false), flaky('c.com', false),
    ];
    const r = resolveSkillFrom('extract-data', 'https://never-seen.com', undefined, deps({ records }));
    expect(r.source).toBe('cold-start'); // flaky pooled method is NOT promoted
  });

  test('L4: no learned skill, but a curated recipe matches → source curated', () => {
    const r = resolveSkillFrom('complete-course', 'https://x.com/index_lms.html', undefined,
      deps({ matchRecipe: () => FAKE_RECIPE }));
    expect(r.source).toBe('curated');
    expect(r.curated!.id).toBe('xapi-course');
  });

  test('L5: nothing learned, no recipe → cold-start', () => {
    const r = resolveSkillFrom('extract-data', 'https://fresh.com', undefined, deps());
    expect(r.source).toBe('cold-start');
    expect(r.recommendation).toBeNull();
  });
});

describe('skill-router — surfaceSkill (advisory)', () => {
  test('a safe backend-api skill surfaces a runnable browse js line', () => {
    const records = Array.from({ length: 3 }, () => rec({ shape: { verb: 'POST', urlPattern: '/api/export' }, integritySensitive: false }));
    const r = resolveSkillFrom('export-data', 'https://a.com', undefined, deps({ records: records.map(x => ({ ...x, goalType: 'export-data' })) }));
    const out = surfaceSkill(r, 'export-data');
    expect(out).toContain('browse js');
    expect(out).toContain('/api/export');
    expect(out).not.toContain('CONFIRM_REQUIRED');
  });

  test('an integrity-sensitive skill is CONFIRM_REQUIRED with NO runnable line', () => {
    const records = Array.from({ length: 3 }, () => rec({
      goalType: 'complete-course', shape: { verb: 'POST', urlPattern: '/ucTinCan/statements' }, integritySensitive: true,
    }));
    const r = resolveSkillFrom('complete-course', 'https://a.com', undefined, deps({ records }));
    const out = surfaceSkill(r, 'complete-course');
    expect(out).toContain('CONFIRM_REQUIRED');
    expect(out).not.toContain('browse js'); // the runnable shortcut is withheld until confirmed
  });

  test('a curated recipe surfaces its recipe block', () => {
    const r = resolveSkillFrom('complete-course', 'https://x.com/index_lms.html', undefined, deps({ matchRecipe: () => FAKE_RECIPE }));
    expect(surfaceSkill(r, 'complete-course')).toContain('recipe:');
  });

  test('cold-start surfaces nothing (no noise)', () => {
    const r = resolveSkillFrom('extract-data', 'https://fresh.com', undefined, deps());
    expect(surfaceSkill(r, 'extract-data')).toBe('');
  });
});

// An empty state dir → an empty journal, so these exercise the recipe/cold tiers only.
const EMPTY_ENV = { BROWSE_STATE_FILE: '/tmp/nc-methodadvice-test-empty/state.json' };

describe('methodAdviceForNav — auto nav-time method advice for a weak driver', () => {
  test('off-switch: BROWSE_DISABLE_SKILLS=1 → empty', () => {
    expect(methodAdviceForNav('https://api.worldbank.org/v2/country/CN/indicator/X?format=json', { ...EMPTY_ENV, BROWSE_DISABLE_SKILLS: '1' })).toBe('');
  });

  test('a data-portal URL surfaces the curated data recipe at cold start', () => {
    const out = methodAdviceForNav('https://api.worldbank.org/v2/country/CN/indicator/SP.ADO.TFRT?format=json', EMPTY_ENV);
    expect(out).toContain('recipe:');
    expect(out).toContain('data-portal'.slice(0, 4)); // "data"
  });

  test('an ordinary page with no learned skill and no recipe → empty (quiet)', () => {
    expect(methodAdviceForNav('https://example.com/', EMPTY_ENV)).toBe('');
  });
});
