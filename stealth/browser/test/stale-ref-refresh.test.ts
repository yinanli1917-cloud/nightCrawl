/**
 * [INPUT]: Depends on write-commands.ts (resolveRefWithRefresh + isStaleRefError).
 * [OUTPUT]: Verifies a stale @ref triggers ONE snapshot-refresh + retry, and that
 *           non-ref selectors / unrelated errors are not retried (no infinite loop).
 * [POS]: Pillar A3 test. Pure logic with injected resolve/refresh callbacks — encodes
 *        the fix for the Cursor-course "Ref @eN not found. Run 'snapshot'" recurrences.
 */

import { describe, test, expect } from 'bun:test';
import { resolveRefWithRefresh, isStaleRefError } from '../src/write-commands';

describe('isStaleRefError', () => {
  test('matches only @-refs with a not-found / stale message', () => {
    expect(isStaleRefError('@e1', new Error("Ref @e1 not found. Run 'snapshot'"))).toBe(true);
    expect(isStaleRefError('@c2', new Error('@c2 is stale — element no longer exists'))).toBe(true);
    expect(isStaleRefError('@e1', new Error('network down'))).toBe(false);  // wrong error
    expect(isStaleRefError('.btn', new Error('not found'))).toBe(false);    // CSS selector
  });
});

describe('resolveRefWithRefresh', () => {
  test('refreshes once and retries when a @ref is stale, then succeeds', async () => {
    let calls = 0, refreshed = 0;
    const resolve = async (s: string) => {
      calls++;
      if (calls === 1) throw new Error(`Ref ${s} not found. Run 'snapshot'`);
      return { locator: 'L' };
    };
    const r = await resolveRefWithRefresh(resolve, async () => { refreshed++; }, '@e9');
    expect(refreshed).toBe(1);
    expect(calls).toBe(2);
    expect(r).toEqual({ locator: 'L' });
  });

  test('does NOT refresh for a plain CSS selector — error propagates as-is', async () => {
    let refreshed = 0;
    const resolve = async () => { throw new Error('boom'); };
    await expect(
      resolveRefWithRefresh(resolve, async () => { refreshed++; }, 'button.foo'),
    ).rejects.toThrow('boom');
    expect(refreshed).toBe(0);
  });

  test('re-throws after a single refresh if the ref is still gone (no infinite loop)', async () => {
    let calls = 0, refreshed = 0;
    const resolve = async (s: string) => { calls++; throw new Error(`Ref ${s} stale`); };
    await expect(
      resolveRefWithRefresh(resolve, async () => { refreshed++; }, '@e1'),
    ).rejects.toThrow(/stale/);
    expect(refreshed).toBe(1);
    expect(calls).toBe(2);
  });
});
