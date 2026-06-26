/**
 * [INPUT]: Depends on stealth.ts for CDP patches and Chromium resolution,
 *          getChromium() for lazy Playwright import
 * [OUTPUT]: Exports handoff/resume/login-detection method implementations
 * [POS]: Headed-mode lifecycle within browser engine (headless <-> headed transitions)
 *
 * These functions are assigned to BrowserManager.prototype by browser-manager.ts.
 * They use `this: any` to avoid circular imports -- the caller guarantees `this`
 * is a BrowserManager instance.
 */

import type { BrowserContext } from 'playwright';
import { DEFAULT_USER_AGENT, findChromiumExecutable, applyStealthPatches } from './stealth';
import { isHostile, HostileDomainError } from './hostile-domains';
import { eTldPlusOne, readConsent, isApproved, defaultConsentPath } from './handoff-consent';
import { decidePoll, initialPollState, defaultPollOptions } from './handoff-poll';
import { tryAutoImportForWall, collectLoginHostsFromPage } from './handoff-cookie-import';
import { notifyWithAction, focusAppAction } from './notify';
import { isPinned, pinnedVendor, markPinnedObserved } from './fingerprint-pinned';
import { parseEngineConfig } from './engine-config';
import { launchCloakBrowser } from './cloakbrowser-engine';
import { DEFAULT_SESSION_ID } from './session-id';
import { checkpointSession, flushNativeProfile } from './session-store';

function exitOnUnexpectedDisconnect(code: number): void {
  if (process.env.NIGHTCRAWL_NO_EXIT_ON_DISCONNECT === '1') return;
  process.exit(code);
}

function noExitOnUnexpectedDisconnect(): boolean {
  return process.env.NIGHTCRAWL_NO_EXIT_ON_DISCONNECT === '1';
}

// ─── SSO Redirect Stripper ──────────────────────────────────
// SSO redirect URLs carry one-time query tokens (SAML execution keys,
// OAuth state/code pairs, Shibboleth SAMLRequest nonces).  Re-navigating
// to them after a cookie import always starts a fresh login form — even
// when the server-side session is fully valid.  Strip the query so
// the redirect host becomes the test destination, which allows the IdP
// to complete the flow via the existing session cookie.
//
// Patterns stripped:
//   SAML / Shibboleth:  execution=eXsX
//   OAuth 2 / OIDC:     state=, code=, id_token=, access_token=
//   Generic SSO:        SAMLRequest=, RelayState=, SAMLResponse=
//   Microsoft / ADFS:   wctx=, wtrealm=, wreply=
const SSO_QUERY_PARAMS = /\b(execution|SAMLRequest|SAMLResponse|RelayState|state|code|id_token|access_token|wctx|wtrealm|wreply)=/i;

function stripSSORedirect(url: string): string {
  try {
    const parsed = new URL(url);
    if (SSO_QUERY_PARAMS.test(parsed.search)) {
      // Return just the origin + path — strip all SSO query tokens.
      return `${parsed.origin}${parsed.pathname}`;
    }
  } catch {}
  return url;
}

// Re-exported by browser-manager.ts so getChromium is available without circular dep.
// The actual getChromium is passed via the setup function below.
let _getChromium: () => Promise<typeof import('playwright').chromium>;

/** Called by browser-manager.ts to inject getChromium without circular import. */
export function _setupHandoff(getChromiumFn: typeof _getChromium): void {
  _getChromium = getChromiumFn;
}

