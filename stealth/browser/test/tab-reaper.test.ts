/**
 * [INPUT]: Depends on tab-reaper.ts (pure idle/cap tab selection).
 * [OUTPUT]: Verifies which tabs a reaper should close: idle past the threshold,
 *           oldest-first beyond the cap, never a protected (active/locked) tab.
 * [POS]: Track B P0-3. The real session leaked 9 Engine-R tabs because nothing reaped
 *        idle session tabs. This is the pure selection; the actual close (background.js
 *        chrome.tabs.remove + browser-manager) is wired at integration. The reap also
 *        feeds the loop's tabLeakRate signal.
 */

import { describe, test, expect } from 'bun:test';
import { selectTabsToReap, type ReapableTab, type ReapPolicy } from '../src/tab-reaper';

const NOW = 1_000_000_000_000;
const policy: ReapPolicy = { idleMs: 5 * 60_000, maxTabs: 8 };
const tab = (over: Partial<ReapableTab>): ReapableTab =>
  ({ id: 't', sessionId: 's', lastUsed: NOW, ...over });

describe('tab-reaper — idle reaping', () => {
  test('reaps a tab idle past the threshold', () => {
    const tabs = [tab({ id: 'old', lastUsed: NOW - 6 * 60_000 })];
    expect(selectTabsToReap(tabs, NOW, policy).map((t) => t.id)).toEqual(['old']);
  });

  test('keeps a freshly-used tab', () => {
    const tabs = [tab({ id: 'fresh', lastUsed: NOW - 60_000 })];
    expect(selectTabsToReap(tabs, NOW, policy)).toEqual([]);
  });

  test('never reaps a protected (active / locked) tab, even when idle', () => {
    const tabs = [tab({ id: 'active', lastUsed: NOW - 99 * 60_000, protectedTab: true })];
    expect(selectTabsToReap(tabs, NOW, policy)).toEqual([]);
  });
});

describe('tab-reaper — cap (P2-1: oldest-idle reap beyond the cap)', () => {
  test('reaps the oldest tabs down to the cap even if within the idle window', () => {
    // 10 fresh tabs, cap 8 → reap the 2 oldest.
    const tabs = Array.from({ length: 10 }, (_, i) => tab({ id: `t${i}`, lastUsed: NOW - i * 1000 }));
    const reaped = selectTabsToReap(tabs, NOW, policy).map((t) => t.id).sort();
    expect(reaped).toEqual(['t8', 't9']); // the two oldest (largest age)
  });

  test('the cap ignores protected tabs', () => {
    const tabs = [
      ...Array.from({ length: 8 }, (_, i) => tab({ id: `t${i}`, lastUsed: NOW - i * 1000 })),
      tab({ id: 'pinned', lastUsed: NOW - 999 * 60_000, protectedTab: true }),
    ];
    // 8 non-protected (== cap) + 1 protected → nothing reaped.
    expect(selectTabsToReap(tabs, NOW, policy)).toEqual([]);
  });
});

describe('tab-reaper — edges', () => {
  test('a tab that is both idle and over-cap is reported once, not twice', () => {
    const tabs = Array.from({ length: 9 }, (_, i) => tab({ id: `t${i}`, lastUsed: NOW - 10 * 60_000 - i }));
    const reaped = selectTabsToReap(tabs, NOW, policy);
    expect(new Set(reaped.map((t) => t.id)).size).toBe(reaped.length); // no dupes
    expect(reaped.length).toBe(9); // all idle → all reaped (cap is moot once idle takes them)
  });

  test('no tabs → nothing to reap', () => {
    expect(selectTabsToReap([], NOW, policy)).toEqual([]);
  });
});
