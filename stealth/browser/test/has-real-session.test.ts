/**
 * [INPUT]: Depends on has-real-session.ts (hasRealBrowserSession + injectable deps).
 * [OUTPUT]: Verifies the "does the real browser hold live state for this domain"
 *           signal — the gate that decides automatic (headless/real) vs handoff.
 * [POS]: Phase-2 advisor signal test. Pure logic via dependency injection — no
 *        real browser, no Keychain (the real impl reads cookie COUNTS via
 *        listDomains, which never decrypts, so it can't pop a Keychain dialog).
 */

import { describe, test, expect } from 'bun:test';
import { hasRealBrowserSession, type SessionDeps } from '../src/has-real-session';

function deps(domains: string[], browser: string | null = 'arc'): SessionDeps {
  return {
    pickDefaultBrowser: () => browser,
    listDomains: () => ({
      domains: domains.map((d) => ({ domain: d, count: 1 })),
      browser: browser ?? '',
    }),
  };
}

describe('hasRealBrowserSession', () => {
  test('true when an exact host_key cookie exists', () => {
    expect(hasRealBrowserSession('https://example.com/x', deps(['example.com']))).toBe(true);
  });

  test('true for a dot-prefixed domain-wide cookie (.example.com)', () => {
    expect(hasRealBrowserSession('https://example.com/x', deps(['.example.com']))).toBe(true);
  });

  test('true when only a subdomain has cookies (eTLD+1 match)', () => {
    // canvas.uw.edu cookies should satisfy a query for www.uw.edu (same uw.edu).
    expect(hasRealBrowserSession('https://www.uw.edu/lib', deps(['canvas.uw.edu']))).toBe(true);
  });

  test('false when the domain has no cookies in the real browser', () => {
    expect(hasRealBrowserSession('https://example.com/x', deps(['other.org', 'github.com']))).toBe(false);
  });

  test('false when no default browser is installed', () => {
    expect(hasRealBrowserSession('https://example.com/x', deps([], null))).toBe(false);
  });

  test('does not match a different registrable domain that merely contains the name', () => {
    // notexample.com must not satisfy example.com.
    expect(hasRealBrowserSession('https://example.com/x', deps(['notexample.com']))).toBe(false);
  });

  test('fails safe (false) when the cookie DB read throws', () => {
    const throwingDeps: SessionDeps = {
      pickDefaultBrowser: () => 'arc',
      listDomains: () => { throw new Error('db locked'); },
    };
    expect(hasRealBrowserSession('https://example.com/x', throwingDeps)).toBe(false);
  });
});
