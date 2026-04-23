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
import { notify, notifyWithAction, focusAppAction } from './notify';
import { isPinned, pinnedVendor, markPinnedObserved } from './fingerprint-pinned';
import { parseEngineConfig } from './engine-config';
import { launchCloakBrowser } from './cloakbrowser-engine';

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

  this.pages.clear();
  this.refMap.clear();
  this.nextTabId = 1;

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

  if (engineConfig.engine === 'cloakbrowser') {
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
  } else {
    const chromiumPath = findChromiumExecutable();
    this.context = await (await _getChromium()).launchPersistentContext(userDataDir, {
      headless: false,
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
      args: launchArgs,
      viewport: null,
      ignoreDefaultArgs: [
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
      ],
    });
  }
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
  await this.context.addInitScript(indicatorScript);

  // Persistent context opens a default page -- adopt it
  const existingPages = this.context.pages();
  if (existingPages.length > 0) {
    const page = existingPages[0];
    const id = this.nextTabId++;
    this.pages.set(id, page);
    this.activeTabId = id;
    this.wirePageEvents(page);
    try { await page.evaluate(indicatorScript); } catch {}
  } else {
    await this.newTab();
  }

  if (this.browser) {
    this.browser.on('disconnected', () => {
      if (this.intentionalDisconnect) return;
      console.error('[browse] Real browser disconnected (user closed or crashed).');
      console.error('[browse] Run `$B connect` to reconnect.');
      process.exit(2);
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

  const state = await this.saveState();
  const currentUrl = this.getCurrentUrl();

  // SAFETY: refuse handoff to headed mode for hostile platforms.
  // The headed user-data-dir loads ALL real cookies; this is the
  // exact path that banned XHS accounts on 2026-04-09.
  if (currentUrl && isHostile(currentUrl) && process.env.BROWSE_INCOGNITO !== '1') {
    const err = new HostileDomainError(currentUrl);
    return `ERROR: ${err.message}`;
  }

  let newContext: BrowserContext;
  try {
    const fs = require('fs');
    const path = require('path');
    const extensionMode = process.env.BROWSE_EXTENSIONS || 'all';
    const extensionPath = extensionMode !== 'none' ? this.findExtensionPath() : null;
    const launchArgs = ['--hide-crash-restore-bubble', '--disable-blink-features=AutomationControlled'];
    if (extensionPath) {
      launchArgs.push(`--disable-extensions-except=${extensionPath}`);
      launchArgs.push(`--load-extension=${extensionPath}`);
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

    const userDataDir = await fs.promises.mkdtemp(
      path.join(require('os').tmpdir(), 'nightcrawl-handoff-')
    );
    // Record so BrowserManager.close() / emergencyCleanup() can pkill -f it
    // if context.close() hangs. Without this the headed Chromium outlives
    // the daemon (P1 orphan-window bug, HANDOFF.md).
    this.headedUserDataDir = userDataDir;

    // Engine selection: the handoff MUST use the same engine as the
    // headless daemon. Mixing engines means the login cookies are minted
    // against Chrome-for-Testing's fingerprint but replayed by CloakBrowser
    // — bot-managed edges reject them and the user gets stuck re-logging
    // every session. See memory/project_cloakbrowser_default_decision.md.
    const engineConfig = parseEngineConfig();
    if (engineConfig.engine === 'cloakbrowser') {
      const { context: cbContext } = await launchCloakBrowser({
        headless: false,
        userDataDir,
        extensionsDir: extensionPath ?? undefined,
        fingerprintSeed: engineConfig.fingerprintSeed,
        humanize: engineConfig.humanize,
      });
      newContext = cbContext;
      console.log(`[nightcrawl] Handoff engine: CloakBrowser (seed: ${engineConfig.fingerprintSeed ?? 'random'})`);
    } else {
      const chromiumPath = findChromiumExecutable();
      newContext = await (await _getChromium()).launchPersistentContext(userDataDir, {
        headless: false,
        ...(chromiumPath ? { executablePath: chromiumPath } : {}),
        chromiumSandbox: process.platform !== 'win32',
        args: launchArgs,
        viewport: null,
        ignoreDefaultArgs: [
          '--disable-extensions',
          '--disable-component-extensions-with-background-pages',
          '--enable-automation',
        ],
        timeout: 30000,
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `ERROR: Cannot open headed browser — ${msg}. Headless browser still running.`;
  }

  try {
    const oldBrowser = this.browser;

    this.context = newContext;
    this.browser = newContext.browser();
    this.pages.clear();
    this.connectionMode = 'headed';

    if (Object.keys(this.extraHeaders).length > 0) {
      await newContext.setExtraHTTPHeaders(this.extraHeaders);
    }

    if (this.browser) {
      this.browser.on('disconnected', () => {
        if (this.intentionalDisconnect) return;
        console.error('[browse] FATAL: Chromium process crashed or was killed. Server exiting.');
        process.exit(1);
      });
    }

    await this.restoreState(state);
    this.isHeaded = true;
    this.dialogAutoAccept = false;

    oldBrowser.removeAllListeners('disconnected');
    oldBrowser.close().catch(() => {});

    return [
      `HANDOFF: Browser opened at ${currentUrl}`,
      `MESSAGE: ${message}`,
      `STATUS: Waiting for user. Run 'resume' when done.`,
    ].join('\n');
  } catch (err: unknown) {
    await newContext.close().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return `ERROR: Handoff failed during state restore — ${msg}. Headless browser still running.`;
  }
}

// ─── Resume: Headed -> Headless ─────────────────────────────
/**
 * Resume AI control after user handoff.
 * Saves cookies from headed session, relaunches headless, restores state.
 */
export async function resume(this: any): Promise<string> {
  this.clearRefs();
  this.resetFailures();
  this.activeFrame = null;

  if (!this.isHeaded || this.connectionMode !== 'headed') {
    return 'Resumed (already headless).';
  }

  let state: { cookies: any[]; pages: any[] };
  try {
    state = await Promise.race([
      this.saveState(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('saveState timeout')), 5000)),
    ]);
  } catch {
    console.warn('[nightcrawl] Could not save state from headed browser (closed/crashed). Resuming with empty state.');
    state = { cookies: [], pages: [] };
  }
  const currentUrl = this.getCurrentUrl();

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
    this.pages.clear();
    this.connectionMode = 'launched';
    this.isHeaded = false;
    this.intentionalDisconnect = false;
    this.headedUserDataDir = null;

    // Resume MUST use the same engine as the headed session.
    // Cookies minted by CloakBrowser's fingerprint become invalid if replayed
    // by a different Chromium binary — bot-managed edges reject them and the
    // login is wasted. Match engines: CloakBrowser headed → CloakBrowser headless.
    const engineConfig = parseEngineConfig();
    const ua = this.customUserAgent || DEFAULT_USER_AGENT;

    if (engineConfig.engine === 'cloakbrowser') {
      const { context } = await launchCloakBrowser({
        headless: true,
        fingerprintSeed: engineConfig.fingerprintSeed,
        humanize: false,
      });
      this.context = context;
      this.browser = (context as any).browser?.() ?? null;
      console.log(`[nightcrawl] Resumed headless via CloakBrowser (seed: ${engineConfig.fingerprintSeed ?? 'random'})`);
    } else {
      const chromium = await _getChromium();
      this.browser = await chromium.launch({
        headless: true,
        chromiumSandbox: process.platform !== 'win32',
        args: ['--disable-blink-features=AutomationControlled'],
      });
      this.context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: ua,
      });
      await this.context.setExtraHTTPHeaders({
        ...this.extraHeaders,
        'User-Agent': ua,
      });
    }

    if (this.browser) {
      this.browser.on('disconnected', () => {
        if (this.intentionalDisconnect) return;
        console.error('[nightcrawl] FATAL: Chromium process crashed or was killed. Server exiting.');
        process.exit(1);
      });
    }

    await this.restoreState(state);

    console.log(`[nightcrawl] Resumed headless at ${currentUrl} with ${state.cookies.length} cookies`);
    return `Resumed headless at ${currentUrl}. ${state.cookies.length} cookies preserved from login session.`;
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
  this: any
): Promise<{ detected: boolean; reason: string; domain: string; approved: boolean } | null> {
  if (this.isHeaded) return null;

  const page = this.getPage();
  if (!page) return null;
  const url = page.url();

  if (/[/=](login|signin|sign-in|auth|captcha|verify|sso)\b/i.test(url)) {
    return withConsent(url, { detected: true, reason: `Login URL detected: ${url}` });
  }

  const hasLoginForm = await page.evaluate(() => {
    const checkDoc = (doc: Document): boolean => {
      const pwInputs = doc.querySelectorAll('input[type="password"]');
      const telInputs = doc.querySelectorAll('input[type="tel"]');
      return pwInputs.length > 0 || telInputs.length > 0;
    };
    if (checkDoc(document)) return true;
    for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const iframeDoc = (iframe as HTMLIFrameElement).contentDocument;
        if (iframeDoc && checkDoc(iframeDoc)) return true;
      } catch {}
    }
    return false;
  }).catch(() => false);

  if (hasLoginForm) {
    return withConsent(url, { detected: true, reason: `Login form detected at ${url}` });
  }

  const hasQrLogin = await page.evaluate(() => {
    const qrSelectors = [
      'canvas[class*="qrcode"]', 'img[class*="qrcode"]', 'img[class*="qr-"]',
      '[class*="qrcode"]', '[class*="login-qrcode"]', '[id*="qrcode"]',
    ];
    return qrSelectors.some(sel => document.querySelector(sel) !== null);
  }).catch(() => false);

  if (hasQrLogin) {
    return withConsent(url, { detected: true, reason: `QR code login detected at ${url}` });
  }

  const hasAuthBarrier = await page.evaluate(() => {
    const text = document.body?.innerText?.slice(0, 2000) || '';
    return /请登录|请先登录|登录后|扫码登录|没有权限|sign\s*in\s*to\s*continue|log\s*in\s*required|authentication\s*required|验证码|captcha/i.test(text);
  }).catch(() => false);

  if (hasAuthBarrier) {
    return withConsent(url, { detected: true, reason: `Auth barrier text detected at ${url}` });
  }

  return null;
}

