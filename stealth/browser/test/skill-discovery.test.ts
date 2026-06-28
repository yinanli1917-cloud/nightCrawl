/**
 * [INPUT]: Depends on skill-discovery.ts (correlate + extractShape + discoverSkill).
 * [OUTPUT]: Verifies a verified success is correlated to the mutating API call that
 *           produced it (telemetry + stale dropped), the call is parameterized into a
 *           de-identified replayable shape, and integrity is classified at discovery.
 * [POS]: Skill-library discovery brain — turns "it worked" into a reusable backend
 *        shortcut SHAPE (no raw ids, no values), the thing the router later surfaces.
 */

import { describe, test, expect } from 'bun:test';
import { correlate, extractShape, discoverSkill, type DiscoveryInput } from '../src/skill-discovery';
import type { DeepNetEntry } from '../src/network-capture-deep';
import type { SiteProfile } from '../src/site-profile';

const OPEN: SiteProfile = { vendor: 'none', authKind: 'open', dynamism: 'static' };
const T = 1_000_000;
const net = (over: Partial<DeepNetEntry>): DeepNetEntry =>
  ({ timestamp: T, method: 'GET', url: 'https://x.com/api/x', resourceType: 'xhr', status: 200, ...over });

describe('skill-discovery — correlate', () => {
  test('picks the mutating 2xx call closest to the verify; drops telemetry + stale', () => {
    const entries = [
      net({ timestamp: T - 1000, method: 'POST', url: 'https://google-analytics.com/collect' }), // telemetry → drop
      net({ timestamp: T - 60000, method: 'POST', url: 'https://x.com/api/old', status: 200 }),   // stale → drop
      net({ timestamp: T - 2000, method: 'POST', url: 'https://x.com/api/courses/40122/complete', status: 200, reqBody: '{"score":92}' }),
      net({ timestamp: T - 500, method: 'GET', url: 'https://x.com/api/profile' }),
    ];
    const out = correlate({ entries, verifiedAt: T, goalType: 'complete-course', profile: OPEN, domain: 'x.com' });
    expect(out[0].url).toContain('/api/courses/40122/complete'); // the mutating action wins
    expect(out.some((e) => e.url.includes('google-analytics'))).toBe(false);
    expect(out.some((e) => e.url.includes('/api/old'))).toBe(false);
  });
});

describe('skill-discovery — extractShape (de-identified, replayable)', () => {
  test('parameterizes id-like path segments and maps body keys to types (no raw values)', () => {
    const shape = extractShape(net({
      method: 'POST',
      url: 'https://x.com/api/courses/40122/complete',
      reqBody: '{"score":92,"user":"jane"}',
    }));
    expect(shape.verb).toBe('POST');
    expect(shape.urlPattern).toBe('/api/courses/{{id}}/complete'); // 40122 → {{id}}
    expect(shape.bodySchema).toEqual({ score: 'number', user: 'string' }); // keys + types, never "jane"/92
  });
});

describe('skill-discovery — discoverSkill', () => {
  function input(over: Partial<DiscoveryInput> = {}): DiscoveryInput {
    return { entries: [], verifiedAt: T, goalType: 'extract-data', profile: OPEN, domain: 'x.com', ...over };
  }
  test('builds a backend-api SkillRecord, integrity-classified', () => {
    const entries = [net({ timestamp: T - 1000, method: 'POST', url: 'https://x.com/ucTinCan/statements', reqBody: '{"verb":"completed"}' })];
    const d = discoverSkill(input({ entries, goalType: 'complete-course' }), { verifyOkRate: 1 });
    expect(d!.record.method).toBe('backend-api');
    expect(d!.record.integritySensitive).toBe(true); // xAPI completion
    expect(d!.record.siteType).toBe('none|open|static');
  });
  test('a benign read shortcut is not integrity-sensitive', () => {
    const entries = [net({ timestamp: T - 1000, method: 'GET', url: 'https://x.com/api/search?q=hi' })];
    const d = discoverSkill(input({ entries, goalType: 'extract-data' }), { verifyOkRate: 1 });
    expect(d!.record.integritySensitive).toBe(false);
  });
  test('no correlated call → null', () => {
    expect(discoverSkill(input({ entries: [] }), {})).toBeNull();
  });
});
