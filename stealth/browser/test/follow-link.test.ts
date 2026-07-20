/**
 * [INPUT]: Depends on follow-link.ts (LinkCandidate, rankLinks).
 * [OUTPUT]: Verifies a keyword picks the best on-page link (by visible text, then
 *           aria/title, then href) so `follow <keyword>` collapses a multi-step
 *           search-result -> filing -> document traversal into ONE step.
 * [POS]: Navigation-assist for weak drivers. A weak model burns its step budget
 *        snapshotting + resolving @refs to click one link. `follow` is keyword-driven,
 *        page-general (no hostnames), a pure ranker like search-input.
 */

import { describe, test, expect } from 'bun:test';
import { rankLinks, type LinkCandidate } from '../src/follow-link';

const link = (i: number, text: string, extra: Partial<LinkCandidate> = {}): LinkCandidate => ({
  index: i, text, href: `https://x/${i}`, visible: true, ...extra,
});

describe('rankLinks — keyword picks the best link', () => {
  test('exact visible-text match wins over partial', () => {
    const cands = [link(0, 'Home'), link(1, '10-K Annual Report'), link(2, '10-Q Quarterly')];
    expect(rankLinks(cands, '10-K Annual Report')).toBe(1);
  });

  test('most keyword tokens in text wins', () => {
    const cands = [link(0, 'Tesla news'), link(1, 'Tesla Inc annual report 10-K'), link(2, 'Investor relations')];
    expect(rankLinks(cands, 'Tesla annual report')).toBe(1);
  });

  test('matches aria-label when the link text is an icon (empty text)', () => {
    const cands = [link(0, ''), link(1, '', { ariaLabel: 'Download CSV dataset' })];
    expect(rankLinks(cands, 'download csv')).toBe(1);
  });

  test('falls back to href path when nothing better matches', () => {
    const cands = [link(0, 'Click here', { href: 'https://x/about' }), link(1, 'Click here', { href: 'https://x/statistics/population' })];
    expect(rankLinks(cands, 'population')).toBe(1);
  });

  test('hidden links are never chosen even on a strong text match', () => {
    const cands = [link(0, 'Operating lease detail', { visible: false }), link(1, 'Something else')];
    expect(rankLinks(cands, 'operating lease')).not.toBe(0);
  });

  test('no plausible match → -1', () => {
    const cands = [link(0, 'Home'), link(1, 'Contact us')];
    expect(rankLinks(cands, 'quarterly earnings xbrl')).toBe(-1);
  });

  test('empty candidate list → -1', () => {
    expect(rankLinks([], 'anything')).toBe(-1);
  });

  test('CJK keyword matches CJK link text', () => {
    const cands = [link(0, '首页'), link(1, '2023年度报告')];
    expect(rankLinks(cands, '年度报告')).toBe(1);
  });
});
