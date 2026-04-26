/**
 * [INPUT]: cookie-import-browser, handoff-consent, eTldPlusOne
 * [OUTPUT]: Exports tryAutoImportForWall, syncAllCookies, defaultBrowserPriority, SSO_HELPER_DOMAINS
 * [POS]: Auto-import bridge for handoff flow within browser module
 *
 * Why this exists: nightCrawl is supposed to be the user's digital twin
 * — when it hits a login wall on a domain the user has approved
 * (~/.nightcrawl/state/handoff-consent.json), it should silently pull
 * fresh cookies from the user's default browser (which the user keeps
 * alive through normal browsing) instead of popping a window.
 *
 * Commit 520a253 added a hard "never run cookie-import-browser" rule
 * (skill + docs) to prevent surprise Keychain dialogs on unknown
 * domains. That over-corrected: it disabled the auto-import path
 * entirely, forcing every Canvas/Zhihu/etc. login through the headed
 * window flow even when the user already has a valid session in Arc.
 *
 * The right gate is per-domain consent (already present), not a blanket
 * never-import rule. This module wires that gate to the auto-import
 * action: approved domain + login wall = auto-import + retry, no window.
 *
 * One Keychain dialog the first time per browser, "Always Allow" it,
 * silent forever after. That matches the user's expectation: import
 * once, persistent thereafter.
 */

import type { BrowserContext, Page } from 'playwright';
import {
  importCookies,
  listDomains,
  findInstalledBrowsers,
  type BrowserInfo,
  type PlaywrightCookie,
} from './cookie-import-browser';
import { eTldPlusOne } from './handoff-consent';
import { HOSTILE_DOMAINS } from './hostile-domains';

// ─── SSO helper domains ─────────────────────────────────────

/**
 * Common SSO/identity providers that institutional logins redirect through.
 * When the user navigates to a consent-approved domain (e.g. uw.edu) and
 * gets bounced to one of these, we transitively trust the chain because
 * the bounce was triggered by the approved navigation.
 *
 * Conservative list — only widely-recognized identity providers, not
 * arbitrary third-party sites. Grow as new federated-auth ecosystems
 * surface.
 */
export const SSO_HELPER_DOMAINS = [
  'canvaslms.com',         // Canvas SSO router
  'instructure.com',       // Canvas central auth (iad.login.instructure.com etc.)
  'okta.com',              // Okta IdP
  'auth0.com',             // Auth0 IdP
  'microsoftonline.com',   // Azure AD / Entra
  'login.microsoft.com',   // MS login surface
  'login.live.com',        // MS personal accounts
  'duosecurity.com',       // Duo 2FA
  'accounts.google.com',   // Google OAuth
  'google.com',            // catches accounts.google.com too via eTLD+1
  'github.com',            // GitHub OAuth
];

// ─── Browser priority ───────────────────────────────────────

/**
 * Default browser priority for cookie source. Tries Arc first (popular
 * with power users), then Chrome, Brave, Edge. Whichever is installed
 * AND has cookies for the requested domain wins.
 *
 * Skips Firefox/Safari for now — Chromium-family browsers use the same
 * cookie format and Keychain entry, so prompting once for a Chromium
 * browser unlocks all of them in one dialog.
 */
export const DEFAULT_BROWSER_PRIORITY = ['arc', 'chrome', 'brave', 'edge'] as const;

/**
 * Pick the first installed browser from the priority list.
 * Returns null if none are installed.
 */
export function pickDefaultBrowser(): string | null {
  const installed = findInstalledBrowsers();
  const installedNames = new Set(installed.map(b => b.name.toLowerCase()));
  for (const name of DEFAULT_BROWSER_PRIORITY) {
    if (installedNames.has(name)) return name;
  }
  // Fall back to whichever was found first
  return installed[0]?.name?.toLowerCase() ?? null;
}

// ─── Domain candidate list builder ──────────────────────────

