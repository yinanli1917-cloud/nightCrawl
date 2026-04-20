/**
 * Unit tests for handoff-cookie-import — pure logic for picking
 * candidate domains and host_keys to auto-import on a login wall.
 *
 * Live cookie import (which touches Keychain + the user's Arc/Chrome
 * cookie DB) is exercised through the integration path, not here.
 */

import { describe, test, expect } from 'bun:test';
import {
  SSO_HELPER_DOMAINS,
  buildCandidateDomains,
  clearCookiesForDomains,
  replaceCookiesFor,
} from '../src/handoff-cookie-import';

describe('SSO_HELPER_DOMAINS', () => {
  test('includes the providers our existing test users actually use', () => {
    // Canvas (UW Canvas regression motivated this whole feature)
    expect(SSO_HELPER_DOMAINS).toContain('canvaslms.com');
    expect(SSO_HELPER_DOMAINS).toContain('instructure.com');
    // Common enterprise IdPs
    expect(SSO_HELPER_DOMAINS).toContain('okta.com');
    expect(SSO_HELPER_DOMAINS).toContain('microsoftonline.com');
    expect(SSO_HELPER_DOMAINS).toContain('duosecurity.com');
  });

  test('all entries are eTLD+1 form (not subdomains)', () => {
    for (const d of SSO_HELPER_DOMAINS) {
      // No leading dots, no leading subdomains beyond the auth surfaces we explicitly include
      expect(d.startsWith('.')).toBe(false);
      // login.microsoft.com and accounts.google.com are explicit auth subdomains we do want
      const isExplicitAuthSubdomain = ['login.microsoft.com', 'login.live.com', 'accounts.google.com'].includes(d);
      const dotCount = (d.match(/\./g) || []).length;
      expect(dotCount === 1 || isExplicitAuthSubdomain).toBe(true);
    }
  });
});

describe('buildCandidateDomains — heuristic fallback (no observed hosts)', () => {
  test('Canvas case: target=canvas.uw.edu, wall=idp IDP url -> includes uw.edu, washington.edu, all SSO helpers', () => {
    const cands = buildCandidateDomains(
      'https://canvas.uw.edu/',
      'https://idp.u.washington.edu/idp/profile/SAML2/Redirect/SSO?execution=e1s1',
    );
    expect(cands).toContain('uw.edu');
    expect(cands).toContain('washington.edu');
    expect(cands).toContain('canvaslms.com');
    expect(cands).toContain('instructure.com');
    expect(cands).toContain('okta.com'); // SSO helper
  });

  test('same-origin wall (no IdP redirect): only includes target eTLD+1 + SSO helpers', () => {
    const cands = buildCandidateDomains(
      'https://example.com/dashboard',
      'https://example.com/login',
    );
    expect(cands).toContain('example.com');
    // washington.edu shouldn't appear from this scenario
    expect(cands).not.toContain('washington.edu');
    // SSO helpers always present
    expect(cands).toContain('canvaslms.com');
  });

  test('handles malformed URLs without throwing', () => {
    expect(() => buildCandidateDomains('not-a-url', 'also-not')).not.toThrow();
    const cands = buildCandidateDomains('not-a-url', 'also-not');
    // SSO helpers still included even if URL parse failed
    expect(cands.length).toBeGreaterThanOrEqual(SSO_HELPER_DOMAINS.length);
  });

  test('deduplicates when target and wall share eTLD+1', () => {
    const cands = buildCandidateDomains(
      'https://x.uw.edu/',
      'https://y.uw.edu/login',
    );
    const uwOccurrences = cands.filter(d => d === 'uw.edu').length;
    expect(uwOccurrences).toBe(1);
  });

  test('empty observed-hosts set is treated like undefined — falls back to heuristics', () => {
    const cands = buildCandidateDomains(
      'https://canvas.uw.edu/',
      'https://idp.u.washington.edu/sso',
      [], // empty iterable, should NOT be preferred over heuristics
    );
    // Heuristic fallback path includes SSO helpers
    expect(cands).toContain('canvaslms.com');
    expect(cands).toContain('uw.edu');
  });
});

