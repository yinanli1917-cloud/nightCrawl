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

    const chromium = await _getChromium();
    const ua = this.customUserAgent || DEFAULT_USER_AGENT;
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

    this.browser.on('disconnected', () => {
      if (this.intentionalDisconnect) return;
      console.error('[nightcrawl] FATAL: Chromium process crashed or was killed. Server exiting.');
      process.exit(1);
    });

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
 * Opt-in: only runs when BROWSE_AUTO_HANDOVER=1. Unset or any other value
 * disables handover so login walls are reported back to the agent instead of
 * silently popping a Chrome window. The agent can then ask the user for
 * permission before opting in for the rest of the session.
 */
export async function detectLoginWall(
  this: any
): Promise<{ detected: boolean; reason: string } | null> {
  if (this.isHeaded) return null;
  if (process.env.BROWSE_AUTO_HANDOVER !== '1') return null;

  const page = this.getPage();
  if (!page) return null;
  const url = page.url();

  if (/[/=](login|signin|sign-in|auth|captcha|verify|sso)\b/i.test(url)) {
    return { detected: true, reason: `Login URL detected: ${url}` };
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
    return { detected: true, reason: `Login form detected at ${url}` };
  }

  const hasQrLogin = await page.evaluate(() => {
    const qrSelectors = [
      'canvas[class*="qrcode"]', 'img[class*="qrcode"]', 'img[class*="qr-"]',
      '[class*="qrcode"]', '[class*="login-qrcode"]', '[id*="qrcode"]',
    ];
    return qrSelectors.some(sel => document.querySelector(sel) !== null);
  }).catch(() => false);

  if (hasQrLogin) {
    return { detected: true, reason: `QR code login detected at ${url}` };
  }

  const hasAuthBarrier = await page.evaluate(() => {
    const text = document.body?.innerText?.slice(0, 2000) || '';
    return /请登录|请先登录|登录后|扫码登录|没有权限|sign\s*in\s*to\s*continue|log\s*in\s*required|authentication\s*required|验证码|captcha/i.test(text);
  }).catch(() => false);

  if (hasAuthBarrier) {
    return { detected: true, reason: `Auth barrier text detected at ${url}` };
  }

  return null;
}

// ─── Auto-Handover (fully automatic login cycle) ────────────
/**
 * 1. Detect login wall -> switch to headed mode
 * 2. Poll until user logs in (login wall disappears)
 * 3. Save cookies -> switch back to headless
 * No manual 'resume' needed.
 */
export async function autoHandover(this: any): Promise<string | null> {
  const loginUrl = this.getCurrentUrl();

  // SAFETY: refuse to open headed mode for hostile platforms.
  // The headed-mode user-data-dir loads ALL real cookies — this is exactly
  // the path that banned two real XHS accounts on 2026-04-09.
  // See hostile-domains.ts and project_xhs_account_ban_2026_04_09 memory.
  if (loginUrl && isHostile(loginUrl) && process.env.BROWSE_INCOGNITO !== '1') {
    const err = new HostileDomainError(loginUrl);
    console.error(`[nightcrawl] ${err.message}`);
    return `ERROR: ${err.message}`;
  }

  console.log(`[nightcrawl] Switching to headed mode for login at ${loginUrl}...`);

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

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    const page = this.getPage();
    if (!page) continue;

    const currentUrl = await page.evaluate(() => location.href).catch(() => loginUrl);

    if (currentUrl !== loginUrl && !/[/=](login|signin|sign-in|auth|captcha|verify|sso)\b/i.test(currentUrl)) {
      console.log(`[nightcrawl] Login successful! URL changed to ${currentUrl}. Returning to headless...`);
      break;
    }

    if (loginWallSeen) {
      const stillBlocked = await page.evaluate(() => {
        const qr = document.querySelector('[class*="qrcode"], [class*="qr-"], canvas[class*="qr"]');
        const text = document.body?.innerText?.slice(0, 2000) || '';
        const hasLoginText = /请登录|请先登录|登录后|扫码登录/i.test(text);
        const hasLoginForm = document.querySelectorAll('input[type="password"], input[type="tel"]').length > 0;
        return qr || hasLoginText || hasLoginForm;
      }).catch(() => true);

      if (!stillBlocked) {
        console.log(`[nightcrawl] Login successful! Login wall disappeared. Returning to headless...`);
        break;
      }
    }
  }

  if (Date.now() - startTime >= maxWaitMs) {
    console.log('[nightcrawl] Login timeout (5min). Returning to headless with current state.');
  }

  const resumeResult = await this.resume();
  return `${handoffResult}\n${resumeResult}`;
}