/**
 * Given the original navigation target + the wall URL we landed on,
 * compute the set of host_keys we should try to import from the user's
 * default browser.
 *
 * Strategy (preference order):
 *   1. **Observed hosts** — when the caller passes the eTLD+1 set
 *      collected from `page.on('framenavigated')` during the goto, we
 *      use those EXACT hosts. This catches arbitrary IDP chains
 *      (Shibboleth → Duo → custom SSO) without hardcoding them.
 *   2. **Heuristic fallback** — if no observed hosts (caller didn't
 *      track them, or navigation aborted before any frame committed),
 *      fall back to: eTLD+1 of target + eTLD+1 of wall URL + the
 *      `SSO_HELPER_DOMAINS` list. This is the original behavior, kept
 *      as a safety net.
 *
 * Returned domains are eTLD+1's. The actual host_key matching against
 * the browser's cookie DB is done by `discoverHostKeys`.
 */
export function buildCandidateDomains(
  targetUrl: string,
  wallUrl: string,
  observedHosts?: Iterable<string>,
): string[] {
  // ─── Path 1: observed hosts (preferred) ──────────────────────
  if (observedHosts) {
    const observed = new Set<string>();
    for (const host of observedHosts) {
      try { observed.add(eTldPlusOne(host)); } catch {}
    }
    if (observed.size > 0) {
      // Always include the target/wall eTLD+1 too — defensive in case the
      // framenavigated listener missed the very first commit.
      try { observed.add(eTldPlusOne(targetUrl)); } catch {}
      try { observed.add(eTldPlusOne(wallUrl)); } catch {}
      return [...observed];
    }
  }

  // ─── Path 2: heuristic fallback ──────────────────────────────
  const set = new Set<string>();
  try { set.add(eTldPlusOne(targetUrl)); } catch {}
  try { set.add(eTldPlusOne(wallUrl)); } catch {}
  for (const sso of SSO_HELPER_DOMAINS) set.add(sso);
  return [...set];
}

/**
 * For a list of candidate eTLD+1 domains, query the browser's cookie DB
 * (via listDomains) to find ALL exact host_keys whose eTLD+1 matches any
 * candidate. This is how we cover dynamic subdomains like
 * `7f032619-fbd5-41ee-ac6c-e629af79ebcd.iad.login.instructure.com`.
 */
export function discoverHostKeys(
  browser: string,
  candidates: string[],
): string[] {
  let domains: { domain: string; count: number }[];
  try {
    domains = listDomains(browser).domains;
  } catch {
    return [];
  }
  const candSet = new Set(candidates);
  const matches: string[] = [];
  for (const { domain } of domains) {
    let etld: string;
    try { etld = eTldPlusOne(domain); } catch { continue; }
    if (candSet.has(etld)) matches.push(domain);
  }
  return matches;
}

// ─── DOM-based login-host discovery ──────────────────────────

/**
 * Read the current page's DOM to discover which external domains are
 * involved in its login flow. Catches any SSO provider the page
 * actually references — no whitelist, no guessing.
 *
 * Sources (in order of specificity):
 *   - iframe[src]           — most SSO providers embed via iframe
 *   - form[action]          — classic POST-based auth
 *   - a[href] for any link that looks login/account related
 *   - script[src]           — the provider CDN (fallback signal)
 *
 * Returns eTLD+1 strings. Safe to pass straight into
 * `tryAutoImportForWall`'s observedHosts parameter. Returns an empty
 * array on any failure — the caller falls back to the heuristic
 * SSO_HELPER_DOMAINS list as a backstop.
 *
 * Why this is the right generalization: a prior version used a hand-
 * maintained SSO_HELPER_DOMAINS whitelist, which missed ByteDance
 * (doubao → douyin SSO), WeChat, Line, and any new IdP ecosystem.
 * Any site whose login flow we can see in the DOM now gets its
 * cookies imported correctly without code changes.
 */
export async function collectLoginHostsFromPage(page: any): Promise<string[]> {
  try {
    const urls: string[] = await page.evaluate(() => {
      const out = new Set<string>();
      const add = (s: string | null | undefined) => {
        if (s && /^https?:/.test(s)) out.add(s);
      };
      for (const el of Array.from(document.querySelectorAll('iframe'))) {
        add((el as HTMLIFrameElement).src);
      }
      for (const el of Array.from(document.querySelectorAll('form'))) {
        add((el as HTMLFormElement).action);
      }
      for (const el of Array.from(document.querySelectorAll('a[href]'))) {
        const href = (el as HTMLAnchorElement).href;
        // Only links with login-ish hints — avoid broadcast-adding
        // every footer link as a candidate.
        if (/login|signin|oauth|sso|auth|account|passport/i.test(href)) add(href);
      }
      for (const el of Array.from(document.querySelectorAll('script[src]'))) {
        add((el as HTMLScriptElement).src);
      }
      return [...out];
    });

    const etlds = new Set<string>();
    for (const u of urls) {
      try {
        const host = new URL(u).hostname;
        etlds.add(eTldPlusOne(host));
      } catch {}
    }
    return [...etlds];
  } catch {
    return [];
  }
}

