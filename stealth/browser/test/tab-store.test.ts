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
});
