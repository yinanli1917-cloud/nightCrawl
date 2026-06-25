/**
 * [INPUT]: Depends on browser-manager.ts (forSession) + session-view.ts (SessionView/TabView).
 * [OUTPUT]: Verifies the per-session view facade: forSession caching + that a
 *           SessionView delegates the whole handler surface to its manager.
 * [POS]: Stage-3 facade test. Stage 3 is a pure passthrough — every call routes
 *        straight to the underlying BrowserManager (single global active tab).
 *        Stage 4 makes the per-tab methods resolve the session's OWN active tab;
 *        these delegation tests pin the wiring that stage 4 builds on.
 */

import { describe, test, expect } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';
import { SessionView } from '../src/session-view';
import { DEFAULT_SESSION_ID } from '../src/session-id';

describe('BrowserManager.forSession', () => {
  test('returns a SessionView carrying the session id', () => {
    const bm = new BrowserManager();
    const view = bm.forSession('claude:abc');
    expect(view).toBeInstanceOf(SessionView);
    expect(view.sessionId).toBe('claude:abc');
  });

  test('caches one view per session id (stable instance)', () => {
    const bm = new BrowserManager();
    expect(bm.forSession('a')).toBe(bm.forSession('a'));
    expect(bm.forSession('a')).not.toBe(bm.forSession('b'));
  });

  test('default session resolves to a view too', () => {
    const bm = new BrowserManager();
    const view = bm.forSession(DEFAULT_SESSION_ID);
    expect(view.sessionId).toBe(DEFAULT_SESSION_ID);
  });
});

describe('SessionView passthrough (stage 3)', () => {
  test('per-tab reads delegate to the manager', () => {
    const bm = new BrowserManager();
    (bm as any).getPage = () => 'PAGE';
    (bm as any).getCurrentUrl = () => 'https://example.com/';
    (bm as any).getActiveFrameOrPage = () => 'FRAME';
    (bm as any).getFrame = () => 'F';
    (bm as any).getTabCount = () => 7;

    const view = bm.forSession('s1');
    expect(view.getPage()).toBe('PAGE' as any);
    expect(view.getCurrentUrl()).toBe('https://example.com/');
    expect(view.getActiveFrameOrPage()).toBe('FRAME' as any);
    expect(view.getFrame()).toBe('F' as any);
    expect(view.getTabCount()).toBe(7);
  });

  test('tab mutations forward their arguments unchanged', async () => {
    const bm = new BrowserManager();
    const calls: any[] = [];
    (bm as any).newTab = (url?: string) => { calls.push(['newTab', url]); return Promise.resolve(3); };
    (bm as any).closeTab = (id?: number) => { calls.push(['closeTab', id]); return Promise.resolve(); };
    (bm as any).switchTab = (id: number) => { calls.push(['switchTab', id]); };

    const view = bm.forSession('s1');
    expect(await view.newTab('https://a.test/')).toBe(3);
    await view.closeTab(2);
    view.switchTab(5);
    expect(calls).toEqual([
      ['newTab', 'https://a.test/'],
      ['closeTab', 2],
      ['switchTab', 5],
    ]);
  });

  test('manager-level methods + props delegate straight through', () => {
    const bm = new BrowserManager();
    (bm as any).getConnectionMode = () => 'headed';
    (bm as any).isWatching = () => true;
    bm.serverPort = 42;
    const fakeCtx = { __ctx: true } as any;
    (bm as any).context = fakeCtx;

    const view = bm.forSession('s1');
    expect(view.getConnectionMode()).toBe('headed');
    expect(view.isWatching()).toBe(true);
    expect(view.serverPort).toBe(42);
    expect(view.context).toBe(fakeCtx);
  });
});