describe('buildCandidateDomains — observed-hosts path (preferred)', () => {
  test('Canvas SSO chain via framenavigated: only observed hosts (+ target/wall safety net), NO SSO helpers', () => {
    // Real-world chain captured from page.on('framenavigated'):
    //   canvas.uw.edu -> idp.u.washington.edu -> api.duosecurity.com -> canvas.uw.edu
    const observed = [
      'canvas.uw.edu',
      'idp.u.washington.edu',
      'api.duosecurity.com',
      'canvas.uw.edu', // duplicate, should be deduped
    ];
    const cands = buildCandidateDomains(
      'https://canvas.uw.edu/',
      'https://idp.u.washington.edu/idp/profile/SAML2/Redirect/SSO',
      observed,
    );
    // Observed eTLD+1's all present
    expect(cands).toContain('uw.edu');
    expect(cands).toContain('washington.edu');
    expect(cands).toContain('duosecurity.com');
    // Heuristic SSO helpers NOT present — observed path replaces the heuristic
    expect(cands).not.toContain('canvaslms.com');
    expect(cands).not.toContain('instructure.com');
    expect(cands).not.toContain('okta.com');
    expect(cands).not.toContain('microsoftonline.com');
  });

  test('catches arbitrary IDP we never hardcoded (e.g. some-uni-shibboleth.edu)', () => {
    // Proves the value prop: we don't need to predict every IdP in advance
    const observed = ['app.example.com', 'shibboleth.some-uni.edu', 'mfa.acme-auth.io'];
    const cands = buildCandidateDomains(
      'https://app.example.com/',
      'https://shibboleth.some-uni.edu/sso',
      observed,
    );
    expect(cands).toContain('example.com');
    expect(cands).toContain('some-uni.edu');
    expect(cands).toContain('acme-auth.io');
    // None of these are in SSO_HELPER_DOMAINS — proves observation > heuristic
    expect(SSO_HELPER_DOMAINS).not.toContain('some-uni.edu');
    expect(SSO_HELPER_DOMAINS).not.toContain('acme-auth.io');
  });

  test('observed set deduplicates by eTLD+1 (multiple subdomains of same site)', () => {
    const observed = [
      'api.duosecurity.com',
      'admin.duosecurity.com',
      'cdn.duosecurity.com',
    ];
    const cands = buildCandidateDomains(
      'https://canvas.uw.edu/',
      'https://canvas.uw.edu/',
      observed,
    );
    const duoCount = cands.filter(d => d === 'duosecurity.com').length;
    expect(duoCount).toBe(1);
  });

  test('always includes target + wall eTLD+1 even if framenavigated missed them', () => {
    // Defensive: if listener attaches late and misses the very first
    // commit, we still want target/wall in the candidate set.
    const observed = ['idp.u.washington.edu']; // missing canvas.uw.edu!
    const cands = buildCandidateDomains(
      'https://canvas.uw.edu/',
      'https://idp.u.washington.edu/sso',
      observed,
    );
    expect(cands).toContain('washington.edu');
    expect(cands).toContain('uw.edu'); // injected defensively
  });

  test('observed hosts with malformed entries are silently skipped', () => {
    const observed = ['canvas.uw.edu', 'not a host', '', 'idp.u.washington.edu'];
    const cands = buildCandidateDomains(
      'https://canvas.uw.edu/',
      'https://canvas.uw.edu/',
      observed,
    );
    expect(cands).toContain('uw.edu');
    expect(cands).toContain('washington.edu');
  });
});

