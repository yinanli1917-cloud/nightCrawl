/**
 * [INPUT]: Depends on banner-gate.ts (pure per-session banner dedup).
 * [OUTPUT]: Verifies the engine-guidance banner emits once per (session, domain),
 *           stays independent across sessions, always emits under --verbose, and that
 *           clearing a session re-arms only that session.
 * [POS]: Track B P0-2. The real Gmail session printed the guidance banner ~333 times;
 *        this is the pure gate that collapses it to once per domain per session. The
 *        emit decision also feeds the loop's bannerNoiseRate signal. Pure logic.
 */

import { describe, test, expect } from 'bun:test';
import { shouldEmitBanner, clearBannerSession } from '../src/banner-gate';

describe('banner-gate — collapse repeats to once per (session, domain)', () => {
  test('emits the first time, suppresses the repeat', () => {
    const seen = new Set<string>();
    expect(shouldEmitBanner(seen, 'claude:1', 'mail.google.com', false)).toBe(true);
    expect(shouldEmitBanner(seen, 'claude:1', 'mail.google.com', false)).toBe(false);
  });

  test('a different domain in the same session still emits', () => {
    const seen = new Set<string>();
    shouldEmitBanner(seen, 's', 'a.com', false);
    expect(shouldEmitBanner(seen, 's', 'b.com', false)).toBe(true);
  });

  test('the same domain in a different session emits (sessions are independent)', () => {
    const seen = new Set<string>();
    shouldEmitBanner(seen, 's1', 'a.com', false);
    expect(shouldEmitBanner(seen, 's2', 'a.com', false)).toBe(true);
  });

  test('--verbose always emits, even on a repeat', () => {
    const seen = new Set<string>();
    expect(shouldEmitBanner(seen, 's', 'a.com', true)).toBe(true);
    expect(shouldEmitBanner(seen, 's', 'a.com', true)).toBe(true);
  });

  test('clearing a session re-arms only that session', () => {
    const seen = new Set<string>();
    shouldEmitBanner(seen, 's1', 'a.com', false);
    shouldEmitBanner(seen, 's2', 'a.com', false);
    clearBannerSession(seen, 's1');
    expect(shouldEmitBanner(seen, 's1', 'a.com', false)).toBe(true); // re-armed
    expect(shouldEmitBanner(seen, 's2', 'a.com', false)).toBe(false); // untouched
  });
});
