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
