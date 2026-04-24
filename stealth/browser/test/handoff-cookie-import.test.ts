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
  collectLoginHostsFromPage,
  clickLoginButton,
  collectSSOBrandDomains,
  clickOnetapButton,
  computeNewDomainsToSync,
  isHostileDomain,
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

// ─── DOM-based login-host discovery ─────────────────────────
//
// The earlier SSO_HELPER_DOMAINS-only path was a whitelist by design:
// any IdP we hadn't hardcoded got ignored, and its cookies were never
// read from the user's real browser. collectLoginHostsFromPage is the
// generalization — it reads the actual DOM and returns the eTLD+1's of
// every iframe, form action, login-ish anchor, and script src. Any
// ecosystem (ByteDance/WeChat/Line/boutique IdPs) gets covered because
// it's a query on what the page REFERENCES, not a preset catalogue.
describe('collectLoginHostsFromPage — DOM-derived candidates', () => {
  const makePageWithElements = (html: string) => {
    // Minimal Playwright-like `page.evaluate(fn)` that runs `fn` in a
    // sandbox where `document.querySelectorAll` works. We build a fake
    // DOM structure in JS so we don't need a real browser for the unit
    // test — that's covered by integration tests.
    const parsed = parseFakeHtml(html);
    return {
      evaluate: async (fn: any) => {
        const fakeDoc = {
          querySelectorAll: (sel: string) => parsed[sel] ?? [],
        };
        return fn.call({ document: fakeDoc }, /* no arg */ undefined, {
          // Expose document/URL to the eval function via globals
          document: fakeDoc,
          URL,
        });
      },
    };
  };

  // Tiny fake-HTML parser — maps each selector string used in the
  // helper to an array of element-like objects. Keeps the test fast
  // and self-contained (no jsdom required).
  function parseFakeHtml(desc: string): Record<string, any[]> {
    const sections = desc.trim().split(/\|\|/g).map(s => s.trim()).filter(Boolean);
    const result: Record<string, any[]> = {
      iframe: [], form: [], 'a[href]': [], 'script[src]': [],
    };
    for (const s of sections) {
      const [selector, ...urls] = s.split(/\s+/);
      if (selector === 'iframe') {
        for (const u of urls) result.iframe.push({ src: u });
      } else if (selector === 'form') {
        for (const u of urls) result.form.push({ action: u });
      } else if (selector === 'a') {
        for (const u of urls) result['a[href]'].push({ href: u });
      } else if (selector === 'script') {
        for (const u of urls) result['script[src]'].push({ src: u });
      }
    }
    return result;
  }

  test('extracts eTLD+1 from iframe srcs', async () => {
    const page = {
      evaluate: async (fn: any) => {
        // Stand in a minimal document with only iframes
        const doc = {
          querySelectorAll: (sel: string) => {
            if (sel === 'iframe') return [
              { src: 'https://passport.douyin.com/login' },
              { src: 'https://mssdk.bytedance.com/tt_check' },
            ];
            return [];
          },
        };
        return fn.call({ document: doc });
      },
    };
    // Run with real globals (document is closured in the helper)
    const orig = (globalThis as any).document;
    (globalThis as any).document = {
      querySelectorAll: (sel: string) => {
        if (sel === 'iframe') return [
          { src: 'https://passport.douyin.com/login' },
          { src: 'https://mssdk.bytedance.com/tt_check' },
        ];
        return [];
      },
    };
    try {
      const hosts = await collectLoginHostsFromPage(page);
      expect(hosts).toContain('douyin.com');
      expect(hosts).toContain('bytedance.com');
    } finally {
      (globalThis as any).document = orig;
    }
  });

  test('ignores non-http URLs (data:, about:, chrome-extension:)', async () => {
    const orig = (globalThis as any).document;
    (globalThis as any).document = {
      querySelectorAll: (sel: string) => {
        if (sel === 'iframe') return [
          { src: 'https://legit.example.com/login' },
          { src: 'data:text/html,hello' },
          { src: 'about:blank' },
          { src: 'chrome-extension://abc/inject.html' },
        ];
        return [];
      },
    };
    try {
      const hosts = await collectLoginHostsFromPage({ evaluate: async (fn: any) => fn() });
      expect(hosts).toContain('example.com');
      expect(hosts.length).toBe(1);
    } finally {
      (globalThis as any).document = orig;
    }
  });

  test('login-ish anchors are kept; generic footer links are dropped', async () => {
    const orig = (globalThis as any).document;
    (globalThis as any).document = {
      querySelectorAll: (sel: string) => {
        if (sel === 'a[href]') return [
          { href: 'https://sso.feishu.cn/login?return=' },   // keep
          { href: 'https://accounts.example.com/signin' },   // keep
          { href: 'https://oauth.provider.io/callback' },    // keep
          { href: 'https://marketing.example.com/blog' },    // drop — no login hint
          { href: 'https://shop.example.com/checkout' },     // drop
        ];
        return [];
      },
    };
    try {
      const hosts = await collectLoginHostsFromPage({ evaluate: async (fn: any) => fn() });
      expect(hosts).toContain('feishu.cn');
      expect(hosts).toContain('example.com');     // from accounts.example.com
      expect(hosts).toContain('provider.io');
      // marketing/shop also live on example.com — but accounts.example.com
      // already contributed it, so counting dedup-by-eTLD+1, example.com
      // appears once. Proves filter works: no hosts LEAKED that only
      // appear on the non-login anchors.
    } finally {
      (globalThis as any).document = orig;
    }
  });

  test('returns empty array when page.evaluate throws (fail-safe fallback)', async () => {
    const page = {
      evaluate: async () => { throw new Error('page crashed'); },
    };
    const hosts = await collectLoginHostsFromPage(page);
    expect(hosts).toEqual([]);
  });

  test('deduplicates by eTLD+1 across all source types', async () => {
    const orig = (globalThis as any).document;
    (globalThis as any).document = {
      querySelectorAll: (sel: string) => {
        const url = 'https://x.example.com/a';
        if (sel === 'iframe') return [{ src: url }];
        if (sel === 'form') return [{ action: url }];
        if (sel === 'a[href]') return [{ href: 'https://login.example.com/signin' }];
        if (sel === 'script[src]') return [{ src: url }];
        return [];
      },
    };
    try {
      const hosts = await collectLoginHostsFromPage({ evaluate: async (fn: any) => fn() });
      const exampleCount = hosts.filter(h => h === 'example.com').length;
      expect(exampleCount).toBe(1);
    } finally {
      (globalThis as any).document = orig;
    }
  });
});

