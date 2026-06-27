/**
 * [INPUT]: Depends on site-profile.ts (the site-TYPE signature derived from existing
 *          classifiers — the generalization key that lets routing transfer across
 *          domains, not just memorize one).
 * [OUTPUT]: Verifies profileFromSignals (vendor/authKind/dynamism derivation) and
 *           profileKey (stable, order-independent join key).
 * [POS]: A5 learned routing. Proves the "not only the domain" key: two different
 *        domains of the same type share a profileKey so the loop can pool their
 *        experience. Pure logic, no I/O.
 */

import { describe, test, expect } from 'bun:test';
import {
  profileFromSignals,
  profileKey,
  type SiteProfile,
} from '../src/site-profile';

describe('site-profile — profileFromSignals (derive the site TYPE)', () => {
  test('a Cloudflare-pinned IdP (SAML) login profiles as cloudflare|sso|static', () => {
    const p = profileFromSignals('https://idp.uw.edu/idp/profile/SAML2/Redirect/SSO', {
      vendor: 'cloudflare',
      reloginSeen: true,
      axTimedOut: false,
    });
    expect(p).toEqual({ vendor: 'cloudflare', authKind: 'sso', dynamism: 'static' });
  });

  test('a heavy-SPA open site profiles as none|open|heavy-spa', () => {
    const p = profileFromSignals('https://app.example.com/board', {
      vendor: null,
      reloginSeen: false,
      axTimedOut: true,
    });
    expect(p).toEqual({ vendor: 'none', authKind: 'open', dynamism: 'heavy-spa' });
  });

  test('a login-walled but non-IdP site profiles as login-wall (not sso)', () => {
    const p = profileFromSignals('https://canvas.uw.edu/', {
      vendor: 'cloudflare',
      reloginSeen: true,
      axTimedOut: false,
    });
    expect(p.authKind).toBe('login-wall');
  });

  test('no login signal and no heavy-JS → open + static', () => {
    const p = profileFromSignals('https://example.com', {});
    expect(p).toEqual({ vendor: 'none', authKind: 'open', dynamism: 'static' });
  });

  test('a DataDome host with an OAuth path profiles as datadome|sso', () => {
    const p = profileFromSignals('https://shop.example.com/oauth/authorize', {
      vendor: 'datadome',
      reloginSeen: true,
    });
    expect(p.vendor).toBe('datadome');
    expect(p.authKind).toBe('sso');
  });
});

describe('site-profile — profileKey (the generalization join key)', () => {
  test('encodes vendor|authKind|dynamism', () => {
    const p: SiteProfile = { vendor: 'datadome', authKind: 'open', dynamism: 'static' };
    expect(profileKey(p)).toBe('datadome|open|static');
  });

  test('two DIFFERENT domains of the same type share one key (the whole point)', () => {
    const a = profileFromSignals('https://idp.uw.edu/idp/SAML2', { vendor: 'cloudflare', reloginSeen: true });
    const b = profileFromSignals('https://sso.stanford.edu/idp/SAML2', { vendor: 'cloudflare', reloginSeen: true });
    expect(profileKey(a)).toBe(profileKey(b));
  });

  test('a different type yields a different key', () => {
    const sso = profileFromSignals('https://idp.uw.edu/SAML2', { vendor: 'cloudflare', reloginSeen: true });
    const open = profileFromSignals('https://example.com', {});
    expect(profileKey(sso)).not.toBe(profileKey(open));
  });
});
