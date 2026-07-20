/**
 * [INPUT]: Depends on search-input.ts (pure ranker for the `search` primitive).
 * [OUTPUT]: Verifies the ranker picks a site's real search box across common shapes and
 *           rejects non-search inputs — the navigation-assist that lets a weak model use a
 *           site's own search instead of guessing (stale) URLs.
 */

import { describe, test, expect } from 'bun:test';
import { rankSearchInput, type SearchInputCandidate } from '../src/search-input';

const cand = (o: Partial<SearchInputCandidate>): SearchInputCandidate => ({
  index: 0, visible: true, ...o,
});

describe('rankSearchInput', () => {
  test('prefers input[type=search]', () => {
    const c = [cand({ index: 0, type: 'text', name: 'x' }), cand({ index: 1, type: 'search' })];
    expect(rankSearchInput(c)).toBe(1);
  });

  test('recognizes role=searchbox', () => {
    expect(rankSearchInput([cand({ index: 0, type: 'text' }), cand({ index: 1, role: 'searchbox' })])).toBe(1);
  });

  test('recognizes common search names (q/query/search/s)', () => {
    for (const name of ['q', 'query', 'search', 's', 'keyword']) {
      const c = [cand({ index: 0, type: 'text', name: 'email' }), cand({ index: 1, type: 'text', name })];
      expect(rankSearchInput(c)).toBe(1);
    }
  });

  test('recognizes a search placeholder / aria-label (incl. Chinese 搜索)', () => {
    expect(rankSearchInput([cand({ index: 0, type: 'text' }), cand({ index: 1, type: 'text', placeholder: 'Search the site' })])).toBe(1);
    expect(rankSearchInput([cand({ index: 0, type: 'text' }), cand({ index: 1, type: 'text', ariaLabel: '搜索' })])).toBe(1);
  });

  test('a search-role form boosts its plain text input', () => {
    const c = [cand({ index: 0, type: 'text', name: 'name' }), cand({ index: 1, type: 'text', inSearchForm: true })];
    expect(rankSearchInput(c)).toBe(1);
  });

  test('never picks a hidden / non-eligible input', () => {
    const c = [cand({ index: 0, type: 'search', visible: false }), cand({ index: 1, type: 'password', name: 'q' })];
    expect(rankSearchInput(c)).toBe(-1);
  });

  test('returns -1 when there is no plausible search box', () => {
    expect(rankSearchInput([cand({ index: 0, type: 'email', name: 'email' }), cand({ index: 1, type: 'checkbox' })])).toBe(-1);
    expect(rankSearchInput([])).toBe(-1);
  });

  test('among several search-ish inputs, the strongest signal wins', () => {
    const c = [
      cand({ index: 0, type: 'text', inSearchForm: true }),          // +form only
      cand({ index: 1, type: 'search' }),                            // type=search (strongest)
      cand({ index: 2, type: 'text', placeholder: 'search' }),       // placeholder
    ];
    expect(rankSearchInput(c)).toBe(1);
  });
});