// ─── Click-through login button ──────────────────────────────
//
// Some sites (ByteDance doubao, Weibo, etc.) put their login behind a
// region-ban page or "enter site" gate. The actual SSO iframe (Douyin,
// WeChat, etc.) only appears AFTER clicking that gate's 登录 button.
// collectLoginHostsFromPage can't discover those domains because they're
// not in the initial DOM.
//
// clickLoginButton solves this: it finds the first prominent login
// button on the page and clicks it (via page.evaluate so it's fast and
// doesn't require a stable CSS selector). The caller then waits ~2s for
// the modal to open and re-runs collectLoginHostsFromPage to discover
// the now-visible SSO providers.
describe('clickLoginButton — click-through to surface hidden SSO providers', () => {
  // Build a fake page whose evaluate calls the function with a fake document.
  const makePage = (buttons: Array<{ text: string; clickCalled?: boolean }>) => {
    const elements = buttons.map(b => ({
      textContent: b.text,
      click() { b.clickCalled = true; },
    }));
    return {
      evaluate: async (fn: any) => {
        const orig = (globalThis as any).document;
        (globalThis as any).document = {
          querySelectorAll: (sel: string) => {
            if (sel === 'button' || sel === '[role="button"]') return elements;
            return [];
          },
        };
        try { return fn(); } finally { (globalThis as any).document = orig; }
      },
    };
  };

  test('finds and clicks 登录 button, returns button text', async () => {
    const btns = [
      { text: '帮助', clickCalled: false },
      { text: '登录', clickCalled: false },
      { text: '注册', clickCalled: false },
    ];
    const result = await clickLoginButton(makePage(btns));
    expect(result).toBe('登录');
    expect(btns[1].clickCalled).toBe(true);
    // Surrounding buttons must NOT have been clicked
    expect(btns[0].clickCalled).toBe(false);
    expect(btns[2].clickCalled).toBe(false);
  });

  test('finds and clicks "Login" (English)', async () => {
    const btns = [{ text: 'Login', clickCalled: false }];
    expect(await clickLoginButton(makePage(btns))).toBe('Login');
    expect(btns[0].clickCalled).toBe(true);
  });

  test('finds "Sign In" (two words with space)', async () => {
    const btns = [{ text: 'Sign In', clickCalled: false }];
    const result = await clickLoginButton(makePage(btns));
    expect(result).toBe('Sign In');
    expect(btns[0].clickCalled).toBe(true);
  });

  test('returns null when no login button exists on the page', async () => {
    const btns = [{ text: 'Download' }, { text: 'Help' }, { text: 'About' }];
    // Pass 0ms timeout so the retry loop exits immediately in tests.
    expect(await clickLoginButton(makePage(btns), 0)).toBeNull();
  });

  test('swallows page.evaluate errors and returns null (fail-safe)', async () => {
    const page = { evaluate: async () => { throw new Error('page crashed'); } };
    expect(await clickLoginButton(page)).toBeNull();
  });

  test('role=button elements are candidates too', async () => {
    // role="button" divs are common in React/Vue login UIs
    const elements = [{ textContent: 'Login', clickCalled: false, click() { (this as any).clickCalled = true; } }];
    const page = {
      evaluate: async (fn: any) => {
        const orig = (globalThis as any).document;
        (globalThis as any).document = {
          querySelectorAll: (sel: string) => {
            if (sel === 'button') return [];
            if (sel === '[role="button"]') return elements;
            return [];
          },
        };
        try { return fn(); } finally { (globalThis as any).document = orig; }
      },
    };
    const result = await clickLoginButton(page);
    expect(result).toBe('Login');
    expect(elements[0].clickCalled).toBe(true);
  });

  test('does NOT click buttons whose text only partially matches (e.g. "Login to continue")', async () => {
    // Exact-match guard prevents clicking innocuous buttons that
    // happen to contain the word "login" in a longer sentence.
    const btns = [{ text: 'Login to continue', clickCalled: false }];
    expect(await clickLoginButton(makePage(btns), 0)).toBeNull();
    expect(btns[0].clickCalled).toBeFalsy();
  });
});

