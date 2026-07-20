/**
 * [INPUT]: Depends on nav-recovery.ts (navFailureHint, isNotFoundBody, extractQuery).
 * [OUTPUT]: Verifies a failed goto (4xx/5xx status OR a soft-404 body at 200) yields ONE
 *           next-move line pointing at the site's own search / homepage — never a hostname
 *           rule, never a URL guess.
 * [POS]: The navigation-assist self-teaching channel. A weak model loops on stale URLs; a
 *        hint in the immediate goto observation makes it use site search instead.
 */

import { describe, test, expect } from 'bun:test';
import { navFailureHint, isNotFoundBody, extractQuery } from '../src/nav-recovery';

describe('isNotFoundBody — soft-404 content signature', () => {
  test('classic "Page Not Found" body (FDA soft-404)', () => {
    expect(isNotFoundBody('Page Not Found We’re sorry. The page you are looking for is not available')).toBe(true);
  });
  test('"no results found" (empty search)', () => {
    expect(isNotFoundBody('Your search returned no results found for that term')).toBe(true);
  });
  test('non-English not-found (Chinese)', () => {
    expect(isNotFoundBody('页面不存在')).toBe(true);
  });
  test('a normal content page is NOT flagged', () => {
    expect(isNotFoundBody('Quarterly revenue rose to 524 million across all segments this year')).toBe(false);
  });
  test('undefined sample is not a failure', () => {
    expect(isNotFoundBody(undefined)).toBe(false);
  });
});

describe('extractQuery — seed real terms from a failed URL', () => {
  test('prefers a search-ish query param over the path', () => {
    expect(extractQuery('https://clinicaltrials.gov/ct2/results?cond=cancer')).toMatch(/cancer/i);
  });
  test('de-slugs the last path segment when no param', () => {
    const q = extractQuery('https://www.fda.gov/nonexistent-drug-database-xyz');
    expect(q).toMatch(/drug/i);
    expect(q).not.toMatch(/-/); // slug hyphens are turned into spaces
  });
  test('empty for a bare host', () => {
    expect(extractQuery('https://example.gov/')).toBe('');
  });
});

describe('navFailureHint — one recovery line on a failed goto', () => {
  test('4xx status → recovery hint naming search + homepage', () => {
    const h = navFailureHint({ status: 404, finalUrl: 'https://www.sec.gov/x', requestedUrl: 'https://www.sec.gov/x' });
    expect(h).toMatch(/search/i);
    expect(h).toMatch(/sec\.gov/); // homepage seed uses the SAME host, not a hardcoded site
    expect(h).toMatch(/404/);
  });

  test('5xx status → recovery hint', () => {
    expect(navFailureHint({ status: 503, finalUrl: 'https://a.org/b', requestedUrl: 'https://a.org/b' })).toMatch(/search/i);
  });

  test('soft-404: 200 status but not-found body → recovery hint', () => {
    const h = navFailureHint({ status: 200, finalUrl: 'https://www.fda.gov/x', requestedUrl: 'https://www.fda.gov/x', bodySample: 'Page Not Found we are sorry' });
    expect(h).toMatch(/search/i);
  });

  test('healthy 200 page → no hint (empty string)', () => {
    expect(navFailureHint({ status: 200, finalUrl: 'https://a.org/data', requestedUrl: 'https://a.org/data', bodySample: 'Total population 1.4 billion' })).toBe('');
  });

  test('3xx-followed 200 → no hint', () => {
    expect(navFailureHint({ status: 200, finalUrl: 'https://a.org/final', requestedUrl: 'https://a.org/start' })).toBe('');
  });

  test('seeds concrete search terms from the failed URL', () => {
    const h = navFailureHint({ status: 404, finalUrl: 'https://clinicaltrials.gov/ct2/results?cond=cancer', requestedUrl: 'https://clinicaltrials.gov/ct2/results?cond=cancer' });
    expect(h).toMatch(/cancer/i);
  });

  test('never emits a hardcoded third-party site — only the failed URL’s own host', () => {
    const h = navFailureHint({ status: 404, finalUrl: 'https://data.gov.hk/en/', requestedUrl: 'https://data.gov.hk/en/' });
    // the only host in the hint is the one that failed
    const hosts = [...h.matchAll(/https?:\/\/([^\/\s"]+)/g)].map(m => m[1]);
    for (const host of hosts) expect(host).toBe('data.gov.hk');
  });
});
