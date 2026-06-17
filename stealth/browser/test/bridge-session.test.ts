/**
 * [INPUT]: Depends on bridge-session.ts (TabIdentity + resolveBoundTab).
 * [OUTPUT]: Verifies the bound tab is found by id when alive, re-bound by
 *           url(+window/title) when the id goes stale, and reported lost when
 *           nothing matches — the fix for Kimi's fragile raw-tabId binding.
 * [POS]: Phase-3B bridge foundation test. Pure logic, no Chrome.
 */

import { describe, test, expect } from 'bun:test';
import { resolveBoundTab, type TabIdentity, type ChromeTab } from '../src/bridge-session';

const stored: TabIdentity = {
  tabId: 42, windowId: 7, url: 'https://canvas.uw.edu/dash', title: 'Dashboard', openedAt: 1,
};

function tab(id: number, over: Partial<ChromeTab> = {}): ChromeTab {
  return { id, windowId: 7, url: 'https://canvas.uw.edu/dash', title: 'Dashboard', ...over };
}

describe('resolveBoundTab', () => {
  test('uses the same tabId when it is still open (even after navigation)', () => {
    const r = resolveBoundTab(stored, [tab(42, { url: 'https://canvas.uw.edu/grades' })]);
    expect(r).toEqual({ tabId: 42, rebound: false });
  });

  test('re-binds by url + window + title when the tabId is gone (Chrome restart renumbered)', () => {
    const r = resolveBoundTab(stored, [tab(99), tab(100, { url: 'https://other.com' })]);
    expect(r).toEqual({ tabId: 99, rebound: true });
  });

  test('re-binds by url even when the title changed', () => {
    const r = resolveBoundTab(stored, [tab(101, { title: 'Dashboard | Canvas' })]);
    expect(r).toEqual({ tabId: 101, rebound: true });
  });

  test('prefers the same-window candidate when several tabs share the url', () => {
    const r = resolveBoundTab(stored, [tab(5, { windowId: 9 }), tab(6, { windowId: 7 })]);
    expect(r!.tabId).toBe(6);
    expect(r!.rebound).toBe(true);
  });

  test('returns null (SESSION_LOST) when no tab matches the url', () => {
    expect(resolveBoundTab(stored, [tab(1, { url: 'https://elsewhere.com' })])).toBeNull();
    expect(resolveBoundTab(stored, [])).toBeNull();
  });
});