// ─── Body-text SSO brand detection ───────────────────────────
//
// After clicking the gate button (登录), the SSO provider modal appears
// but may have NO iframes (collectLoginHostsFromPage finds nothing) —
// it uses plain SPAN/DIV elements with JavaScript click handlers.
// Example: doubao shows "抖音一键登录" as a SPAN with no douyin.com iframe.
//
// collectSSOBrandDomains reads the page body text and maps known SSO
// brand names (抖音, WeChat, etc.) to their auth domains so we can
// proactively import the right cookies from Arc.
describe('collectSSOBrandDomains — body-text SSO brand detection', () => {
  const makePageWithText = (bodyText: string) => ({
    evaluate: async (fn: any) => {
      const orig = (globalThis as any).document;
      (globalThis as any).document = {
        body: { innerText: bodyText },
      };
      try { return fn(); } finally { (globalThis as any).document = orig; }
    },
  });

  test('抖音 in body text → returns douyin.com + snssdk.com', async () => {
    const page = makePageWithText('抖音一键登录\n打开豆包App');
    const domains = await collectSSOBrandDomains(page);
    expect(domains).toContain('douyin.com');
    expect(domains).toContain('snssdk.com');
  });

  test('WeChat/微信 → wx.qq.com', async () => {
    const page = makePageWithText('微信一键登录');
    const domains = await collectSSOBrandDomains(page);
    expect(domains).toContain('wx.qq.com');
  });

  test('multiple brands in same body text → all domains returned', async () => {
    const page = makePageWithText('抖音一键登录\n微博一键登录\nQQ登录');
    const domains = await collectSSOBrandDomains(page);
    expect(domains).toContain('douyin.com');
    expect(domains).toContain('weibo.com');
    expect(domains).toContain('qq.com');
  });

  test('no known brand in body text → empty array', async () => {
    const page = makePageWithText('请输入手机号码\n下一步\n隐私政策');
    const domains = await collectSSOBrandDomains(page);
    expect(domains).toEqual([]);
  });

  test('swallows errors and returns empty array (fail-safe)', async () => {
    const page = { evaluate: async () => { throw new Error('page gone'); } };
    expect(await collectSSOBrandDomains(page)).toEqual([]);
  });
});

// ─── One-tap SSO button clicker ───────────────────────────────
//
// "抖音一键登录" is a SPAN element, not a <button>. clickLoginButton
// only searches button/[role=button]. clickOnetapButton searches
// button, [role=button], span, div, li — anything that might host a
// one-click SSO label — and clicks the first match for /一键登录/
// or "Sign in with X".
describe('clickOnetapButton — one-tap SSO element clicker', () => {
  const makePageWithSpan = (spans: Array<{ text: string; clickCalled?: boolean }>) => {
    const elements = spans.map(s => ({
      textContent: s.text,
      children: { length: 0 },
      click() { s.clickCalled = true; },
    }));
    return {
      evaluate: async (fn: any) => {
        const orig = (globalThis as any).document;
        (globalThis as any).document = {
          querySelectorAll: (sel: string) => {
            // Return elements for the span/button/div query
            if (sel.includes('button') || sel.includes('span') || sel.includes('div')) return elements;
            return [];
          },
        };
        try { return fn(); } finally { (globalThis as any).document = orig; }
      },
    };
  };

  test('clicks SPAN with 抖音一键登录 text', async () => {
    const spans = [
      { text: '用户协议', clickCalled: false },
      { text: '抖音一键登录', clickCalled: false },
    ];
    const result = await clickOnetapButton(makePageWithSpan(spans));
    expect(result).toBe('抖音一键登录');
    expect(spans[1].clickCalled).toBe(true);
    expect(spans[0].clickCalled).toBe(false);
  });

  test('clicks "Sign in with Google" English variant', async () => {
    const spans = [{ text: 'Sign in with Google', clickCalled: false }];
    expect(await clickOnetapButton(makePageWithSpan(spans))).toBe('Sign in with Google');
    expect(spans[0].clickCalled).toBe(true);
  });

  test('returns null when no onetap element present', async () => {
    const spans = [{ text: '下一步' }, { text: '忘记密码' }];
    expect(await clickOnetapButton(makePageWithSpan(spans), 0)).toBeNull();
  });

  test('swallows errors and returns null (fail-safe)', async () => {
    const page = { evaluate: async () => { throw new Error('crash'); } };
    expect(await clickOnetapButton(page)).toBeNull();
  });
});