// ─── Headed Mode Launch ─────────────────────────────────────
export async function launchHeaded(this: any, authToken?: string): Promise<void> {
  await applyStealthPatches();
  process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding';

  this.tabs.reset();

  const extensionMode = process.env.BROWSE_EXTENSIONS || 'all';
  const extensionPath = extensionMode !== 'none' ? this.findExtensionPath() : null;
  const launchArgs = ['--hide-crash-restore-bubble', '--disable-blink-features=AutomationControlled'];
  if (extensionPath) {
    launchArgs.push(`--disable-extensions-except=${extensionPath}`);
    launchArgs.push(`--load-extension=${extensionPath}`);
    if (authToken) {
      const fs = require('fs');
      const path = require('path');
      const authFile = path.join(extensionPath, '.auth.json');
      try {
        fs.writeFileSync(authFile, JSON.stringify({ token: authToken }), { mode: 0o600 });
      } catch (err: any) {
        console.warn(`[browse] Could not write .auth.json: ${err.message}`);
      }
    }
  }

  const fs = require('fs');
  const path = require('path');
  const userDataDir = path.join(process.env.HOME || '/tmp', '.nightcrawl', 'chromium-profile');
  fs.mkdirSync(userDataDir, { recursive: true });

  // Engine selection: use the SAME engine as the headless session so
  // cookies minted here stay valid when CloakBrowser resumes headless.
  // Bot-managed sites pin sessions to browser fingerprint, so launching
  // headed mode in Chrome-for-Testing while headless runs CloakBrowser
  // means every headed login is wasted — the cookies die on replay.
  const engineConfig = parseEngineConfig();
  const { context } = await launchCloakBrowser({
    headless: false,
    userDataDir,
    extensionsDir: extensionPath ?? undefined,
    fingerprintSeed: engineConfig.fingerprintSeed,
    humanize: engineConfig.humanize,
    viewport: undefined,
  });
  this.context = context;
  console.log(`[nightcrawl] Headed engine: CloakBrowser (seed: ${engineConfig.fingerprintSeed ?? 'random'})`);
  this.browser = this.context.browser();
  this.connectionMode = 'headed';
  this.intentionalDisconnect = false;

  // Inject visual indicator -- subtle top-edge amber gradient
  const indicatorScript = () => {
    const injectIndicator = () => {
      if (document.getElementById('nightcrawl-ctrl')) return;

      const topLine = document.createElement('div');
      topLine.id = 'nightcrawl-ctrl';
      topLine.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; height: 2px;
        background: linear-gradient(90deg, #F59E0B, #FBBF24, #F59E0B);
        background-size: 200% 100%;
        animation: nightcrawl-shimmer 3s linear infinite;
        pointer-events: none; z-index: 2147483647;
        opacity: 0.8;
      `;

      const style = document.createElement('style');
      style.textContent = `
        @keyframes nightcrawl-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          #nightcrawl-ctrl { animation: none !important; }
        }
      `;

      document.documentElement.appendChild(style);
      document.documentElement.appendChild(topLine);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectIndicator);
    } else {
      injectIndicator();
    }
  };
  // Persistent context opens a default page -- adopt it
  const existingPages = this.context.pages();
  if (existingPages.length > 0) {
    const page = existingPages[0];
    const id = this.tabs.add(page);
    this.wirePageEvents(page, id);
    try { await page.evaluate(indicatorScript); } catch {}
  } else {
    await this.newTab();
  }

  if (this.browser) {
    this.browser.on('disconnected', () => {
      if (this.intentionalDisconnect) return;
      console.error('[browse] Real browser disconnected (user closed or crashed).');
      console.error('[browse] Run `$B connect` to reconnect.');
      exitOnUnexpectedDisconnect(2);
    });
  }

  this.dialogAutoAccept = false;
  this.isHeaded = true;
  this.consecutiveFailures = 0;
}

// ─── Handoff: Headless -> Headed ────────────────────────────
/**
 * Hand off browser control to the user by relaunching in headed mode.
 *
 * Flow (launch-first-close-second for safe rollback):
 *   1. Save state from current headless browser
 *   2. Launch NEW headed browser
 *   3. Restore state into new browser
 *   4. Close OLD headless browser
 *   If step 2 fails -> return error, headless browser untouched
 */
export async function handoff(this: any, message: string): Promise<string> {
  if (this.connectionMode === 'headed' || this.isHeaded) {
    return `HANDOFF: Already in headed mode at ${this.getCurrentUrl()}`;
  }
  if (!this.browser || !this.context) {
    throw new Error('Browser not launched');
  }

  const currentUrl = this.getCurrentUrl();
  const stateBeforeHandoff = await this.saveState().catch(() => null);

  // Checkpoint discipline: snapshot the live cookies AND nudge Chromium's
  // SQLite WAL flush BEFORE we close + SIGKILL. The kill below would otherwise
  // race Chromium's lazy flush and drop freshly-imported (in-memory) cookies —
  // the exact Session 10 headless→headed loss. checkpointSession is the
  // durable guarantee; flushNativeProfile is the cheap native nudge.
  try {
    if (this.context) {
      const n = await checkpointSession(this.context);
      if (n > 0) console.log(`[nightcrawl] Checkpointed ${n} cookies before handoff close`);
      await flushNativeProfile(this.context);
    }
  } catch {}

  // SAFETY: refuse handoff to headed mode for hostile platforms.
  if (currentUrl && isHostile(currentUrl) && process.env.BROWSE_INCOGNITO !== '1') {
    const err = new HostileDomainError(currentUrl);
    return `ERROR: ${err.message}`;
  }

  const fs = require('fs');
  const path = require('path');
  const engineConfig = parseEngineConfig();

  // Close headless FIRST to release the profile lock. The persistent profile
  // handles durable browser state, but we also captured the in-memory context
  // above because recently imported cookies, sessionStorage, and SPA tab state
  // may not have flushed to Chromium's SQLite yet.
  this.intentionalDisconnect = true;
  if (this.browser) this.browser.removeAllListeners('disconnected');
  // Capture the Chromium PID before closing — if graceful close fails,
  // we SIGKILL the process tree to guarantee the profile lock is released.
  let chromiumPid: number | undefined;
  try {
    const browser = (this.context as any)?.browser?.();
    chromiumPid = browser?.process?.()?.pid;
  } catch {}
  try {
    if (this.context) {
      const browser = (this.context as any).browser?.();
      await Promise.race([
        this.context.close(),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]).catch(() => {});
      if (browser) { try { browser.close(); } catch {} }
    }
  } catch {}
  this.browser = null;
  this.context = null;
  this.tabs.clear();
  this.intentionalDisconnect = false;

  // If the Chromium process survived graceful close, escalate:
  // SIGTERM first (lets Chromium flush cookies to SQLite), then
  // SIGKILL as last resort. Without this, the headed launch hits
  // "Something went wrong when opening your profile."
  // SIGKILL alone was losing cookies — Arc-imported cookies in memory
  // never flushed to disk, so headed CloakBrowser opened logged-out.
  if (chromiumPid) {
    try {
      process.kill(chromiumPid, 0); // test if alive
      console.log(`[nightcrawl] Chromium PID ${chromiumPid} survived graceful close — sending SIGTERM`);
      process.kill(chromiumPid, 'SIGTERM');
      await new Promise(r => setTimeout(r, 2000));
      try {
        process.kill(chromiumPid, 0); // still alive?
        console.log(`[nightcrawl] PID ${chromiumPid} survived SIGTERM — sending SIGKILL`);
        process.kill(chromiumPid, 'SIGKILL');
        await new Promise(r => setTimeout(r, 500));
      } catch {} // dead after SIGTERM — good
    } catch {} // dead after graceful close — good
  }

  // Clean up Chromium's SingletonLock from the persistent profile.
  try {
    const lockFile = path.join(engineConfig.profileDir, 'SingletonLock');
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch {}

  let newContext: BrowserContext;
  try {
    const extensionMode = process.env.BROWSE_EXTENSIONS || 'all';
    const extensionPath = extensionMode !== 'none' ? this.findExtensionPath() : null;
    if (extensionPath) {
      if (this.serverPort) {
        try {
          const { resolveConfig } = require('./config');
          const config = resolveConfig();
          const stateFile = path.join(config.stateDir, 'browse.json');
          if (fs.existsSync(stateFile)) {
            const stateData = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            if (stateData.token) {
              fs.writeFileSync(path.join(extensionPath, '.auth.json'), JSON.stringify({ token: stateData.token }), { mode: 0o600 });
            }
          }
        } catch {}
      }
      console.log(`[nightcrawl] Handoff: loading extension from ${extensionPath}`);
    } else {
      console.log('[nightcrawl] Handoff: headed mode without side panel');
    }

    // Same persistent profile as headless — cookies survive the
    // headless→headed→headless cycle natively via Chromium's SQLite.
    this.headedUserDataDir = engineConfig.profileDir;

    const { context: cbContext } = await launchCloakBrowser({
      headless: false,
      userDataDir: engineConfig.profileDir,
      extensionsDir: extensionPath ?? undefined,
      fingerprintSeed: engineConfig.fingerprintSeed,
      humanize: engineConfig.humanize,
    });
    newContext = cbContext;
    console.log(`[nightcrawl] Handoff engine: CloakBrowser (seed: ${engineConfig.fingerprintSeed ?? 'random'})`);
  } catch (err: unknown) {
    // Headed launch failed — re-launch headless to recover.
    console.error(`[nightcrawl] Headed launch failed, recovering headless...`);
    try {
      const { context: recoveryCtx } = await launchCloakBrowser({
        headless: true,
        userDataDir: engineConfig.profileDir,
        fingerprintSeed: engineConfig.fingerprintSeed,
        humanize: false,
      });
      this.context = recoveryCtx;
      this.browser = recoveryCtx.browser();
      this.connectionMode = 'launched';
      if (this.browser) {
        this.browser.on('disconnected', () => {
          if (this.intentionalDisconnect) return;
          if (noExitOnUnexpectedDisconnect()) {
            console.error('[nightcrawl] Browser disconnected during recovery; process exit suppressed by NIGHTCRAWL_NO_EXIT_ON_DISCONNECT.');
          }
          exitOnUnexpectedDisconnect(1);
        });
      }
    } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    return `ERROR: Cannot open headed browser — ${msg}. Headless browser recovered.`;
  }

  this.context = newContext;
  this.browser = newContext.browser();
  this.tabs.clear();
  this.connectionMode = 'headed';
  this.isHeaded = true;
  this.dialogAutoAccept = false;

  if (Object.keys(this.extraHeaders).length > 0) {
    await newContext.setExtraHTTPHeaders(this.extraHeaders);
  }

  if (this.browser) {
    this.browser.on('disconnected', () => {
      if (this.intentionalDisconnect) return;
      if (noExitOnUnexpectedDisconnect()) {
        console.error('[browse] Browser disconnected; process exit suppressed by NIGHTCRAWL_NO_EXIT_ON_DISCONNECT.');
      } else {
        console.error('[browse] FATAL: Chromium process crashed or was killed. Server exiting.');
      }
      exitOnUnexpectedDisconnect(1);
    });
  }

  if (stateBeforeHandoff?.pages?.length) {
    for (const page of newContext.pages()) {
      await page.close().catch(() => {});
    }
    // Headless and headed use the same persistent Chromium profile, so we must
    // not clear-and-replace the profile's whole cookie jar during handoff. That
    // can stall the headed transition. Upsert the saved in-memory cookies only
    // so fresh cookies that have not flushed to SQLite are still preserved.
    await this.restoreState(stateBeforeHandoff, { cookieMode: 'add' });
  } else {
    // Navigate the headed browser to where the user was.
    const page = newContext.pages()[0] || await newContext.newPage();
    const tabId = this.tabs.add(page);
    this.wirePageEvents(page, tabId);
    if (currentUrl && currentUrl !== 'about:blank') {
      try { await page.goto(currentUrl, { waitUntil: 'load', timeout: 15000 }); } catch {}
    }
  }

  return [
    `HANDOFF: Browser opened at ${currentUrl}`,
    `MESSAGE: ${message}`,
    `STATUS: Waiting for user. Run 'resume' when done.`,
  ].join('\n');
}

// ─── Resume: Headed -> Headless ─────────────────────────────
/**
 * Resume AI control after user handoff.
 * Closes headed browser, relaunches headless with the same persistent
 * profile. Cookies survive natively via Chromium's SQLite — no manual
 * save/restore needed.
 */
export async function resume(this: any): Promise<string> {
  this.clearRefs();
  this.resetFailures();
  this.setFrame(null);

  if (!this.isHeaded || this.connectionMode !== 'headed') {
    return 'Resumed (already headless).';
  }

  const currentUrl = this.getCurrentUrl();
  const stateBeforeResume = await this.saveState().catch(() => null);

  // Checkpoint discipline (see handoff): snapshot + WAL-nudge before closing the
  // headed context, so cookies the user just earned by logging in survive the
  // headed→headless transition regardless of SQLite flush timing.
  try {
    if (this.context) {
      await checkpointSession(this.context);
      await flushNativeProfile(this.context);
    }
  } catch {}

  try {
    this.intentionalDisconnect = true;
    if (this.browser) this.browser.removeAllListeners('disconnected');
    try {
      if (this.context) {
        const browser = (this.context as any).browser?.();
        await Promise.race([
          this.context.close(),
          new Promise(resolve => setTimeout(resolve, 3000)),
        ]).catch(() => {});
        if (browser) {
          try { browser.close(); } catch {}
        }
      }
    } catch {}
    try {
      const { spawnSync } = require('child_process');
      spawnSync('pkill', ['-f', 'nightcrawl-handoff'], { timeout: 2000 });
    } catch {}

    this.browser = null;
    this.context = null;
    this.tabs.clear();
    this.connectionMode = 'launched';
    this.isHeaded = false;
    this.intentionalDisconnect = false;
    this.headedUserDataDir = null;

    const engineConfig = parseEngineConfig();
    // Clean up Chromium profile locks before re-launching. Headed shutdown can
    // leave any of these behind long enough for the immediate headless relaunch
    // to fail with "SingletonLock: File exists".
    try {
      const fs = require('fs');
      const path = require('path');
      for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try { fs.unlinkSync(path.join(engineConfig.profileDir, lockFile)); } catch {}
      }
    } catch {}

    const { context } = await launchCloakBrowser({
      headless: true,
      fingerprintSeed: engineConfig.fingerprintSeed,
      userDataDir: engineConfig.profileDir,
      humanize: false,
    });
    this.context = context;
    this.browser = (context as any).browser?.() ?? null;
    console.log(`[nightcrawl] Resumed headless via CloakBrowser (seed: ${engineConfig.fingerprintSeed ?? 'random'})`);

    if (this.browser) {
      this.browser.on('disconnected', () => {
        if (this.intentionalDisconnect) return;
        if (noExitOnUnexpectedDisconnect()) {
          console.error('[nightcrawl] Browser disconnected after resume; process exit suppressed by NIGHTCRAWL_NO_EXIT_ON_DISCONNECT.');
        } else {
          console.error('[nightcrawl] FATAL: Chromium process crashed or was killed. Server exiting.');
        }
        exitOnUnexpectedDisconnect(1);
      });
    }

    if (stateBeforeResume?.pages?.length) {
      for (const page of context.pages()) {
        await page.close().catch(() => {});
      }
      await this.restoreState(stateBeforeResume, { cookieMode: 'add' });
    } else {
      // Navigate to where the user was.
      const page = context.pages()[0] || await context.newPage();
      const tabId = this.tabs.add(page);
      this.wirePageEvents(page, tabId);
      if (currentUrl && currentUrl !== 'about:blank') {
        try { await page.goto(currentUrl, { waitUntil: 'load', timeout: 15000 }); } catch {}
      }
    }

    console.log(`[nightcrawl] Resumed headless at ${currentUrl} — cookies persisted via Chromium profile`);
    return `Resumed headless at ${currentUrl}. Cookies persisted natively via Chromium profile.`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[nightcrawl] Resume failed: ${msg}`);
    try {
      const chromium = await _getChromium();
      this.browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
      this.context = await this.browser.newContext({ viewport: { width: 1920, height: 1080 } });
      await this.newTab();
    } catch {}
    return `Resume partially failed: ${msg}. Headless browser relaunched (clean state).`;
  }
}

