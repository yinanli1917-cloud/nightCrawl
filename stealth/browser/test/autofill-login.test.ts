/**
 * [INPUT]: Depends on autofill-login.ts (Engine R native-password login-autofill).
 * [OUTPUT]: Verifies the pure outcome classifier and the orchestration flow with
 *           an injected bridge (not connected / no form / consent gate / success
 *           / 2FA / failed). No real browser needed — the live trusted-submit
 *           behavior is confirmed separately on a real saved-password site.
 * [POS]: C1 test. nightCrawl never reads the password; it consents + trusted-
 *        submits and lets the browser release its own saved credential.
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyOutcome,
  handleAutofillLogin,
  type LoginAutofillCtx,
} from '../src/autofill-login';

describe('autofill-login — classifyOutcome (pure)', () => {
  test('2FA markers in the page → twofa (even if the URL changed)', () => {
    expect(classifyOutcome({ beforeUrl: 'https://x.com/login', afterUrl: 'https://x.com/2fa', afterText: 'Enter the verification code from your authenticator', stillHasPassword: false }).status).toBe('twofa');
  });
  test('password field gone → success', () => {
    expect(classifyOutcome({ beforeUrl: 'https://x.com/login', afterUrl: 'https://x.com/home', afterText: 'Welcome back', stillHasPassword: false }).status).toBe('success');
  });
  test('still on login with the password field present → failed', () => {
    expect(classifyOutcome({ beforeUrl: 'https://x.com/login', afterUrl: 'https://x.com/login', afterText: 'Invalid password', stillHasPassword: true }).status).toBe('failed');
  });
  test('URL moved away from login (password may persist on new page) → success', () => {
    expect(classifyOutcome({ beforeUrl: 'https://x.com/login', afterUrl: 'https://x.com/dashboard', afterText: 'Dashboard', stillHasPassword: true }).status).toBe('success');
  });
});

// ── Orchestration with an injected bridge ──────────────────

function ctx(over: Partial<LoginAutofillCtx> & {
  detectBefore?: any; detectAfter?: any; beforeUrl?: string; afterUrl?: string; afterText?: string;
} = {}): { ctx: LoginAutofillCtx; notified: string[]; clicks: string[] } {
  const notified: string[] = [];
  const clicks: string[] = [];
  let urlCalls = 0; let detectCalls = 0;
  const detectBefore = over.detectBefore ?? { hasPassword: true, username: 'jane@x.com', passwordSelector: '[data-nc-login-pw="1"]', submitSelector: '[data-nc-login-submit="1"]' };
  const detectAfter = over.detectAfter ?? { hasPassword: false };
  const base: LoginAutofillCtx = {
    isConnected: () => true,
    isConsented: () => true,
    sleep: () => Promise.resolve(),
    notify: (t, b) => { notified.push(`${t}|${b}`); },
    dispatch: async (cmd, args) => {
      if (cmd === 'click') { clicks.push(args[0]); return true; }
      if (cmd === 'text') return over.afterText ?? 'Welcome back';
      const e = args[0] || '';
      if (e === 'location.href') return (urlCalls++ === 0) ? (over.beforeUrl ?? 'https://x.com/login') : (over.afterUrl ?? 'https://x.com/home');
      if (e.includes('setTimeout')) return 1;
      if (e.includes('password') || e.includes('data-nc-login')) return JSON.stringify((detectCalls++ === 0) ? detectBefore : detectAfter);
      return '';
    },
    ...over,
  };
  return { ctx: base, notified, clicks };
}

describe('autofill-login — orchestration', () => {
  test('no bridge connected → AUTOFILL_LOGIN_UNAVAILABLE', async () => {
    const { ctx: c } = ctx({ isConnected: () => false });
    expect(await handleAutofillLogin([], c)).toContain('AUTOFILL_LOGIN_UNAVAILABLE');
  });

  test('no password field → NO_LOGIN_FORM', async () => {
    const { ctx: c } = ctx({ detectBefore: { hasPassword: false } });
    expect(await handleAutofillLogin([], c)).toContain('NO_LOGIN_FORM');
  });

  test('not consented → CONSENT_REQUIRED, fires a notification, never clicks', async () => {
    const { ctx: c, notified, clicks } = ctx({ isConsented: () => false });
    const out = await handleAutofillLogin([], c);
    expect(out).toContain('CONSENT_REQUIRED');
    expect(notified.length).toBe(1);
    expect(clicks.length).toBe(0); // never submits without consent
  });

  test('consented + password gone after submit → LOGGED_IN (and it clicked submit)', async () => {
    const { ctx: c, clicks } = ctx();
    const out = await handleAutofillLogin([], c);
    expect(out).toContain('LOGGED_IN');
    expect(clicks).toContain('[data-nc-login-submit="1"]');
  });

  test('consented + 2FA page → TWOFA_REQUIRED', async () => {
    const { ctx: c } = ctx({ afterText: 'Enter the verification code', detectAfter: { hasPassword: false } });
    expect(await handleAutofillLogin([], c)).toContain('TWOFA_REQUIRED');
  });

  test('consented + still on login → LOGIN_FAILED', async () => {
    const { ctx: c } = ctx({ afterUrl: 'https://x.com/login', afterText: 'Invalid password', detectAfter: { hasPassword: true, submitSelector: '[data-nc-login-submit="1"]' } });
    expect(await handleAutofillLogin([], c)).toContain('LOGIN_FAILED');
  });

  test('a bridge error (SESSION_LOST) returns clean text, never throws into the route', async () => {
    const { ctx: c } = ctx({ dispatch: async () => { throw new Error('SESSION_LOST: no bound tab — run a goto first'); } });
    const out = await handleAutofillLogin([], c);
    expect(out).toContain('AUTOFILL_LOGIN_ERROR');
    expect(out).toContain('bound tab');
  });

  test('post-submit reads retry across the navigation (transient "navigated or closed")', async () => {
    // The submit navigates; the first post-submit reads fail with the CDP target
    // error, then the new (secure) page settles and reads succeed → LOGGED_IN.
    let phase: 'before' | 'after' = 'before';
    let postReads = 0;
    const c: LoginAutofillCtx = {
      isConnected: () => true,
      isConsented: () => true,
      sleep: () => Promise.resolve(),
      notify: () => {},
      dispatch: async (cmd, args) => {
        if (cmd === 'click') { phase = 'after'; return true; }
        const e = args[0] || '';
        if (phase === 'before') {
          if (e === 'location.href') return 'https://x.com/login';
          if (e.includes('password') || e.includes('data-nc-login')) return JSON.stringify({ hasPassword: true, username: 'jane', submitSelector: '[data-nc-login-submit="1"]' });
          return '';
        }
        // After submit: first round of reads throws (mid-navigation), then succeeds.
        postReads++;
        if (postReads <= 2) throw new Error('{"code":-32000,"message":"Inspected target navigated or closed"}');
        if (cmd === 'text') return 'You logged into a secure area';
        if (e === 'location.href') return 'https://x.com/secure';
        if (e.includes('password') || e.includes('data-nc-login')) return JSON.stringify({ hasPassword: false });
        return '';
      },
    };
    expect(await handleAutofillLogin([], c)).toContain('LOGGED_IN');
  });
});
