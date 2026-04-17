/**
 * Auth-cache unit tests.
 *
 * Verifies the in-memory authenticated-domain cache that lets
 * server.ts skip the 2s wait + login wall detection for known-good domains.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  isAuthenticated,
  markAuthenticated,
  invalidate,
  clearAuthCache,
  authCacheStats,
} from '../src/auth-cache';

beforeEach(() => {
  clearAuthCache();
});

describe('auth-cache', () => {
  test('unknown domain is not authenticated', () => {
    expect(isAuthenticated('https://example.com')).toBe(false);
  });

  test('markAuthenticated makes domain return true', () => {
    markAuthenticated('https://www.zhihu.com/explore');
    expect(isAuthenticated('https://www.zhihu.com/other')).toBe(true);
    expect(isAuthenticated('https://zhuanlan.zhihu.com/p/123')).toBe(true);
  });

  test('different eTLD+1 domains are independent', () => {
    markAuthenticated('https://canvas.uw.edu');
    expect(isAuthenticated('https://canvas.uw.edu/courses')).toBe(true);
    expect(isAuthenticated('https://www.zhihu.com')).toBe(false);
  });

  test('invalidate removes domain', () => {
    markAuthenticated('https://www.zhihu.com');
    expect(isAuthenticated('https://www.zhihu.com')).toBe(true);
    invalidate('https://www.zhihu.com/signin');
    expect(isAuthenticated('https://www.zhihu.com')).toBe(false);
  });

  test('TTL expiry clears entry', () => {
    markAuthenticated('https://example.com', 1); // 1ms TTL
    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) {} // spin 5ms
    expect(isAuthenticated('https://example.com')).toBe(false);
  });

  test('clearAuthCache removes all entries', () => {
    markAuthenticated('https://zhihu.com');
    markAuthenticated('https://canvas.uw.edu');
    clearAuthCache();
    expect(isAuthenticated('https://zhihu.com')).toBe(false);
    expect(isAuthenticated('https://canvas.uw.edu')).toBe(false);
  });

  test('authCacheStats reports size and domains', () => {
    markAuthenticated('https://zhihu.com');
    markAuthenticated('https://canvas.uw.edu');
    const stats = authCacheStats();
    expect(stats.size).toBe(2);
    expect(stats.domains).toContain('zhihu.com');
    expect(stats.domains).toContain('uw.edu');
  });

  test('malformed URLs do not crash', () => {
    expect(() => markAuthenticated('not-a-url')).not.toThrow();
    expect(() => isAuthenticated('not-a-url')).not.toThrow();
    expect(() => invalidate('not-a-url')).not.toThrow();
    expect(isAuthenticated('not-a-url')).toBe(false);
  });
});
