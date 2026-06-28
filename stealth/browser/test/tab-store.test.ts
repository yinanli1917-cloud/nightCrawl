/**
 * [INPUT]: Depends on tab-store.ts (per-tab state container).
 * [OUTPUT]: Verifies tab minting, active-tab tracking, and PER-TAB state
 *           isolation (refMap/frame/snapshot do not leak across tabs).
 * [POS]: Stage-2 storage test. Pure logic with fake Page objects — proves the
 *        per-tab model that later keeps concurrent sessions' refs apart.
 */

import { describe, test, expect } from 'bun:test';
import { TabStore } from '../src/tab-store';

// Minimal fake Page — TabStore only stores/returns it, never calls into it here.
const fakePage = (tag: string): any => ({ __tag: tag, url: () => `https://${tag}.test/` });

describe('TabStore', () => {
  test('add() mints incrementing ids and sets the new tab active', () => {
    const s = new TabStore();
    const a = s.add(fakePage('a'));
    const b = s.add(fakePage('b'));
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(s.activeId).toBe(2);
    expect(s.size()).toBe(2);
  });

  test('activePage throws when there is no active tab', () => {
    const s = new TabStore();
    expect(() => s.activePage()).toThrow(/No active page/);
  });

  test('activePage returns the active tab’s page', () => {
    const s = new TabStore();
    s.add(fakePage('a'));
    const b = s.add(fakePage('b'));
    expect((s.activePage() as any).__tag).toBe('b');
    s.setActive(1);
    expect((s.activePage() as any).__tag).toBe('a');
  });

  test('setActive on an unknown id throws', () => {
    const s = new TabStore();
    s.add(fakePage('a'));
    expect(() => s.setActive(99)).toThrow(/not found/);
  });

  test('PER-TAB refMap isolation: one tab’s refs never clobber another’s', () => {
    const s = new TabStore();
    const t1 = s.add(fakePage('a'));
    const t2 = s.add(fakePage('b'));

    s.setActive(t1);
    s.active()!.refMap.set('e1', { locator: {} as any, role: 'button', name: 'A' });
    s.setActive(t2);
    s.active()!.refMap.set('e1', { locator: {} as any, role: 'link', name: 'B' });

    // Tab 1 still has ITS ref — not overwritten by tab 2's snapshot.
    expect(s.get(t1)!.refMap.get('e1')!.name).toBe('A');
    expect(s.get(t2)!.refMap.get('e1')!.name).toBe('B');
  });

  test('PER-TAB frame + lastSnapshot are independent', () => {
    const s = new TabStore();
    const t1 = s.add(fakePage('a'));
    const t2 = s.add(fakePage('b'));
    s.get(t1)!.lastSnapshot = 'snap-1';
    s.get(t2)!.lastSnapshot = 'snap-2';
    s.get(t1)!.activeFrame = { __f: 1 } as any;
    expect(s.get(t1)!.lastSnapshot).toBe('snap-1');
    expect(s.get(t2)!.lastSnapshot).toBe('snap-2');
    expect(s.get(t2)!.activeFrame).toBeNull();
  });

  test('drop() removes a tab; closing logic lives in the caller', () => {
    const s = new TabStore();
    const t1 = s.add(fakePage('a'));
    s.add(fakePage('b'));
    s.drop(t1);
    expect(s.has(t1)).toBe(false);
    expect(s.size()).toBe(1);
  });

  test('pages() returns a {id -> page} projection', () => {
    const s = new TabStore();
    const t1 = s.add(fakePage('a'));
    const proj = s.pages();
    expect(proj.get(t1)!.__tag).toBe('a');
    expect(proj.size).toBe(1);
  });

  test('new tabs default to the shared session owner', () => {
    const s = new TabStore();
    const t1 = s.add(fakePage('a'));
    expect(s.get(t1)!.owner).toBe('default');
    const t2 = s.add(fakePage('b'), 'claude:xyz');
    expect(s.get(t2)!.owner).toBe('claude:xyz');
  });

  // ─── Per-session active model (stage 4) ──────────────────────
  test('each session tracks its OWN active tab, never another session’s', () => {
    const s = new TabStore();
    const a = s.add(fakePage('a'), 'A');
    const b = s.add(fakePage('b'), 'B');
    expect(s.activeIdFor('A')).toBe(a);
    expect(s.activeIdFor('B')).toBe(b);
    // A session with no tab has no active tab and throws on activePageFor.
    expect(s.activeIdFor('C')).toBe(0);
    expect(() => s.activePageFor('C')).toThrow(/No active page/);
  });

  test('setActiveFor is own-only: switching to another session’s tab throws', () => {
    const s = new TabStore();
    s.add(fakePage('a'), 'A');
    const b = s.add(fakePage('b'), 'B');
    expect(() => s.setActiveFor('A', b)).toThrow(/owned by another session/);
    expect(() => s.setActiveFor('A', 999)).toThrow(/not found/);
  });

  test('idsFor + ownerOf scope tabs to their owner', () => {
    const s = new TabStore();
    const a1 = s.add(fakePage('a1'), 'A');
    const a2 = s.add(fakePage('a2'), 'A');
    const b1 = s.add(fakePage('b1'), 'B');
    expect(s.idsFor('A').sort()).toEqual([a1, a2].sort());
    expect(s.idsFor('B')).toEqual([b1]);
    expect(s.ownerOf(a1)).toBe('A');
    expect(s.ownerOf(b1)).toBe('B');
  });

  test('drop clears only the owner’s active pointer (no jump to another tab)', () => {
    const s = new TabStore();
    const a = s.add(fakePage('a'), 'A');
    const b = s.add(fakePage('b'), 'B');
    s.drop(a);
    expect(s.activeIdFor('A')).toBe(0);   // A is now tab-less
    expect(s.activeIdFor('B')).toBe(b);   // B untouched
  });

  test('reset()/clear() drop per-session active pointers (whole-browser handoff)', () => {
    const s = new TabStore();
    s.add(fakePage('a'), 'A');
    s.add(fakePage('b'), 'B');
    s.reset();
    expect(s.activeIdFor('A')).toBe(0);
    expect(s.activeIdFor('B')).toBe(0);
    expect(s.size()).toBe(0);
  });

  // ─── Lazy re-bind: a follow-up command recovers the existing tab (A2) ────────
  // The Cursor-course session hit "No active page" 28x: goto worked, the next
  // command found the active pointer gone (tab replaced on nav, or a fresh client
  // call) and threw. Re-bind recovers the session's own tab instead of erroring.
  test('activePageFor re-binds to the session’s most-recent owned tab when the pointer is lost', () => {
    const s = new TabStore();
    const a1 = s.add(fakePage('a1'), 'A');
    const a2 = s.add(fakePage('a2'), 'A');
    s.drop(a2);                                       // A's active pointer (a2) is cleared
    expect((s.activePageFor('A') as any).__tag).toBe('a1'); // recovered the remaining owned tab
    expect(s.activeIdFor('A')).toBe(a1);             // and persisted the re-bind
  });

  test('default re-binds to the most-recent tab overall (back-compat)', () => {
    const s = new TabStore();
    s.add(fakePage('x'), 'A');
    const y = s.add(fakePage('y'), 'B');
    expect((s.activePageFor('default') as any).__tag).toBe('y');
  });

  test('activePageFor still throws when the store is empty', () => {
    const s = new TabStore();
    expect(() => s.activePageFor('default')).toThrow(/No active page/);
  });

  test('a tagged session with zero owned tabs throws (never steals another session’s tab)', () => {
    const s = new TabStore();
    s.add(fakePage('b'), 'B');                        // only B owns a tab
    expect(() => s.activePageFor('A')).toThrow(/No active page/); // A owns none, A≠default
  });
});