// ─── Atomic cookie swap (Stale Request prevention) ──────────
//
// When the headless browser has walked partway through a Shibboleth /
// SAML handshake, it holds half-written SP-side state: _shibsession_*,
// JSESSIONID, a RelayState the SP is "expecting" back. If we then import
// FRESH cookies from the user's real browser (which finished its own
// SAML handshake with a DIFFERENT RelayState) and just addCookies() on
// top, the SP sees two shibsessions at once and Shibboleth aborts with
// "Stale Request". That's the 2026-04-20 UW Canvas incident.
//
// The fix is an atomic swap: before addCookies, clearCookies for every
// eTLD+1 we're about to import — so headless starts from a clean
// SP-side state, inherits exactly what the real browser has, nothing
// mixed. These tests pin the clear-domain contract so future refactors
// can't silently go back to the additive path.
describe('clearCookiesForDomains — matches eTLD+1 and all subdomains', () => {
  test('builds a domain matcher that covers both apex and subdomains', async () => {
    const cleared: Array<{ domain?: string | RegExp }> = [];
    const mockContext = {
      clearCookies: async (filter?: { domain?: string | RegExp }) => {
        cleared.push(filter ?? {});
      },
    };
    await clearCookiesForDomains(mockContext as any, ['uw.edu', 'duosecurity.com']);

    expect(cleared.length).toBe(2);
    const domains = cleared.map(c => c.domain);
    // Each call must pass a domain filter (not a blanket clearAll)
    for (const d of domains) expect(d).toBeDefined();

    // The matcher must hit canvas.uw.edu, idp.u.washington.edu-style
    // subdomains under each eTLD+1, AND the apex itself.
    const uwMatcher = domains[0];
    const duoMatcher = domains[1];
    const testMatch = (m: any, host: string) =>
      m instanceof RegExp ? m.test(host) : m === host;
    expect(testMatch(uwMatcher, 'uw.edu')).toBe(true);
    expect(testMatch(uwMatcher, 'canvas.uw.edu')).toBe(true);
    expect(testMatch(uwMatcher, '.canvas.uw.edu')).toBe(true);
    expect(testMatch(duoMatcher, 'api.duosecurity.com')).toBe(true);
    // Must NOT match unrelated domains (no greedy suffix bugs)
    expect(testMatch(uwMatcher, 'notuw.edu')).toBe(false);
    expect(testMatch(uwMatcher, 'uw.edu.evil.com')).toBe(false);
  });

  test('swallows clearCookies errors so one bad domain cannot abort the swap', async () => {
    const mockContext = {
      clearCookies: async () => { throw new Error('boom'); },
    };
    // Must not throw — the poll loop has to keep running even if one
    // clear fails (Playwright quirks, transient CDP hiccups, etc).
    await expect(clearCookiesForDomains(mockContext as any, ['uw.edu'])).resolves.toBeUndefined();
  });

  test('no-op for empty domain list', async () => {
    let called = 0;
    const mockContext = { clearCookies: async () => { called++; } };
    await clearCookiesForDomains(mockContext as any, []);
    expect(called).toBe(0);
  });
});

