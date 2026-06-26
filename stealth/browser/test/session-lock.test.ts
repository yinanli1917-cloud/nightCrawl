/**
 * [INPUT]: BrowserManager.forSession + runOnTab (per-tab promise-chain lock).
 * [OUTPUT]: Verifies two commands on the SAME tab serialize, while commands on
 *           DIFFERENT tabs/sessions run concurrently — so sessions never block
 *           each other. No real browser: fake pages are enough for the lock.
 * [POS]: Stage-5 concurrency test. Per-tab lock keyed by TabState.lock.
 */

import { describe, test, expect } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakePage = (tag: string): any => ({ url: () => `https://${tag}.test/` });

// Add a tab owned by `owner` directly (no browser launch needed for lock logic).
function addTab(bm: BrowserManager, owner: string, tag: string): void {
  (bm as any).tabs.add(fakePage(tag), owner);
}

describe('Per-tab command lock (stage 5)', () => {
  test('two ops on the SAME tab serialize (no overlap)', async () => {
    const bm = new BrowserManager();
    addTab(bm, 'lock-A', 'a');
    const A = bm.forSession('lock-A');

    const order: string[] = [];
    const op = (tag: string, ms: number) => async () => {
      order.push(`${tag}:start`);
      await sleep(ms);
      order.push(`${tag}:end`);
    };

    // Start a slow op then a fast one on the SAME tab. The fast one must wait.
    const p1 = A.runOnTab(op('1', 60));
    const p2 = A.runOnTab(op('2', 5));
    await Promise.all([p1, p2]);

    expect(order).toEqual(['1:start', '1:end', '2:start', '2:end']);
  });

  test('ops on DIFFERENT sessions overlap (run concurrently)', async () => {
    const bm = new BrowserManager();
    addTab(bm, 'lock-A2', 'a');
    addTab(bm, 'lock-B2', 'b');
    const A = bm.forSession('lock-A2');
    const B = bm.forSession('lock-B2');

    const order: string[] = [];
    const op = (tag: string, ms: number) => async () => {
      order.push(`${tag}:start`);
      await sleep(ms);
      order.push(`${tag}:end`);
    };

    // A is slow, B is fast. B should finish while A is still sleeping.
    const pA = A.runOnTab(op('A', 60));
    const pB = B.runOnTab(op('B', 5));
    await Promise.all([pA, pB]);

    expect(order).toEqual(['A:start', 'B:start', 'B:end', 'A:end']);
  });

  test('a failing op does not poison the tab lock', async () => {
    const bm = new BrowserManager();
    addTab(bm, 'lock-C', 'c');
    const C = bm.forSession('lock-C');

    await expect(C.runOnTab(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The next op on the same tab still runs.
    const ok = await C.runOnTab(async () => 'ok');
    expect(ok).toBe('ok');
  });

  test('a session with no tab bypasses the lock and still runs', async () => {
    const bm = new BrowserManager();
    const D = bm.forSession('lock-D-none');
    const ok = await D.runOnTab(async () => 'ran');
    expect(ok).toBe('ran');
  });
});