// ─── Headed State Accessors ─────────────────────────────────
export function getIsHeaded(this: any): boolean {
  return this.isHeaded;
}

// ─── Failure Tracking (auto-handoff hint) ───────────────────
export function incrementFailures(this: any): void {
  this.consecutiveFailures++;
}

export function resetFailures(this: any): void {
  this.consecutiveFailures = 0;
}

export function getFailureHint(this: any): string | null {
  if (this.consecutiveFailures >= 3 && !this.isHeaded) {
    return `HINT: ${this.consecutiveFailures} consecutive failures. Consider using 'handoff' to let the user help.`;
  }
  return null;
}

// ─── Login Wall Detection ───────────────────────────────────
/**
 * Detect login walls, captchas, and auth barriers.
 * Returns detection result or null if no login wall found.
 *
 * Always runs (no env-var gate). The gate on *acting* is per-domain
 * consent — stored in ~/.nightcrawl/state/handoff-consent.json, keyed
 * by eTLD+1 with a TTL. Callers use `approved` to decide whether to
 * invoke autoHandover (pop a window) or surface a consent prompt.
 *
 * Why this shape: commit 520a253 used an env-var opt-in to prevent
 * surprise window-pops on quark.cn, but that punished well-behaved
 * domains (Canvas) by blocking autonomous handling. Consent-per-
 * domain honors both: unknown domains never pop, approved domains
 * run the full polling loop that makes SAML timing correct.
 * See memory/project_canvas_regression_2026_04_14.md.
 */
