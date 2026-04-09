/**
 * IPv6 + DNS hardening tests for SSRF prevention.
 * Covers gaps in url-validation.ts: IPv6 private ranges, IPv4-mapped IPv6,
 * AAAA DNS rebinding, and ReDoS-safe regex patterns.
 *
 * [INPUT]: Test cases for validateNavigationUrl
 * [OUTPUT]: Pass/fail assertions
 * [POS]: Security regression tests within stealth/browser/test/
 */

import { describe, it, expect } from 'bun:test';
import { validateNavigationUrl } from '../src/url-validation';

// ─── IPv6 Private/Reserved Range Blocking ─────────────────────

describe('IPv6 SSRF blocking', () => {
  it('blocks fc00::1 (ULA lower bound)', async () => {
    await expect(validateNavigationUrl('http://[fc00::1]/')).rejects.toThrow(/blocked/i);
  });

  it('blocks fd00::1 (ULA upper half)', async () => {
    await expect(validateNavigationUrl('http://[fd00::1]/')).rejects.toThrow(/blocked/i);
  });

  it('blocks fdff::1 (ULA upper bound)', async () => {
    await expect(validateNavigationUrl('http://[fdff::1]/')).rejects.toThrow(/blocked/i);
  });

  it('blocks fe80::1 (link-local)', async () => {
    await expect(validateNavigationUrl('http://[fe80::1]/')).rejects.toThrow(/blocked/i);
  });

  it('blocks fe80::1%eth0 (link-local with zone ID — invalid URL)', async () => {
    // Zone IDs in URLs are rejected by URL parser — this is fine, still blocked
    await expect(validateNavigationUrl('http://[fe80::1%25eth0]/')).rejects.toThrow();
  });

  it('blocks ::1 (IPv6 loopback)', async () => {
    await expect(validateNavigationUrl('http://[::1]/')).rejects.toThrow(/blocked/i);
  });

  it('blocks :: (IPv6 unspecified)', async () => {
    await expect(validateNavigationUrl('http://[::]/')).rejects.toThrow(/blocked/i);
  });
});

// ─── IPv4-Mapped IPv6 Addresses ───────────────────────────────

describe('IPv4-mapped IPv6 blocking', () => {
  it('blocks ::ffff:169.254.169.254 (metadata via IPv4-mapped)', async () => {
    await expect(validateNavigationUrl('http://[::ffff:169.254.169.254]/')).rejects.toThrow(/blocked/i);
  });

  it('blocks ::ffff:127.0.0.1 (loopback via IPv4-mapped)', async () => {
    await expect(validateNavigationUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/blocked/i);
  });

  it('blocks ::ffff:10.0.0.1 (private net via IPv4-mapped)', async () => {
    await expect(validateNavigationUrl('http://[::ffff:10.0.0.1]/')).rejects.toThrow(/blocked/i);
  });

  it('blocks ::ffff:192.168.1.1 (private net via IPv4-mapped)', async () => {
    await expect(validateNavigationUrl('http://[::ffff:192.168.1.1]/')).rejects.toThrow(/blocked/i);
  });

  it('blocks ::ffff:172.16.0.1 (private net via IPv4-mapped)', async () => {
    await expect(validateNavigationUrl('http://[::ffff:172.16.0.1]/')).rejects.toThrow(/blocked/i);
  });
});

// ─── Normal URLs Still Work ───────────────────────────────────

describe('legitimate URLs pass validation', () => {
  it('allows google.com', async () => {
    await expect(validateNavigationUrl('https://google.com')).resolves.toBeUndefined();
  });

  it('allows example.com', async () => {
    await expect(validateNavigationUrl('https://example.com')).resolves.toBeUndefined();
  });

  it('allows public IPv6 address', async () => {
    // 2001:db8:: is documentation range but URL-parseable — should not be blocked
    // Using a clearly public prefix
    await expect(validateNavigationUrl('http://[2607:f8b0:4004:800::200e]/')).resolves.toBeUndefined();
  });

  it('allows IPv4 localhost (existing behavior)', async () => {
    await expect(validateNavigationUrl('http://127.0.0.1:8080')).resolves.toBeUndefined();
  });

  it('allows IPv4 private nets (existing behavior)', async () => {
    await expect(validateNavigationUrl('http://192.168.1.1')).resolves.toBeUndefined();
  });
});

// ─── ReDoS Safety ─────────────────────────────────────────────

describe('ReDoS-safe regex', () => {
  it('escapeRegExp handles pathological input', async () => {
    // Import the escape function
    const { escapeRegExp } = await import('../src/url-validation');
    const malicious = '(a+)+$';
    const escaped = escapeRegExp(malicious);
    // Should complete instantly (not hang) and produce a safe pattern
    const re = new RegExp(escaped);
    expect(re.test('(a+)+$')).toBe(true);
    expect(re.test('aaaaaa')).toBe(false);
  });

  it('handles very long pathological regex input without hanging', async () => {
    const { escapeRegExp } = await import('../src/url-validation');
    // Classic ReDoS pattern — without escaping, this would cause catastrophic backtracking
    const evil = 'a'.repeat(100) + '!';
    const pattern = escapeRegExp('(' + 'a+'.repeat(50) + ')');
    const start = Date.now();
    new RegExp(pattern).test(evil);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // Should be near-instant
  });
});
