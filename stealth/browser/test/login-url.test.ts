/**
 * [INPUT]: Depends on browser-handoff.ts (isLoginUrl, pure).
 * [OUTPUT]: A URL corpus proving the login-URL classifier flags real login/auth paths
 *           but NOT lookalikes (/login-help, /logins, /how-to-login). Precision + recall.
 * [POS]: Artifact 1 detection layer — the URL-path side of false-handover. A path that
 *        merely contains "login" must not trigger a hand-back.
 */

import { describe, test, expect } from 'bun:test';
import { isLoginUrl } from '../src/browser-handoff';

const REAL_LOGIN_URLS = [
  'https://x.com/login',
  'https://x.com/login/',
  'https://x.com/login?next=/dashboard',
  'https://x.com/login.html',
  'https://x.com/signin',
  'https://x.com/sign-in',
  'https://x.com/auth',
  'https://x.com/auth/authorize',
  'https://accounts.x.com/verify',
  'https://x.com/captcha',
  'https://idp.u.washington.edu/idp/profile/SAML2/Redirect/SSO?execution=e1s1',
];

const DECOY_URLS = [
  'https://x.com/login-help',
  'https://x.com/login-troubleshooting',
  'https://x.com/logins',
  'https://x.com/blog/how-to-login',
  'https://x.com/my-account',
  'https://x.com/products/verifier',
  'https://x.com/articles/authentic-coffee',
];

describe('isLoginUrl — login-path precision & recall', () => {
  test('recall: every real login/auth URL is flagged', () => {
    const missed = REAL_LOGIN_URLS.filter((u) => !isLoginUrl(u));
    expect(missed).toEqual([]);
  });

  test('precision: lookalike paths that merely contain a keyword are NOT flagged', () => {
    const falsePos = DECOY_URLS.filter((u) => isLoginUrl(u));
    expect(falsePos).toEqual([]);
  });
});
