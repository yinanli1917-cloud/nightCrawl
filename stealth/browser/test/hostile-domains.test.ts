/**
 * Hostile-domain blocklist tests.
 *
 * Background: 2026-04-09 incident — two real XHS accounts permanently
 * banned because nightCrawl logged into them with real cookies on a
 * non-incognito profile. Soft rules in markdown failed. Account safety
 * is now enforced by code that throws.
 *
 * [INPUT]: hostile-domains.ts (HOSTILE_DOMAINS, isHostile, assertSafeNavigation, filterHostileCookies)
 * [OUTPUT]: Pass/fail per safety invariant
 * [POS]: Unit tests for the safety blocklist within stealth/browser/test
 */

import { describe, test, expect } from 'bun:test';
import {
  HOSTILE_DOMAINS,
  HostileDomainError,
  isHostile,
  assertSafeNavigation,
  filterHostileCookies,
} from '../src/hostile-domains';

// ─── Helpers ────────────────────────────────────────────────────

function envWith(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

function cookie(domain: string, name = 'session'): any {
  return {
    name,
    value: 'abc123',
    domain,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: 'Lax',
  };
}

// ─── isHostile ──────────────────────────────────────────────────

describe('isHostile', () => {
  test('flags xiaohongshu.com root', () => {
    expect(isHostile('https://xiaohongshu.com/')).toBe(true);
  });

  test('flags xiaohongshu.com www subdomain', () => {
    expect(isHostile('https://www.xiaohongshu.com/explore')).toBe(true);
  });

  test('flags xiaohongshu.com deep subdomain', () => {
    expect(isHostile('https://m.xiaohongshu.com/user/profile/12345')).toBe(true);
  });

  test('flags xhscdn.com (xhs CDN)', () => {
    expect(isHostile('https://xhscdn.com/foo.jpg')).toBe(true);
  });

  test('flags xhslink.com (xhs short links)', () => {
    expect(isHostile('https://xhslink.com/abc')).toBe(true);
  });

  test('flags douyin.com', () => {
    expect(isHostile('https://www.douyin.com/video/12345')).toBe(true);
  });

  test('flags weibo.com and weibo.cn', () => {
    expect(isHostile('https://weibo.com/u/12345')).toBe(true);
    expect(isHostile('https://m.weibo.cn/status/abc')).toBe(true);
  });

  test('flags linkedin.com', () => {
    expect(isHostile('https://www.linkedin.com/in/foo')).toBe(true);
  });

  test('flags instagram.com', () => {
    expect(isHostile('https://www.instagram.com/user/')).toBe(true);
  });

  test('does NOT flag safe domains', () => {
    expect(isHostile('https://example.com')).toBe(false);
    expect(isHostile('https://github.com/foo/bar')).toBe(false);
    expect(isHostile('https://bot-detector.rebrowser.net')).toBe(false);
    expect(isHostile('https://bot.sannysoft.com')).toBe(false);
  });

  // ANTI-BYPASS: suffix match must respect hostname boundary
  test('does NOT flag attacker-controlled lookalike domains', () => {
    expect(isHostile('https://xiaohongshu.com.evil.com')).toBe(false);
    expect(isHostile('https://fakexiaohongshu.com')).toBe(false);
    expect(isHostile('https://notdouyin.com')).toBe(false);
  });

  test('handles malformed URLs gracefully (returns false, never throws)', () => {
    expect(() => isHostile('not a url')).not.toThrow();
    expect(isHostile('not a url')).toBe(false);
    expect(isHostile('')).toBe(false);
  });

  test('HOSTILE_DOMAINS contains xiaohongshu.com (the trigger of this whole rule)', () => {
    expect(HOSTILE_DOMAINS).toContain('xiaohongshu.com');
  });
});

// ─── assertSafeNavigation ───────────────────────────────────────

describe('assertSafeNavigation', () => {
  test('throws HostileDomainError on hostile URL without BROWSE_INCOGNITO', () => {
    expect(() => assertSafeNavigation('https://www.xiaohongshu.com/', envWith()))
      .toThrow(HostileDomainError);
  });

  test('throws on every hostile platform', () => {
    const urls = [
      'https://xiaohongshu.com/',
      'https://douyin.com/',
      'https://weibo.com/',
      'https://linkedin.com/',
      'https://instagram.com/',
    ];
    for (const url of urls) {
      expect(() => assertSafeNavigation(url, envWith())).toThrow(HostileDomainError);
    }
  });

  test('error message references the 2026-04-09 ban incident', () => {
    try {
      assertSafeNavigation('https://xiaohongshu.com/', envWith());
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(HostileDomainError);
      expect(err.message).toContain('xiaohongshu');
      expect(err.message.toLowerCase()).toContain('safety');
    }
  });

  test('does NOT throw with BROWSE_INCOGNITO=1', () => {
    expect(() => assertSafeNavigation(
      'https://www.xiaohongshu.com/',
      envWith({ BROWSE_INCOGNITO: '1' })
    )).not.toThrow();
  });

  test('does NOT throw on safe domains regardless of incognito', () => {
    expect(() => assertSafeNavigation('https://example.com', envWith())).not.toThrow();
    expect(() => assertSafeNavigation(
      'https://example.com',
      envWith({ BROWSE_INCOGNITO: '1' })
    )).not.toThrow();
  });

  test('BROWSE_INCOGNITO=0 (or any non-1 value) does NOT bypass', () => {
    expect(() => assertSafeNavigation(
      'https://xiaohongshu.com/',
      envWith({ BROWSE_INCOGNITO: '0' })
    )).toThrow(HostileDomainError);

    expect(() => assertSafeNavigation(
      'https://xiaohongshu.com/',
      envWith({ BROWSE_INCOGNITO: 'true' })
    )).toThrow(HostileDomainError);
  });
});

// ─── filterHostileCookies ───────────────────────────────────────

describe('filterHostileCookies', () => {
  test('removes XHS cookies from a mixed array', () => {
    const cookies = [
      cookie('.xiaohongshu.com'),
      cookie('.example.com'),
      cookie('.douyin.com'),
      cookie('.github.com'),
    ];
    const filtered = filterHostileCookies(cookies);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((c: any) => c.domain).sort())
      .toEqual(['.example.com', '.github.com']);
  });

  test('removes hostile cookies even when array is all hostile', () => {
    const cookies = [
      cookie('.xiaohongshu.com'),
      cookie('xhscdn.com'),
      cookie('.weibo.com'),
    ];
    expect(filterHostileCookies(cookies)).toHaveLength(0);
  });

  test('removes cookies UNCONDITIONALLY (no incognito bypass)', () => {
    // The function takes no env. Cookies for hostile domains are
    // ALWAYS filtered, period. The whole point is to make the
    // cookie file safe to load even if a future caller forgets
    // BROWSE_INCOGNITO=1.
    const cookies = [cookie('.xiaohongshu.com')];
    expect(filterHostileCookies(cookies)).toHaveLength(0);
  });

  test('preserves safe cookies untouched', () => {
    const cookies = [
      cookie('.example.com', 'a'),
      cookie('.example.com', 'b'),
      cookie('.github.com', 'c'),
    ];
    expect(filterHostileCookies(cookies)).toHaveLength(3);
  });

  test('handles cookies without leading dot', () => {
    const cookies = [
      cookie('xiaohongshu.com'),  // no leading dot
      cookie('www.xiaohongshu.com'),
    ];
    expect(filterHostileCookies(cookies)).toHaveLength(0);
  });

  test('does not match attacker lookalike cookie domains', () => {
    const cookies = [
      cookie('.xiaohongshu.com.evil.com'),
      cookie('.fakedouyin.com'),
    ];
    expect(filterHostileCookies(cookies)).toHaveLength(2);
  });

  test('handles empty array', () => {
    expect(filterHostileCookies([])).toEqual([]);
  });
});
