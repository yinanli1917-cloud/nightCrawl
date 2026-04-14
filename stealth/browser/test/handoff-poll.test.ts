/**
 * Unit tests for decidePoll — the pure-logic core of the auto-handover
 * polling loop. These tests do NOT touch a browser; they verify the
 * timing/stability rules that decide when login is "complete enough"
 * to safely resume to headless and snapshot cookies.
 *
 * Bug context (2026-04-14): the previous polling loop concluded
 * "login complete" the moment the URL changed off /login + no wall
 * was visible. With multi-step IDPs (UW IDP -> Duo -> SP callbacks),
 * that fires DURING the SAML chain — before the SP sets _shibsession_*.
 * Cookies snapshotted then are incomplete and the next navigation
 * re-bounces.
 *
 * Fix: require URL stability across the redirect chain. Only resume
 * when the URL has been unchanged for `stabilityMs` AND is not on a
 * login pattern AND the wall (if ever seen) is gone.
 */

import { describe, test, expect } from 'bun:test';
import {
  decidePoll,
  initialPollState,
  defaultPollOptions,
  type PollState,
  type PollOptions,
} from '../src/handoff-poll';

const LOGIN_URL = 'https://idp.u.washington.edu/idp/profile/SAML2/Redirect/SSO?execution=e1s1';
const DUO_URL = 'https://api-57f2a007.duosecurity.com/frame/frameless/v4/auth?sid=abc';
const CANVAS_URL = 'https://canvas.uw.edu/?login_success=1';

function opts(loginWallSeen = true, overrides: Partial<PollOptions> = {}): PollOptions {
  return {
    ...defaultPollOptions(LOGIN_URL),
    loginWallSeen,
    ...overrides,
  };
}

describe('decidePoll — single-step login (legacy happy path)', () => {
  test('continues while still on login URL', () => {
    const state = initialPollState(LOGIN_URL);
    const d = decidePoll({ url: LOGIN_URL, hasWall: true, elapsedMs: 1000 }, opts(), state);
    expect(d.action).toBe('continue');
  });

  test('resumes after URL changes off login + stability window elapsed', () => {
    const state = initialPollState(LOGIN_URL);
    // URL changes at t=1s, then stable for stabilityMs (default 5000ms)
    decidePoll({ url: CANVAS_URL, hasWall: false, elapsedMs: 1000 }, opts(), state);
    const d = decidePoll({ url: CANVAS_URL, hasWall: false, elapsedMs: 6500 }, opts(), state);
    expect(d.action).toBe('resume');
  });
});

describe('decidePoll — multi-step IDP (the Canvas/Duo regression)', () => {
  test('does NOT resume mid-chain when URL is changing rapidly', () => {
    // Simulate IDP -> Duo -> callback -> Canvas chain, each hop 1s apart,
    // total chain takes 4s. With stability window 5s, we must NOT resume
    // until URL has been stable for 5s after the chain settles.
    const state = initialPollState(LOGIN_URL);
    const o = opts();

    // t=1s: still on IDP login URL — continue (wall seen)
    let d = decidePoll({ url: LOGIN_URL, hasWall: true, elapsedMs: 1000 }, o, state);
    expect(d.action).toBe('continue');

    // t=2s: bounced to Duo — URL changed but only just now → continue (stability)
    d = decidePoll({ url: DUO_URL, hasWall: false, elapsedMs: 2000 }, o, state);
    expect(d.action).toBe('continue');

    // t=3s: Duo redirects to a callback URL — URL changed again → continue
    d = decidePoll(
      { url: 'https://idp.u.washington.edu/idp/profile/Authn/Duo/2FA/duo-callback?token=x', hasWall: false, elapsedMs: 3000 },
      o, state,
    );
    expect(d.action).toBe('continue');

    // t=4s: SAML POST back to Canvas
    d = decidePoll({ url: 'https://canvas.uw.edu/login/saml/consume?SAMLResponse=...', hasWall: false, elapsedMs: 4000 }, o, state);
    expect(d.action).toBe('continue');

    // t=5s: Canvas dashboard
    d = decidePoll({ url: CANVAS_URL, hasWall: false, elapsedMs: 5000 }, o, state);
    expect(d.action).toBe('continue'); // just landed, not yet stable

    // t=9.9s: Canvas still loaded, ~4.9s stable → still continue
    d = decidePoll({ url: CANVAS_URL, hasWall: false, elapsedMs: 9900 }, o, state);
    expect(d.action).toBe('continue');

    // t=10.001s: 5.001s stable on Canvas → RESUME
    d = decidePoll({ url: CANVAS_URL, hasWall: false, elapsedMs: 10001 }, o, state);
    expect(d.action).toBe('resume');
  });

  test('reset stability timer if URL changes during the wait', () => {
    const state = initialPollState(LOGIN_URL);
    const o = opts();

    // Settle on Duo at t=2s
    decidePoll({ url: DUO_URL, hasWall: false, elapsedMs: 2000 }, o, state);

    // 4s later, still on Duo, getting close to stable
    let d = decidePoll({ url: DUO_URL, hasWall: false, elapsedMs: 6000 }, o, state);
    expect(d.action).toBe('continue');

    // At t=6.5s, URL changes to callback → reset, continue
    d = decidePoll({ url: 'https://idp.u.washington.edu/idp/profile/cb', hasWall: false, elapsedMs: 6500 }, o, state);
    expect(d.action).toBe('continue');

    // Just 4s later (t=10.5s), only 4s stable → continue
    d = decidePoll({ url: 'https://idp.u.washington.edu/idp/profile/cb', hasWall: false, elapsedMs: 10500 }, o, state);
    expect(d.action).toBe('continue');

    // 5.5s later (t=12s), 5.5s stable → resume
    d = decidePoll({ url: 'https://idp.u.washington.edu/idp/profile/cb', hasWall: false, elapsedMs: 12000 }, o, state);
    expect(d.action).toBe('resume');
  });
});

