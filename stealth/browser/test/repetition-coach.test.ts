/**
 * [INPUT]: Depends on repetition-coach.ts (argsKeyFor, detectRepetition, repetitionHint,
 *          resetRepetition).
 * [OUTPUT]: Verifies the planning-layer coach: when a weak model repeats a search/goto/
 *           follow with no progress, it gets ONE actionable nudge toward the productive
 *           move — reclaiming the wasted steps that blow a small budget.
 * [POS]: The analog of the perception layer for the PLANNING wall. General, session-scoped,
 *        no per-site logic. Pure core tested here; the daemon holds the per-session history.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  argsKeyFor,
  detectRepetition,
  repetitionHint,
  resetRepetition,
  type ActionRecord,
} from '../src/repetition-coach';

const rec = (command: string, argsKey: string, url: string): ActionRecord => ({ command, argsKey, url });

describe('argsKeyFor', () => {
  test('goto normalizes the URL (scheme, trailing slash, case)', () => {
    expect(argsKeyFor('goto', ['https://Example.com/Path/'])).toBe(argsKeyFor('goto', ['http://example.com/Path']));
  });
  test('search lowercases and strips quotes', () => {
    expect(argsKeyFor('search', ['"CO2 Per Capita"'])).toBe('co2 per capita');
  });
});

describe('detectRepetition — one nudge on a wasted repeat', () => {
  test('goto to a URL already visited → nudge toward search/follow/read', () => {
    const hist = [rec('goto', 'example.com/a', 'example.com/a')];
    const h = detectRepetition(hist, 'goto', 'example.com/a', 'example.com/a');
    expect(h).toMatch(/already|search|follow|read/i);
  });
  test('goto to a NEW url → no nudge', () => {
    const hist = [rec('goto', 'example.com/a', 'example.com/a')];
    expect(detectRepetition(hist, 'goto', 'example.com/b', 'example.com/b')).toBeNull();
  });

  test('a re-phrased search (high token overlap) → nudge toward read/follow', () => {
    const hist = [rec('search', 'co2 per capita', 'site/search')];
    const h = detectRepetition(hist, 'search', 'co2 emissions per capita', 'site/search');
    expect(h).toMatch(/search|read|follow/i);
  });
  test('the 3rd search overall → nudge even if terms differ (thrashing)', () => {
    const hist = [rec('search', 'alpha', 's'), rec('search', 'bravo', 's')];
    expect(detectRepetition(hist, 'search', 'charlie delta', 's')).toMatch(/search|read|follow/i);
  });
  test('the 2nd, unrelated search → no nudge yet', () => {
    const hist = [rec('search', 'alpha beta', 's')];
    expect(detectRepetition(hist, 'search', 'gamma delta', 's')).toBeNull();
  });

  test('the same follow keyword reused → nudge', () => {
    const hist = [rec('follow', 'annual report', 'x')];
    expect(detectRepetition(hist, 'follow', 'annual report', 'x')).toMatch(/follow|read|link|search/i);
  });

  test('read-only command repeated on the SAME page → nudge to move on', () => {
    const hist = [rec('find', '6.006', 'catalog/eecs')];
    expect(detectRepetition(hist, 'find', '6.006', 'catalog/eecs')).toMatch(/different page|follow|search|table|data/i);
  });
  test('same read-only command after navigating to a NEW page → no nudge', () => {
    const hist = [rec('find', '6.006', 'catalog/home')];
    expect(detectRepetition(hist, 'find', '6.006', 'catalog/eecs')).toBeNull();
  });

  test('a non-explore command (click) is never nudged', () => {
    const hist = [rec('click', '@e5', 'x')];
    expect(detectRepetition(hist, 'click', '@e5', 'x')).toBeNull();
  });
  test('the first action of a session → no nudge', () => {
    expect(detectRepetition([], 'goto', 'example.com', 'example.com')).toBeNull();
  });
});

describe('repetitionHint — stateful per-session shell', () => {
  beforeEach(() => resetRepetition());
  test('records across calls and fires on the repeat, isolated per session', () => {
    expect(repetitionHint('s1', 'goto', ['https://a.com/x'], 'https://a.com/x')).toBeNull();
    // a different session is unaffected
    expect(repetitionHint('s2', 'goto', ['https://a.com/x'], 'https://a.com/x')).toBeNull();
    // s1 revisits → nudge
    expect(repetitionHint('s1', 'goto', ['https://a.com/x'], 'https://a.com/x')).toMatch(/already|search|follow/i);
  });
  test('resetRepetition clears history', () => {
    repetitionHint('s3', 'search', ['x'], 'u');
    repetitionHint('s3', 'search', ['x'], 'u');
    resetRepetition('s3');
    expect(repetitionHint('s3', 'search', ['x'], 'u')).toBeNull();
  });
});