// ─── Atomic cookie swap (Stale Request prevention) ──────────

/**
 * Clear cookies in the given context for every eTLD+1 in `etldPlusOnes`,
 * matching both the apex and any subdomain.
 *
 * Why: the headless browser may have walked partway through a SAML/
 * Shibboleth handshake and left behind half-written SP-side state
 * (_shibsession_*, JSESSIONID, RelayState). When we then import fresh
 * cookies from the user's real browser — which completed its OWN
 * handshake with a different RelayState — the SP sees two sessions at
 * once and aborts with "Stale Request" (UW Canvas 2026-04-20).
 *
 * The fix is to clear before import so the swap is atomic: headless
 * discards its stale state, inherits the real browser's state, nothing
 * mixed. Callers should invoke this with the SAME eTLD+1 set they pass
 * to `addCookies`, immediately before the add.
 *
 * Errors from `clearCookies` are swallowed per-domain so a transient
 * CDP hiccup on one domain can't abort the entire swap.
 */
export async function clearCookiesForDomains(
  context: { clearCookies: (filter?: { domain?: string | RegExp }) => Promise<void> },
  etldPlusOnes: string[],
): Promise<void> {
  for (const etld of etldPlusOnes) {
    // Escape regex metachars (dots especially), then match either the
    // apex or anything ending in ".<etld>". Anchored so "uw.edu" does
    // NOT match "uw.edu.evil.com" or "notuw.edu".
    const escaped = etld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp(`(^|\\.)${escaped}$`);
    try {
      await context.clearCookies({ domain: matcher });
    } catch {
      // Intentionally swallow — one bad domain must not abort the swap.
    }
  }
}

/**
 * Generalized atomic cookie swap — the single chokepoint all imports
 * that MIGHT collide with partial SAML/OIDC/SSO state must go through.
 *
 * `replaceCookiesFor` derives its clear-domain set directly from the
 * cookies being imported, so it cannot silently miss a new IdP. No
 * whitelist, no heuristic fallback, no pre-computed candidate list to
 * drift out of sync with reality.
 *
 * Contract:
 *   1. For every distinct eTLD+1 present in `cookies`, clear matching
 *      cookies in `context` (apex + all subdomains, anchored regex).
 *   2. Then addCookies(cookies) in one call.
 *   3. Errors from per-domain clears are swallowed so one failure
 *      cannot abort the swap.
 *
 * Any future cookie-merging path (manual CLI import, picker, handoff
 * auto-import, late-redirect re-import, etc.) should call this instead
 * of `context.addCookies` directly. That is the invariant.
 */
export async function replaceCookiesFor(
  context: {
    clearCookies: (filter?: { domain?: string | RegExp }) => Promise<void>;
    addCookies: (cookies: any[]) => Promise<void>;
  },
  cookies: any[],
): Promise<void> {
  if (!cookies || cookies.length === 0) return;

  // Deduplicate by (name, domain, path) — keep the last occurrence
  // (which is the newest when cookies come from context.cookies() or
  // from a merge of old-file + new-session). Without this, Playwright's
  // addCookies stores every entry, and stale duplicates (e.g. an old
  // cf_clearance from a previous session) get sent alongside the fresh
  // one, causing Cloudflare and other bot-managers to reject the request.
  const deduped = new Map<string, any>();
  for (const c of cookies) {
    const key = `${c.name}\0${c.domain}\0${c.path ?? '/'}`;
    const existing = deduped.get(key);
    if (!existing || (c.expires ?? 0) >= (existing.expires ?? 0)) {
      deduped.set(key, c);
    }
  }
  cookies = Array.from(deduped.values());

  const etlds = new Set<string>();
  for (const c of cookies) {
    const raw = typeof c?.domain === 'string' ? c.domain : '';
    if (!raw) continue;
    const host = raw.startsWith('.') ? raw.slice(1) : raw;
    try {
      etlds.add(eTldPlusOne(host));
    } catch {
      // Malformed domain on the cookie — skip the clear for this one,
      // Playwright will reject the bad cookie on addCookies if needed.
    }
  }

  await clearCookiesForDomains(context, [...etlds]);
  await context.addCookies(cookies);
}