describe('decidePoll — wall-still-present check', () => {
  test('does NOT resume if wall was seen and is still showing', () => {
    const state = initialPollState(LOGIN_URL);
    const o = opts(true);

    // URL changed off login, BUT wall (password input) is still on the new page
    decidePoll({ url: 'https://idp.u.washington.edu/idp/Authn/UserPassword', hasWall: true, elapsedMs: 1000 }, o, state);
    const d = decidePoll(
      { url: 'https://idp.u.washington.edu/idp/Authn/UserPassword', hasWall: true, elapsedMs: 7000 },
      o, state,
    );
    expect(d.action).toBe('continue');
  });

  test('still requires URL pattern check even if wall is gone', () => {
    const state = initialPollState(LOGIN_URL);
    const o = opts(true);

    // URL is still a /login pattern (e.g., /login/saml), wall gone temporarily
    const d = decidePoll(
      { url: 'https://canvas.uw.edu/login/saml/consume', hasWall: false, elapsedMs: 7000 },
      o, state,
    );
    expect(d.action).toBe('continue');
  });
});

describe('decidePoll — wall-never-seen path', () => {
  test('still requires URL stability when no wall was ever seen', () => {
    const state = initialPollState(LOGIN_URL);
    const o = opts(false); // wall never confirmed

    decidePoll({ url: CANVAS_URL, hasWall: false, elapsedMs: 1000 }, o, state);
    const d = decidePoll({ url: CANVAS_URL, hasWall: false, elapsedMs: 2000 }, o, state);
    expect(d.action).toBe('continue'); // only 1s stable

    const d2 = decidePoll({ url: CANVAS_URL, hasWall: false, elapsedMs: 6500 }, o, state);
    expect(d2.action).toBe('resume');
  });
});

describe('decidePoll — timeout', () => {
  test('returns timeout when elapsed exceeds maxWaitMs regardless of state', () => {
    const state = initialPollState(LOGIN_URL);
    const o = opts(true, { maxWaitMs: 60_000 });

    const d = decidePoll({ url: LOGIN_URL, hasWall: true, elapsedMs: 60_001 }, o, state);
    expect(d.action).toBe('timeout');
  });
});

describe('decidePoll — login URL pattern matching', () => {
  test('matches /sso, /login, /signin, /auth, /captcha, /verify (case-insensitive)', () => {
    for (const path of ['/login', '/SignIn', '/auth/x', '/captcha', '/verify-mfa', '/SSO']) {
      const state = initialPollState(LOGIN_URL);
      const o = opts(true);
      // even with stable URL, login pattern keeps us in continue
      decidePoll({ url: `https://x.com${path}`, hasWall: false, elapsedMs: 1000 }, o, state);
      const d = decidePoll({ url: `https://x.com${path}`, hasWall: false, elapsedMs: 8000 }, o, state);
      expect(d.action).toBe('continue');
    }
  });

  test('does not false-positive on URLs containing the substring without delimiter', () => {
    const state = initialPollState(LOGIN_URL);
    const o = opts(true);
    // "session" contains "sso" as substring — must NOT match (regex requires word boundary)
    decidePoll({ url: 'https://canvas.uw.edu/courses/session/123', hasWall: false, elapsedMs: 1000 }, o, state);
    const d = decidePoll({ url: 'https://canvas.uw.edu/courses/session/123', hasWall: false, elapsedMs: 7000 }, o, state);
    expect(d.action).toBe('resume');
  });
});

describe('decidePoll — initial state', () => {
  test('initialPollState records the starting URL', () => {
    const s = initialPollState(LOGIN_URL);
    expect(s.lastUrl).toBe(LOGIN_URL);
    expect(s.lastUrlChangeAt).toBe(0);
  });

  test('defaultPollOptions sane values', () => {
    const o = defaultPollOptions(LOGIN_URL);
    expect(o.loginUrl).toBe(LOGIN_URL);
    expect(o.maxWaitMs).toBeGreaterThan(0);
    expect(o.stabilityMs).toBeGreaterThan(0);
    expect(o.loginWallSeen).toBe(false);
  });
});
