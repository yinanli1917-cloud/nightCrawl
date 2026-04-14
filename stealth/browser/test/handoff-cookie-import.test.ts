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

describe('buildCandidateDomains', () => {
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
});