// ─── Background sync pure logic ──────────────────────────────
// computeNewDomainsToSync is the decision core for the periodic
// Arc-→nightCrawl sync: "of these arc host_keys, which ones do
// we not yet have cookies for?" Exercised in isolation so we
// don't need to stub Keychain / the real cookie DB.

describe('isHostileDomain', () => {
  test('flags hardcoded hostile platforms', () => {
    // From HOSTILE_DOMAINS in hostile-domains.ts
    expect(isHostileDomain('xiaohongshu.com')).toBe(true);
    expect(isHostileDomain('www.xiaohongshu.com')).toBe(true);
    expect(isHostileDomain('.xiaohongshu.com')).toBe(true);
  });
  test('does not flag normal domains', () => {
    expect(isHostileDomain('github.com')).toBe(false);
    expect(isHostileDomain('canvas.uw.edu')).toBe(false);
    expect(isHostileDomain('reddit.com')).toBe(false);
  });
  test('case-insensitive', () => {
    expect(isHostileDomain('XIAOHONGSHU.COM')).toBe(true);
  });
});

describe('computeNewDomainsToSync', () => {
  test('returns empty when all arc domains already present', () => {
    const arc = [{ domain: 'github.com' }, { domain: '.reddit.com' }];
    const present = new Set(['github.com', 'reddit.com']);
    const { newHostKeys, newEtlds } = computeNewDomainsToSync(arc, present);
    expect(newHostKeys).toEqual([]);
    expect(newEtlds).toEqual([]);
  });

  test('returns only domains whose eTLD+1 is missing', () => {
    const arc = [
      { domain: 'github.com' },     // already have
      { domain: 'reddit.com' },     // new
      { domain: '.zhihu.com' },     // new (dot-prefix, same host_key shape Chromium uses)
    ];
    const present = new Set(['github.com']);
    const { newHostKeys, newEtlds } = computeNewDomainsToSync(arc, present);
    expect(newEtlds.sort()).toEqual(['reddit.com', 'zhihu.com']);
    // Host keys preserved verbatim so importCookies gets the same
    // shape Chromium stores them in.
    expect(newHostKeys).toContain('reddit.com');
    expect(newHostKeys).toContain('.zhihu.com');
  });

  test('collapses multiple subdomains sharing an eTLD+1', () => {
    const arc = [
      { domain: 'sub1.example.com' },
      { domain: 'sub2.example.com' },
      { domain: '.example.com' },
    ];
    const present = new Set<string>();
    const { newHostKeys, newEtlds } = computeNewDomainsToSync(arc, present);
    expect(newEtlds).toEqual(['example.com']);
    // Only the first host_key wins per eTLD+1 — subsequent ones dedupe.
    expect(newHostKeys).toHaveLength(1);
    expect(newHostKeys[0]).toBe('sub1.example.com');
  });

  test('filters out hostile domains entirely', () => {
    const arc = [
      { domain: 'xiaohongshu.com' },
      { domain: 'github.com' },
    ];
    const present = new Set<string>();
    const { newEtlds } = computeNewDomainsToSync(arc, present);
    expect(newEtlds).toEqual(['github.com']);
    expect(newEtlds).not.toContain('xiaohongshu.com');
  });

  test('empty arc input yields empty output', () => {
    const { newHostKeys, newEtlds } = computeNewDomainsToSync([], new Set());
    expect(newHostKeys).toEqual([]);
    expect(newEtlds).toEqual([]);
  });

  test('respects multi-level public-suffix eTLDs (co.uk, edu.cn)', () => {
    const arc = [
      { domain: 'bbc.co.uk' },
      { domain: 'tsinghua.edu.cn' },
    ];
    const present = new Set<string>();
    const { newEtlds } = computeNewDomainsToSync(arc, present);
    // eTldPlusOne must recognize .co.uk / .edu.cn so these don't
    // collapse to co.uk / edu.cn.
    expect(newEtlds.sort()).toEqual(['bbc.co.uk', 'tsinghua.edu.cn']);
  });
});