export async function detectLoginWall(
  this: any,
  sessionId: string = DEFAULT_SESSION_ID,
): Promise<{ detected: boolean; reason: string; domain: string; approved: boolean; turnstile?: boolean } | null> {
  if (this.isHeaded) return null;

  // Detect on the CALLER's tab — a non-default session (e.g. claude:<id> from
  // Claude Code) navigates its own tab, not the default one.
  const page = this.getPage(sessionId);
  if (!page) return null;
  const url = page.url();

  // Turnstile check runs once and is attached to whichever signal fires.
  // Detecting Turnstile on the login page is a strong fingerprint-pinning
  // signal — session cookies are bound to the browser that solved the
  // challenge, so Arc cookie import is architecturally useless.
  const hasTurnstile = await page.evaluate(() => {
    if (document.querySelector('[class*="cf-turnstile"], [id*="cf-turnstile"], [class*="cf-chl-widget"]')) return true;
    for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
      if ((iframe as HTMLIFrameElement).src?.includes('challenges.cloudflare.com')) return true;
    }
    const text = document.body?.innerText?.slice(0, 3000) || '';
    return /let us know you are human|verify you are human|cf-turnstile/i.test(text);
  }).catch(() => false);

  if (/[/=](login|signin|sign-in|auth|captcha|verify|sso)([^a-z0-9]|$)/i.test(url)) {
    return withConsent(url, { detected: true, reason: `Login URL detected: ${url}`, turnstile: hasTurnstile || undefined });
  }

  const hasLoginForm = await page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0' ||
        (el as HTMLElement).hidden ||
        el.getAttribute('aria-hidden') === 'true'
      ) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const checkDoc = (doc: Document): boolean => {
      const authInputs = doc.querySelectorAll('input[type="password"], input[type="tel"]');
      return Array.from(authInputs).some(input => isVisible(input));
    };
    const hasBlockingCopy = (doc: Document): boolean => {
      const text = doc.body?.innerText?.slice(0, 2500) || '';
      return /sign\s*in\s*to\s*continue|log\s*in\s*required|authentication\s*required|please\s*(sign|log)\s*in|请先登录|登录后|没有权限|扫码登录|验证码|captcha/i.test(text);
    };
    if (checkDoc(document) && hasBlockingCopy(document)) return true;
    for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const iframeDoc = (iframe as HTMLIFrameElement).contentDocument;
        if (iframeDoc && checkDoc(iframeDoc) && hasBlockingCopy(iframeDoc)) return true;
      } catch {}
    }
    return false;
  }).catch(() => false);

  if (hasLoginForm) {
    return withConsent(url, { detected: true, reason: `Login form detected at ${url}`, turnstile: hasTurnstile || undefined });
  }

  const hasQrLogin = await page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0' ||
        (el as HTMLElement).hidden ||
        el.getAttribute('aria-hidden') === 'true'
      ) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const qrSelectors = [
      'canvas[class*="qrcode"]', 'img[class*="qrcode"]', 'img[class*="qr-"]',
      '[class*="qrcode"]', '[class*="login-qrcode"]', '[id*="qrcode"]',
    ];
    return qrSelectors.some(sel => {
      const node = document.querySelector(sel);
      return node !== null && isVisible(node);
    });
  }).catch(() => false);

  if (hasQrLogin) {
    return withConsent(url, { detected: true, reason: `QR code login detected at ${url}`, turnstile: hasTurnstile || undefined });
  }

  const hasAuthBarrier = await page.evaluate(() => {
    const text = document.body?.innerText?.slice(0, 2000) || '';
    return /请登录|请先登录|登录后|登录\/注册后|扫码登录|关注公众号立即登录|手机号码登录|没有权限|sign\s*in\s*to\s*continue|log\s*in\s*required|authentication\s*required|验证码|captcha/i.test(text);
  }).catch(() => false);

  if (hasAuthBarrier) {
    return withConsent(url, { detected: true, reason: `Auth barrier text detected at ${url}`, turnstile: hasTurnstile || undefined });
  }

  return null;
}