// ─── Body-text SSO brand detection ───────────────────────────

/**
 * Map of SSO brand patterns (as they appear in page body text) to the
 * canonical auth domains we need to import from the user's default browser.
 *
 * Why this map exists: after clicking a gate button (登录), the SSO modal
 * often has NO iframes — providers like Douyin authenticate via JavaScript
 * click handlers with no detectable domain in the DOM structure.
 * collectLoginHostsFromPage returns nothing, so we fall back to reading the
 * visible TEXT for brand hints and mapping them to domains.
 *
 * Extend as new one-click ecosystems surface. Brands are the EXACT labels
 * the sites display, so the mapping is stable and reviewable.
 */
const SSO_BRAND_DOMAINS: Array<[RegExp, string[]]> = [
  [/抖音|TikTok/i,         ['douyin.com', 'snssdk.com']],
  [/微信|WeChat/i,          ['wx.qq.com', 'weixin.qq.com']],
  [/微博|Weibo/i,           ['weibo.com']],
  [/\bQQ\b/i,              ['qq.com']],
  [/百度|Baidu/i,           ['baidu.com']],
  [/支付宝|Alipay/i,        ['alipay.com']],
  [/GitHub/i,              ['github.com']],
  [/\bApple\b/i,           ['appleid.apple.com']],
  [/\bGoogle\b/i,          ['google.com']],
  [/\bFacebook\b/i,        ['facebook.com']],
  [/\bTwitter\b|X\.com/i,  ['x.com', 'twitter.com']],
];

/**
 * Scan page body text for SSO provider brand names (抖音, WeChat, etc.)
 * that appear in one-click login options. Returns the canonical auth
 * domains for every brand found.
 *
 * Supplements collectLoginHostsFromPage when the SSO modal has no iframes
 * or form actions — the brand name in visible text is the only signal.
 * Safe to combine with collectLoginHostsFromPage results; dedup happens
 * at the import step via discoverHostKeys.
 */
export async function collectSSOBrandDomains(page: any): Promise<string[]> {
  try {
    const bodyText: string = await page.evaluate(() => (document.body?.innerText) || '');
    const domains = new Set<string>();
    for (const [brandRe, brandDomains] of SSO_BRAND_DOMAINS) {
      if (brandRe.test(bodyText)) {
        for (const d of brandDomains) domains.add(d);
      }
    }
    return [...domains];
  } catch {
    return [];
  }
}

// ─── One-tap SSO button clicker ───────────────────────────────

/**
 * After the gate button is clicked (登录), find and click the first SSO
 * one-click login element ("抖音一键登录", "Sign in with Google", etc.).
 *
 * These are often SPAN/DIV elements, NOT <button> — clickLoginButton
 * would miss them. We search all common container types and click the
 * first near-leaf element whose text matches the one-click pattern.
 *
 * Uses the same Playwright-locator-primary / evaluate-fallback structure
 * as clickLoginButton. Returns the element text or null on failure.
 */
