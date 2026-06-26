/**
 * [INPUT]: Depends on bridge-session.ts (TabIdentity + resolveBoundTab).
 * [OUTPUT]: Verifies the bound tab is found by id when alive, re-bound by
 *           url(+window/title) when the id goes stale, and reported lost when
 *           nothing matches — the fix for Kimi's fragile raw-tabId binding.
 * [POS]: Phase-3B bridge foundation test. Pure logic, no Chrome.
 */

import { describe, test, expect } from 'bun:test';
import {
  resolveBoundTab, planBoundTab, clearBoundByTabId,
  type TabIdentity, type ChromeTab, type BoundStore,
} from '../src/bridge-session';

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

// ─── Per-session bind store (stage 7: one bound tab per session) ──────────
const ident = (over: Partial<TabIdentity> = {}): TabIdentity => ({
  tabId: 42, windowId: 7, url: 'https://a.test/', title: 'A', openedAt: 1, ...over,
});

describe('planBoundTab (per-session)', () => {
  test('goto with no bound tab for the session → create', () => {
    const store: BoundStore = new Map();
    expect(planBoundTab(store, 'A', 'goto', [])).toEqual({ action: 'create' });
  });

  test('goto when the session\'s bound tab is gone → create (re-open)', () => {
    const store: BoundStore = new Map([['A', ident({ tabId: 42 })]]);
    expect(planBoundTab(store, 'A', 'goto', [tab(99, { url: 'https://gone.test/' })]))
      .toEqual({ action: 'create' });
  });

  test('goto when the session already owns a live tab → use it', () => {
    const store: BoundStore = new Map([['A', ident({ tabId: 42 })]]);
    expect(planBoundTab(store, 'A', 'goto', [tab(42, { url: 'https://a.test/' })]))
      .toEqual({ action: 'use', tabId: 42, rebound: false });
  });

  test('non-goto with no bound tab for the session → lost (SESSION_LOST)', () => {
    const store: BoundStore = new Map();
    expect(planBoundTab(store, 'A', 'text', [])).toEqual({ action: 'lost' });
  });

  test('non-goto on a live bound tab → use', () => {
    const store: BoundStore = new Map([['A', ident({ tabId: 42 })]]);
    expect(planBoundTab(store, 'A', 'text', [tab(42, { url: 'https://a.test/' })]))
      .toEqual({ action: 'use', tabId: 42, rebound: false });
  });

  test('sessions are independent: planning for A never reads or mutates B', () => {
    const store: BoundStore = new Map([
      ['A', ident({ tabId: 42, url: 'https://a.test/' })],
      ['B', ident({ tabId: 7, url: 'https://b.test/', title: 'B' })],
    ]);
    // A's tab is gone → A re-creates, but B's binding is untouched.
    expect(planBoundTab(store, 'A', 'goto', [tab(7, { url: 'https://b.test/', title: 'B' })]))
      .toEqual({ action: 'create' });
    expect(store.get('B')).toEqual(ident({ tabId: 7, url: 'https://b.test/', title: 'B' }));
  });
});

describe('clearBoundByTabId (per-session onRemoved)', () => {
  test('drops only the sessions bound to the closed tab', () => {
    const store: BoundStore = new Map([
      ['A', ident({ tabId: 42 })],
      ['B', ident({ tabId: 7, url: 'https://b.test/' })],
    ]);
    clearBoundByTabId(store, 42);
    expect(store.has('A')).toBe(false);
    expect(store.has('B')).toBe(true);
  });
});