/**
 * Decorate a raw detection with the approved/domain fields from the consent store.
 * Kept as a small helper so the four detection paths above stay symmetric.
 */
function withConsent(
  url: string,
  base: { detected: boolean; reason: string },
): { detected: boolean; reason: string; domain: string; approved: boolean } {
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
export async function autoHandover(this: any, targetUrl?: string): Promise<string | null> {
  const loginUrl = this.getCurrentUrl();
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

    // Pinned domain: cookie import from default browser is ARCHITECTURALLY
    // useless (cookies are minted against the default browser's fingerprint,
    // CloakBrowser replays with a different one, edge rejects). Skip the
    // Arc-poll entirely and go straight to headed CloakBrowser — the only
    // path that mints cookies the headless engine can actually reuse.
    if (pinned) {
      console.log(
        `[nightcrawl] ${domain} is ${vendor}-protected (fingerprint-pinned). Skipping default-browser cookie import (cookies from another browser cannot authenticate here). Opening headed CloakBrowser directly.`,
      );
      notifyWithAction(
        'nightCrawl: login required',
        `${domain} is ${vendor}-protected — opening CloakBrowser so you can log in. The login must happen here so CloakBrowser can replay the session.`,
        focusAppAction('Chromium', 'Focus CloakBrowser'),
      );
      // Fall through to the spawned-CloakBrowser block below.
    } else {
      console.log(`[nightcrawl] Opening ${domain} in your default browser for login...`);

      // Open testUrl (the user's intended destination), NOT loginUrl.
      // loginUrl is a stale SSO redirect URL with a one-time execution token —
      // opening it in Arc starts a NEW competing SAML flow that can invalidate
      // the user's existing Arc session. Opening the target lets Arc handle
      // SSO silently if the session is still live, or prompt MFA if expired.
      const openUrl = testUrl !== loginUrl ? testUrl : loginUrl;

      // Gate vs auto-open: if BROWSE_NOTIFY_GATE=1, only notify; user clicks
      // "Open browser" to trigger. Default (unset/0) behaves as before —
      // open immediately and also notify. Gate mode is the less-intrusive
      // UX but requires terminal-notifier to be present; otherwise the
      // passive notification can't be clicked.
      const gated = process.env.BROWSE_NOTIFY_GATE === '1';

      notifyWithAction(
        'nightCrawl: log in',
        gated
          ? `${domain} needs a login. Click "Open browser" to start.`
          : `Opening ${domain} in your browser. Auto-resume when done.`,
        { label: 'Open browser', onClick: `open "${openUrl.replace(/"/g, '\\"')}"` },
      );

      if (!gated) {
        try {
          const { execSync } = await import('child_process');
          execSync(`open "${openUrl.replace(/"/g, '\\"')}"`, { timeout: 5000 });
        } catch (err: any) {
          console.warn(`[nightcrawl] Failed to open default browser: ${err?.message}`);
        }
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
            const detection = await detectLoginWall.call(this, page.url());
            if (!detection.detected) {
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
  const autoPop = process.env.BROWSE_AUTO_POP_HEADED === '1';
  if (!autoPop) {
    const domain = loginUrl ? eTldPlusOne(loginUrl) : 'site';
    const vendor = loginUrl ? pinnedVendor(loginUrl) : null;
    const body = vendor
      ? `${domain} is ${vendor}-protected — your default browser's session can't authenticate here. Run 'open-handoff' to launch a headed CloakBrowser window where you can log in. Cookies minted there will replay correctly in headless.`
      : `Default-browser cookies didn't clear ${domain}. Run 'open-handoff' to launch a headed CloakBrowser window for direct login.`;

    // Notification button runs the `open-handoff` meta-command via the
    // CLI. That connects back to this daemon over its unix socket and
    // triggers the headed-CloakBrowser launch exactly the same way the
    // env-var path does. One-click from notification to logged-in
    // window, no windows popping without user consent.
    const cliPath = `${__dirname}/cli.ts`;
    const bunPath = process.execPath; // the bun binary running this daemon
    const safeUrl = loginUrl.replace(/"/g, '\\"');
    notifyWithAction(
      'nightCrawl: headed login needed',
      body,
      {
        label: 'Open CloakBrowser',
        onClick: `"${bunPath}" run "${cliPath}" open-handoff "${safeUrl}"`,
      },
    );

    return [
      `HANDOFF_PENDING: ${domain} needs a headed login in CloakBrowser.`,
      `Click the notification's "Open CloakBrowser" button, or run:`,
      `  nc open-handoff ${loginUrl}`,
      `(Or set BROWSE_AUTO_POP_HEADED=1 to allow automatic pops.)`,
    ].join('\n');
  }

  console.log(`[nightcrawl] BROWSE_AUTO_POP_HEADED=1 set — popping headed CloakBrowser for ${loginUrl}...`);
  notifyWithAction(
    'nightCrawl: opening CloakBrowser',
    `Headed CloakBrowser opening for login at ${eTldPlusOne(loginUrl)}.`,
    focusAppAction('Chromium', 'Focus CloakBrowser'),
  );

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