export async function clickOnetapButton(
  page: any,
  timeoutMs = 5000,
): Promise<string | null> {
  const onetapRe = /一键登录|Sign in with|Continue with|Log in with/i;

  // Evaluate path: walk the DOM and click the first near-leaf matching element.
  // Near-leaf = children.length ≤ 2 so we click the label, not its parent container.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const clicked: string | null = await page.evaluate(() => {
        const re = /一键登录|Sign in with|Continue with|Log in with/i;
        const sels = ['button', '[role="button"]', 'span', 'div', 'li', 'a'];
        for (const sel of sels) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            const text = (el.textContent || '').trim();
            if (re.test(text) && (el as HTMLElement).children.length <= 2 && text.length < 40) {
              (el as HTMLElement).click();
              return text;
            }
          }
        }
        return null;
      });
      if (clicked) return clicked;
    } catch {
      return null; // page gone — bail
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// ─── Click-through login button ──────────────────────────────

/**
 * Find the first prominent login button on the page and click it.
 *
 * Why this exists: some sites (ByteDance doubao, regional gates, etc.)
 * sit behind a "region-ban" or "enter site" page. The real SSO provider
 * iframe (Douyin one-click, WeChat, etc.) only becomes visible in the
 * DOM AFTER the user clicks that page's 登录 button. Until that click,
 * collectLoginHostsFromPage sees no SSO domains and tryAutoImportForWall
 * imports only the site's own cookies — which aren't enough to clear
 * the wall.
 *
 * Callers should:
 *   1. Call tryAutoImportForWall → still wall
 *   2. Call clickLoginButton(page) → returns text or null
 *   3. If non-null: await ~2s, re-run collectLoginHostsFromPage(page)
 *   4. Call tryAutoImportForWall again with the new observed hosts
 *
 * Uses page.evaluate so the click is synchronous in the page's event
 * loop — no fragile CSS selector strings, works across any framework.
 * Returns the clicked button's trimmed textContent, or null if nothing
 * was found / clicked / evaluate threw.
 */
export async function clickLoginButton(
  page: any,
  timeoutMs = 5000,
): Promise<string | null> {
  // Exact-match labels — short plain strings only.
  // Avoids clicking "Login to continue", "Sign in with 30-day trial", etc.
  const loginRe = /^(登录|login|sign\s*in|log\s*in|继续|continue)$/i;

  // Primary path: Playwright locator — designed for React/Vue SPAs.
  // It polls internally and waits for the element to be visible,
  // solving the "React hasn't rendered yet" race condition that
  // page.evaluate hits when called right after waitUntil:'load'.
  if (typeof page.locator === 'function') {
    try {
      const btn = page.locator('button, [role="button"]').filter({ hasText: loginRe });
      await btn.first().waitFor({ state: 'visible', timeout: timeoutMs });
      const text = await btn.first().textContent({ timeout: 1000 });
      await btn.first().click({ timeout: 2000 });
      return (text ?? '').trim() || null;
    } catch {
      // timed out or click failed — fall through to evaluate fallback
    }
  }

  // Fallback path: page.evaluate polling (for non-Playwright wrappers
  // like mock pages in unit tests, or future engine adapters).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const clicked: string | null = await page.evaluate(() => {
        const re = /^(登录|login|sign\s*in|log\s*in|继续|continue)$/i;
        const candidates: Element[] = [
          ...Array.from(document.querySelectorAll('button')),
          ...Array.from(document.querySelectorAll('[role="button"]')),
        ];
        for (const el of candidates) {
          const text = (el.textContent || '').trim();
          if (re.test(text)) { (el as HTMLElement).click(); return text; }
        }
        return null;
      });
      if (clicked) return clicked;
    } catch {
      return null; // page crashed/navigated away — bail
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// ─── The main entry point ───────────────────────────────────

export interface AutoImportResult {
  attempted: boolean;
  importedCount: number;
  hostKeys: string[];
  browser: string | null;
  error?: string;
}

/**
 * Try to silently import cookies from the user's default browser for
 * the eTLD+1 of the wall URL + SSO helper domains. Adds them to the
 * given Playwright BrowserContext.
 *
 * NEVER prompts (besides the one-time Keychain "Always Allow").
 * Returns a structured result so the caller can log + decide whether to
 * retry the navigation or fall through to the headed-window flow.
 */
export async function tryAutoImportForWall(
  targetUrl: string,
  wallUrl: string,
  context: BrowserContext,
  browser: string | null = pickDefaultBrowser(),
  observedHosts?: Iterable<string>,
): Promise<AutoImportResult> {
  if (!browser) {
    return { attempted: false, importedCount: 0, hostKeys: [], browser: null, error: 'no installed browser found' };
  }

  const candidates = buildCandidateDomains(targetUrl, wallUrl, observedHosts);
  const hostKeys = discoverHostKeys(browser, candidates);
  if (hostKeys.length === 0) {
    return { attempted: true, importedCount: 0, hostKeys: [], browser };
  }

  try {
    const result = await importCookies(browser, hostKeys);
    if (result.cookies.length > 0) {
      // Single chokepoint: derives clear-targets from the cookies
      // themselves. No whitelist, no way for a new IdP to slip past.
      // See replaceCookiesFor for the full contract.
      await replaceCookiesFor(context, result.cookies);
    }
    return {
      attempted: true,
      importedCount: result.cookies.length,
      hostKeys,
      browser,
    };
  } catch (err: any) {
    return {
      attempted: true,
      importedCount: 0,
      hostKeys,
      browser,
      error: err?.message ?? String(err),
    };
  }
}

// ─── Continuous background sync ──────────────────────────────

export function isHostileDomain(hostKey: string): boolean {
  const h = hostKey.toLowerCase().replace(/^\./, '');
  return HOSTILE_DOMAINS.some(suffix => {
    const s = suffix.toLowerCase();
    return h === s || h.endsWith('.' + s);
  });
}

// ─── Pure domain-diff logic (unit-testable) ──────────────────
// Given the host_keys present in the user's default browser and
// the eTLD+1s already in the nightCrawl cookie jar, return the
// host_keys that should be imported on this cycle. Hostile domains
// are dropped; duplicate eTLD+1s across arcDomains collapse to one.
export function computeNewDomainsToSync(
  arcDomains: { domain: string }[],
  currentEtlds: Set<string>,
): { newHostKeys: string[]; newEtlds: string[] } {
  const newHostKeys: string[] = [];
  const newEtlds = new Set<string>();
  for (const { domain } of arcDomains) {
    if (isHostileDomain(domain)) continue;
    try {
      const etld = eTldPlusOne(domain.replace(/^\./, ''));
      if (etld && !currentEtlds.has(etld) && !newEtlds.has(etld)) {
        newEtlds.add(etld);
        newHostKeys.push(domain);
      }
    } catch {}
  }
  return { newHostKeys, newEtlds: [...newEtlds] };
}

export interface SyncResult {
  importedCount: number;
  newDomains: string[];
  browser: string | null;
}

export async function syncAllCookies(
  context: BrowserContext,
  browser: string | null = pickDefaultBrowser(),
  syncMode: 'new-domains-only' | 'all-domains' = 'new-domains-only',
): Promise<SyncResult> {
  if (!browser) return { importedCount: 0, newDomains: [], browser: null };

  let arcDomains: { domain: string; count: number }[];
  try {
    arcDomains = listDomains(browser).domains;
  } catch {
    return { importedCount: 0, newDomains: [], browser };
  }
  if (arcDomains.length === 0) return { importedCount: 0, newDomains: [], browser };

  // When watching for Arc cookie changes (watch mode), sync ALL domains to ensure
  // fresh credentials (like cf_clearance after login) replace stale ones in persistent profile.
  // Otherwise (poll mode), only sync new domains to avoid redundant processing.
  let hostKeys: string[];
  let syncedDomains: string[];

  if (syncMode === 'all-domains') {
    hostKeys = arcDomains
      .filter(d => !isHostileDomain(d.domain))
      .map(d => d.domain)
      .slice(0, 200);
    syncedDomains = hostKeys;
  } else {
    const currentCookies = await context.cookies().catch(() => []);
    const currentEtlds = new Set<string>();
    for (const c of currentCookies) {
      try {
        const host = (c.domain || '').replace(/^\./, '');
        currentEtlds.add(eTldPlusOne(host));
      } catch {}
    }

    const { newHostKeys, newEtlds } = computeNewDomainsToSync(arcDomains, currentEtlds);
    hostKeys = newHostKeys;
    syncedDomains = newEtlds;
  }

  if (hostKeys.length === 0) {
    return { importedCount: 0, newDomains: [], browser };
  }

  let result;
  try {
    result = await importCookies(browser, hostKeys);
  } catch {
    return { importedCount: 0, newDomains: syncedDomains.slice(0, hostKeys.length), browser };
  }

  if (result.cookies.length > 0) {
    await replaceCookiesFor(context, result.cookies);
  }

  return {
    importedCount: result.cookies.length,
    newDomains: syncedDomains.slice(0, hostKeys.length),
    browser,
  };
}