// ─── replaceCookiesFor — single-chokepoint invariant ────────
//
// The whitelist-shaped earlier fix derived clear-targets from a pre-built
// candidate list (buildCandidateDomains). That list included heuristic
// fallbacks (SSO_HELPER_DOMAINS) which is a whitelist by definition and
// would miss any IdP we didn't hardcode.
//
// replaceCookiesFor fixes the generalization: it derives clear-targets
// DIRECTLY from the cookies being imported. Whatever domains those
// cookies live on, exactly those domains get cleared first. No list,
// no heuristic, no way for a new IdP to escape the invariant. One
// chokepoint, every import path must go through it.
describe('replaceCookiesFor — generalized atomic swap', () => {
  const makeMock = () => {
    const cleared: any[] = [];
    const added: any[] = [];
    const context = {
      clearCookies: async (filter?: any) => { cleared.push(filter); },
      addCookies: async (cookies: any[]) => { added.push(...cookies); },
    };
    return { context, cleared, added };
  };

  test('derives eTLD+1 targets from incoming cookies (no whitelist)', async () => {
    const { context, cleared, added } = makeMock();
    const cookies = [
      { name: '_shibsession_abc', value: 'x', domain: 'canvas.uw.edu', path: '/' },
      { name: 'JSESSIONID', value: 'y', domain: 'idp.u.washington.edu', path: '/' },
      { name: 'duo_state', value: 'z', domain: '.api.duosecurity.com', path: '/' },
    ];
    await replaceCookiesFor(context as any, cookies as any);

    // One clear call per distinct eTLD+1 derived from the cookies
    const domainsCleared = cleared.map(c => c.domain);
    expect(cleared.length).toBe(3);
    // Each matcher is a regex anchored on the eTLD+1
    const testMatch = (m: any, host: string) =>
      m instanceof RegExp ? m.test(host) : m === host;
    // uw.edu matcher hits both canvas.uw.edu and the apex
    const uwMatcher = domainsCleared.find((m: any) => testMatch(m, 'canvas.uw.edu'));
    expect(uwMatcher).toBeDefined();
    expect(testMatch(uwMatcher, 'uw.edu')).toBe(true);
    // washington.edu matcher present
    const wshMatcher = domainsCleared.find((m: any) => testMatch(m, 'idp.u.washington.edu'));
    expect(wshMatcher).toBeDefined();
    // duosecurity.com matcher present
    const duoMatcher = domainsCleared.find((m: any) => testMatch(m, 'api.duosecurity.com'));
    expect(duoMatcher).toBeDefined();
    // Then all cookies got added
    expect(added.length).toBe(3);
  });

  test('clear happens BEFORE add (order is the whole point of atomic swap)', async () => {
    const events: string[] = [];
    const context = {
      clearCookies: async () => { events.push('clear'); },
      addCookies: async () => { events.push('add'); },
    };
    const cookies = [{ name: 'x', value: 'y', domain: 'example.com', path: '/' }];
    await replaceCookiesFor(context as any, cookies as any);
    // Every clear must come before every add — otherwise we're back to
    // the additive path that caused Stale Request.
    const firstAddIdx = events.indexOf('add');
    const lastClearIdx = events.lastIndexOf('clear');
    expect(firstAddIdx).toBeGreaterThan(lastClearIdx);
  });

  test('no cookies → no clear, no add (cheap no-op)', async () => {
    const { context, cleared, added } = makeMock();
    await replaceCookiesFor(context as any, []);
    expect(cleared.length).toBe(0);
    expect(added.length).toBe(0);
  });

  test('unknown IdP domain (never in SSO_HELPER_DOMAINS) still gets cleared', async () => {
    // This is the whole point of the generalization: an IdP we never
    // hardcoded must still be covered because the target is derived from
    // the cookie itself.
    const { context, cleared } = makeMock();
    const cookies = [
      { name: 'session', value: 'x', domain: '.shibboleth.weird-uni.edu', path: '/' },
    ];
    expect(SSO_HELPER_DOMAINS).not.toContain('weird-uni.edu');
    await replaceCookiesFor(context as any, cookies as any);
    expect(cleared.length).toBe(1);
    const testMatch = (m: any, host: string) =>
      m instanceof RegExp ? m.test(host) : m === host;
    expect(testMatch(cleared[0].domain, 'shibboleth.weird-uni.edu')).toBe(true);
    expect(testMatch(cleared[0].domain, 'weird-uni.edu')).toBe(true);
  });

  test('deduplicates clears: three cookies on uw.edu subdomains → one clear', async () => {
    const { context, cleared } = makeMock();
    const cookies = [
      { name: 'a', value: '1', domain: 'canvas.uw.edu', path: '/' },
      { name: 'b', value: '2', domain: '.uw.edu', path: '/' },
      { name: 'c', value: '3', domain: 'my.uw.edu', path: '/' },
    ];
    await replaceCookiesFor(context as any, cookies as any);
    expect(cleared.length).toBe(1);
  });

  test('cookie with malformed domain is silently skipped (no crash)', async () => {
    const { context, cleared, added } = makeMock();
    const cookies = [
      { name: 'good', value: '1', domain: 'canvas.uw.edu', path: '/' },
      { name: 'bad', value: '2', domain: '', path: '/' },
    ];
    await expect(replaceCookiesFor(context as any, cookies as any)).resolves.toBeUndefined();
    expect(cleared.length).toBe(1); // just uw.edu
    expect(added.length).toBe(2);   // both cookies still get added — Playwright will reject bad one itself
  });
});