/**
 * Decorate a raw detection with the approved/domain fields from the consent store.
 * Kept as a small helper so the four detection paths above stay symmetric.
 */
function withConsent(
  url: string,
  base: { detected: boolean; reason: string; turnstile?: boolean },
): { detected: boolean; reason: string; domain: string; approved: boolean; turnstile?: boolean } {
  const domain = eTldPlusOne(url);
  const store = readConsent(defaultConsentPath());
  const approved = isApproved(store, url);
  return { ...base, domain, approved };
}

// ─── Auto-Handover (fully automatic login cycle) ────────────
/**
 * 1. Detect login wall -> switch to headed mode
 * 2. Poll until user logs in (login wall disappears)
 * 3. Save cookies -> switch back to headless
 * No manual 'resume' needed.
 */
export async function autoHandover(
  this: any,
  targetUrl?: string,
  sessionId: string = DEFAULT_SESSION_ID,
): Promise<string | null> {
  // Wall URL comes from the CALLER's tab; the headed relaunch below is
  // whole-browser (tabs.reset → default-owned), so post-handoff stays default.
  const loginUrl = this.getCurrentUrl(sessionId);
  // The URL the user originally wanted to reach (e.g. canvas.uw.edu).
  // loginUrl is typically a SSO redirect URL whose tokens are one-time-use
  // (SAML: execution=eXsX, OAuth: state=&code=, Shibboleth: SAMLRequest=).
  // Re-navigating to these always triggers a fresh login form even when
  // the IdP session is valid. We must test cookies against the TARGET.
  // If the caller didn't supply targetUrl, derive it by stripping the SSO
  // query string — this generalises to Okta, ADFS, PingFederate, Shibboleth.
  const testUrl = targetUrl || stripSSORedirect(loginUrl);

  // SAFETY: refuse to open headed mode for hostile platforms.
  // The headed-mode user-data-dir loads ALL real cookies — this is exactly
  // the path that banned two real XHS accounts on 2026-04-09.
  // See hostile-domains.ts and project_xhs_account_ban_2026_04_09 memory.
  if (loginUrl && isHostile(loginUrl) && process.env.BROWSE_INCOGNITO !== '1') {
    const err = new HostileDomainError(loginUrl);
    console.error(`[nightcrawl] ${err.message}`);
    return `ERROR: ${err.message}`;
  }

  // CONSENT GATE: never pop a window on a domain the user hasn't approved.
  // Approval is per-eTLD+1 with TTL; see handoff-consent.ts.
  // Callers who reached autoHandover via the server's goto-autohandover
  // wiring already checked consent — this is defense-in-depth for direct
  // callers (tests, future meta-commands, etc.). See
  // memory/project_canvas_regression_2026_04_14.md for why the gate lives
  // here and not in an env var.
  if (loginUrl) {
    const store = readConsent(defaultConsentPath());
    if (!isApproved(store, loginUrl)) {
      const domain = eTldPlusOne(loginUrl);
      const msg = `CONSENT_REQUIRED: ${domain} — run 'grant-handoff ${domain}' to approve auto-handover for this domain.`;
      console.log(`[nightcrawl] ${msg}`);
      return msg;
    }
  }

  // ─── Default-Browser Path (preferred) ──────────────────────
  // Open the login URL in the user's actual browser (Arc/Chrome/etc).
  // Poll their cookie database for auth cookies landing.
  // If the user logs in their browser, we import cookies silently — no window pop.
  // Falls through to spawned-Chromium handoff if this doesn't work within 5 min.
  //
  // Privacy guarantee: cookies are read from the LOCAL SQLite database on disk.
  // They never leave the machine. The Keychain dialog (first time only) is macOS
  // protecting the browser's encryption key — it's the OS asking, not us sending.
  // See memory/project_privacy_promise.md.
  if (!process.env.SSH_TTY && process.platform === 'darwin') {
    const domain = eTldPlusOne(loginUrl);
    const pinned = isPinned(loginUrl);
    const vendor = pinnedVendor(loginUrl);

    // Even for pinned domains, try the default-browser path FIRST.
    // Session 8 proved Cloudflare's auth cookies (vses2, __cf_logged_in)
    // work fine when imported from Arc — only cf_clearance is fingerprint-
    // bound, and the auth session doesn't depend on it. Skipping Arc
    // import for pinned domains broke the seamless UX where the user logs
    // in on their default browser and nightcrawl stays in sync.
    {
      if (pinned) {
        console.log(
          `[nightcrawl] ${domain} is ${vendor}-protected — trying Arc cookie import first (auth cookies may still work).`,
        );
      } else {
        console.log(`[nightcrawl] Opening ${domain} in your default browser for login...`);
      }

      // Open testUrl (the user's intended destination), NOT loginUrl.
      // loginUrl is a stale SSO redirect URL with a one-time execution token —
      // opening it in Arc starts a NEW competing SAML flow that can invalidate
      // the user's existing Arc session. Opening the target lets Arc handle
      // SSO silently if the session is still live, or prompt MFA if expired.
      const openUrl = testUrl !== loginUrl ? testUrl : loginUrl;

      const approval = await notifyWithAction(
        `nightCrawl needs to log in`,
        `${domain} requires authentication. nightCrawl will open your browser for a quick login and resume automatically.`,
        { label: "Log In", onClick: `open "${openUrl.replace(/"/g, '\\"')}"` },
      );

      if (approval === 'rejected') {
        console.log(`[nightcrawl] User declined handoff for ${domain}.`);
        return `HANDOFF_DECLINED: ${domain} still requires authentication. No browser was opened.`;
      }
    }

    // Poll cookie database for auth cookies — ONLY for non-pinned domains.
    // Pinned domains short-circuit straight to headed-CloakBrowser below.
    const cookiePollTimeout = pinned ? 0 : 5 * 60 * 1000;
    const cookiePollInterval = 3000;
    const cookiePollStart = Date.now();
    let cookieLoginSucceeded = false;
    // Track whether any cookies were ever actually imported during the poll.
    // Only mark a domain as fingerprint-pinned when cookies WERE imported
    // but the wall persisted — that's the empirical signature of pinning.
    // If no cookies were ever imported (user not logged in to Arc, or no
    // matching domain cookies), that's "not logged in" not "fingerprint-pinned".
    // Canvas was falsely marked pinned because its Stale Request bug
    // looked like a failed import — we must not repeat that mistake.
    let cookiesWereEverImported = false;

    while (Date.now() - cookiePollStart < cookiePollTimeout) {
      await new Promise(resolve => setTimeout(resolve, cookiePollInterval));

      // Derive candidate hosts from the CURRENT page's DOM (iframes,
      // forms, scripts, login-ish anchors) — generalizes to any SSO
      // ecosystem, not just the hardcoded Western-IdP list. Catches
      // doubao → douyin, weibo → qq.com, etc. without a whitelist.
      // Empty on failure — tryAutoImportForWall falls back to the
      // heuristic list, same as before.
      const observedHosts = await collectLoginHostsFromPage(this.getPage());
      const importResult = await tryAutoImportForWall(
        loginUrl, testUrl, this.context!, undefined, observedHosts,
      );

      if (importResult.importedCount > 0) {
        cookiesWereEverImported = true;
        console.log(`[nightcrawl] Imported ${importResult.importedCount} cookies from ${importResult.browser}. Testing login...`);

        // Re-navigate to the TARGET (not the SSO redirect).
        // SSO redirect URLs contain a one-time execution=eXsX token —
        // re-navigating to them always starts a fresh login flow even with
        // valid session cookies. Navigating to the target lets the IdP
        // complete the SAML assertion using the fresh shib_idp_session.
        const page = this.getPage();
        if (page) {
          try {
            await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            // Post-handoff = headed browser, default-owned tab → default session.
            const detection = await detectLoginWall.call(this);
            if (!detection?.detected) {
              cookieLoginSucceeded = true;
              console.log(`[nightcrawl] Login wall cleared via default browser cookies. No window popped.`);
              break;
            }
          } catch {}
        }
      }
    }

    if (cookieLoginSucceeded) {
      return `Login completed via default browser cookie import for ${domain}. Zero windows opened.`;
    }

    if (!pinned && cookiesWereEverImported) {
      // Observational pinning: we imported cookies but the wall persisted
      // on re-navigation. That's the empirical signature of fingerprint
      // pinning (ttwid/cf_clearance bound to the issuing browser's
      // fingerprint). Mark so future visits skip the doomed Arc poll.
      // NOT triggered when no cookies were imported — that just means the
      // user isn't logged into the domain on their default browser.
      markPinnedObserved(loginUrl, 'cloudflare');
      console.log(`[nightcrawl] Imported cookies but wall persisted for ${domain} — marking as fingerprint-pinned.`);
    }
  }

  // ─── Fallback: Spawned Headed Chromium ─────────────────────
  // HARD GATE: do NOT pop a headed window silently. The user must
  // opt in via `nc open-handoff` (explicit CLI command) or by setting
  // BROWSE_AUTO_POP_HEADED=1 for this flow. Default is to return a
  // structured message the agent can relay so the user sees what's
  // about to happen BEFORE it happens.
  //
  // This replaces the previous behavior where autoHandover would pop
  // a CloakBrowser window as soon as the agent's goto resolved. That
  // UX was "windows jumping in front of your work without consent" —
  // the exact thing the no-silent-pops rule forbids.
  //
  // CRITICAL: Pinned domains are NOT exempt from this rule. Even if
  // Arc import is impossible, the user must still approve the window pop.
  const autoPop = process.env.BROWSE_AUTO_POP_HEADED === '1';
  if (!autoPop) {
    const domain = loginUrl ? eTldPlusOne(loginUrl) : 'site';
    const vendor = loginUrl ? pinnedVendor(loginUrl) : null;

    const reason = vendor
      ? `${domain} uses ${vendor} protection, so cookie sync alone won't work here.`
      : `Cookie sync from your browser didn't clear ${domain}.`;

    const cliPath = `${__dirname}/cli.ts`;
    const bunPath = process.execPath;
    const safeUrl = loginUrl.replace(/"/g, '\\"');

    const approval = await notifyWithAction(
      `nightCrawl needs to log in`,
      `${domain} requires authentication. ${reason} nightCrawl will open CloakBrowser for a one-time login and resume automatically.`,
      {
        label: "Log In",
        onClick: `"${bunPath}" run "${cliPath}" open-handoff "${safeUrl}"`,
      },
    );

    if (approval === 'rejected') {
      console.log(`[nightcrawl] User declined CloakBrowser handoff for ${domain}.`);
    }

    return approval === 'approved'
      ? `HANDOFF_APPROVED: Opening CloakBrowser for ${domain}. Will auto-resume when done.`
      : `HANDOFF_DECLINED: User chose not to open CloakBrowser for ${domain}.`;
  }

  const isPinnedDomain = isPinned(loginUrl);
  const logMsg = isPinnedDomain
    ? `[nightcrawl] Fingerprint-pinned domain — popping headed CloakBrowser for ${loginUrl}...`
    : `[nightcrawl] BROWSE_AUTO_POP_HEADED=1 set — popping headed CloakBrowser for ${loginUrl}...`;
  console.log(logMsg);

  const handoffDomain = eTldPlusOne(loginUrl);
  notifyWithAction(
    'nightCrawl is on it',
    `Opening CloakBrowser for ${handoffDomain}. Log in and I'll take it from there!`,
    focusAppAction('CloakBrowser', 'Focus Browser'),
  ).catch(() => {});

  const handoffResult = await this.handoff(
    `Login wall detected. Please log in. Will auto-resume when done.`
  );

  if (handoffResult.startsWith('ERROR')) return handoffResult;

  console.log('[nightcrawl] Waiting for user to log in (15s grace period, then polling)...');
  const maxWaitMs = 5 * 60 * 1000;
  const pollIntervalMs = 3000;
  const graceMs = 15000;
  const startTime = Date.now();

  await new Promise(resolve => setTimeout(resolve, graceMs));

  // Wait for the login wall to appear in headed mode before checking if it disappeared.
  // Without this, a slow-loading headed page would look "not blocked" and trigger
  // false-positive auto-resume.
  let loginWallSeen = false;
  const confirmWaitMs = 10000;
  const confirmStart = Date.now();
  while (Date.now() - confirmStart < confirmWaitMs) {
    const page = this.getPage();
    if (page) {
      const hasWall = await page.evaluate(() => {
        const qr = document.querySelector('[class*="qrcode"], [class*="qr-"], canvas[class*="qr"]');
        const text = document.body?.innerText?.slice(0, 2000) || '';
        const hasLoginText = /请登录|请先登录|登录后|扫码登录/i.test(text);
        const hasLoginForm = document.querySelectorAll('input[type="password"], input[type="tel"]').length > 0;
        return !!(qr || hasLoginText || hasLoginForm);
      }).catch(() => false);
      if (hasWall) { loginWallSeen = true; break; }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!loginWallSeen) {
    console.log('[nightcrawl] Login wall not found in headed mode — page may have changed. Skipping auto-resume polling.');
  }

  // Polling with URL-stability gate. The earlier ad-hoc loop concluded
  // "login complete" the moment URL changed off /login pattern + no wall.
  // That fired DURING multi-step IDP chains (Duo, FIDO, SAML callbacks)
  // before the SP set its session cookie -> snapshot captured incomplete
  // cookies -> next nav re-bounced. See handoff-poll.ts for the fix.
  const pollOpts = {
    ...defaultPollOptions(loginUrl),
    loginWallSeen,
    maxWaitMs,
  };
  const pollState = initialPollState(loginUrl);
  let pollAction: 'continue' | 'resume' | 'timeout' = 'continue';
  let pollReason = '';

  while (pollAction === 'continue' && Date.now() - startTime < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    const page = this.getPage();
    if (!page) continue;

    const currentUrl = await page.evaluate(() => location.href).catch(() => loginUrl);
    const hasWall = loginWallSeen
      ? await page.evaluate(() => {
          const qr = document.querySelector('[class*="qrcode"], [class*="qr-"], canvas[class*="qr"]');
          const text = document.body?.innerText?.slice(0, 2000) || '';
          const hasLoginText = /请登录|请先登录|登录后|扫码登录/i.test(text);
          const hasLoginForm = document.querySelectorAll('input[type="password"], input[type="tel"]').length > 0;
          return !!(qr || hasLoginText || hasLoginForm);
        }).catch(() => true)
      : false;

    const decision = decidePoll(
      { url: currentUrl, hasWall, elapsedMs: Date.now() - startTime },
      pollOpts,
      pollState,
    );
    pollAction = decision.action;
    pollReason = decision.reason;
  }

  if (pollAction === 'resume') {
    console.log(`[nightcrawl] Login complete (${pollReason}). Returning to headless...`);
  } else {
    console.log(`[nightcrawl] Login timeout (${maxWaitMs / 1000}s). Returning to headless with current state.`);
  }

  const resumeResult = await this.resume();
  return `${handoffResult}\n${resumeResult}`;
}
