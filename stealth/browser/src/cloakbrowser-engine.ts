/**
 * [INPUT]: Depends on cloakbrowser npm package, engine-config
 * [OUTPUT]: Exports launchCloakBrowser, shouldSkipCdpPatches, patchScreencast
 * [POS]: Default browser engine using CloakBrowser within browser module
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import type { BrowserEngine } from './engine-config';

// ─── Types ─────────────────────────────────────────────────

export interface CloakBrowserLaunchOptions {
  fingerprintSeed?: number;
  extensionsDir?: string;
  userDataDir?: string;
  headless?: boolean;
  humanize?: boolean;
  humanPreset?: 'default' | 'careful';
  userAgent?: string;
  viewport?: { width: number; height: number };
  /**
   * BCP 47 locale (e.g. "zh-CN"). Passed through to the underlying
   * Playwright context as `locale` — this is the ONLY layer that
   * actually influences CloakBrowser's navigator.language /
   * navigator.languages, because CloakBrowser's C++ patches override
   * any JS-level defineProperty we'd try to apply later.
   */
  locale?: string;
}

// ─── CDP Patch Guard ───────────────────────────────────────

/**
 * CloakBrowser has its own CDP patches baked in.
 * Skip nightCrawl's manual CDP patches when using CloakBrowser.
 */
export function shouldSkipCdpPatches(engine: BrowserEngine): boolean {
  return engine === 'cloakbrowser';
}

// ─── Screencast Compat ────────────────────────────────────

/**
 * PW 1.59.1's BrowserContext.close() calls page.screencast.handlePageOrContextClose()
 * on every page (browserContext.js:414). CloakBrowser pages skip the Page constructor
 * that initializes screencast, causing a crash on close.
 *
 * Fix: wrap context.close() to patch all pages just before the real close runs.
 * This catches pages created at ANY time, not just at launch.
 * Exported for testing.
 */
export function patchScreencast(page: Page): void {
  const p = page as any;
  if (!p.screencast) {
    p.screencast = { handlePageOrContextClose: async () => {} };
  }
}

/**
 * Wrap context.close() to absorb the PW 1.59.1 screencast crash.
 *
 * Why catch instead of patch: Playwright's public Page objects differ from internal
 * server-side Page objects. Patching the public API doesn't reach the internal
 * `this.pages()` iterated in browserContext.js:414. The internal pages have no
 * public accessor. Catching is the only reliable fix without forking PW.
 *
 * The close itself succeeds — doClose() runs, resources are freed. The crash is a
 * non-critical cleanup callback on a feature (screencast) that was never activated.
 */
function patchContextClose(context: BrowserContext): void {
  const originalClose = context.close.bind(context);
  context.close = async (options?: any) => {
    try {
      return await originalClose(options);
    } catch (err: any) {
      if (err?.message?.includes('screencast')) {
        // Expected PW 1.59.1 + CloakBrowser incompatibility — safe to swallow
        return;
      }
      throw err; // Re-throw unexpected errors
    }
  };
}

// ─── Launch ────────────────────────────────────────────────

/**
 * Launch a browser via CloakBrowser's native API.
 * Falls back to stock Playwright if CloakBrowser is unavailable.
 *
 * CloakBrowser handles stealth args, fingerprinting, and UA internally
 * via C++ patches — we only pass through config, not manual flags.
 *
 * Returns { browser, context } — caller manages lifecycle.
 */
export async function launchCloakBrowser(
  opts: CloakBrowserLaunchOptions = {},
): Promise<{ browser: Browser | null; context: BrowserContext }> {
  try {
    const cb = await import('cloakbrowser');

    // Extra args: only extension loading (CloakBrowser handles stealth args)
    const extraArgs: string[] = [];
    if (opts.extensionsDir) {
      extraArgs.push(`--disable-extensions-except=${opts.extensionsDir}`);
      extraArgs.push(`--load-extension=${opts.extensionsDir}`);
    }

    // If user provides explicit seed, disable default stealth args and pass ours
    const hasSeed = opts.fingerprintSeed !== undefined;
    if (hasSeed) {
      extraArgs.push(`--fingerprint=${opts.fingerprintSeed}`);
    }

    // Locale override at the Chromium process level. CloakBrowser's
    // C++ patches seed navigator.language from --lang, not from the
    // Playwright `locale` option or any JS defineProperty — so to
    // override zh-CN etc. we have to pass the flag here. Must also
    // skip CloakBrowser's stealthArgs default when we set lang
    // ourselves, else CB can re-inject --lang=en-US and undo us.
    if (opts.locale) {
      extraArgs.push(`--lang=${opts.locale}`);
      // Chromium also reads --accept-lang for the default Accept-Language
      // header. We set this at the Playwright layer too via setExtraHTTPHeaders,
      // but --accept-lang covers any early request before that header lands.
      extraArgs.push(`--accept-lang=${opts.locale}`);
    }

    // Persistent context needed for extensions (same as stock Playwright path)
    if (opts.extensionsDir || opts.userDataDir) {
      const userDataDir = opts.userDataDir || await createTempProfile();
      const context = await cb.launchPersistentContext({
        userDataDir,
        headless: opts.headless ?? true,
        args: extraArgs.length ? extraArgs : undefined,
        stealthArgs: true, // ALWAYS keep CloakBrowser's stealth args. Passing an explicit --fingerprint seed doesn't mean we want to disable CB's other defenses (UA ordering, client hints, disable-automation flags). Turning them off broke CF bot-management on 2026-04-19 — CF returned 403 on /api/v4/login for our seed because the fingerprint patches were active but the arg-level protections weren't.
        humanize: opts.humanize,
        humanPreset: opts.humanPreset,
        viewport: opts.viewport ?? { width: 1920, height: 1080 },
        ...(opts.locale ? { locale: opts.locale } : {}),
      } as any);
      patchContextClose(context);
      return { browser: context.browser(), context };
    }

    // Standard launch — use launchContext for single-step browser+context
    const context = await cb.launchContext({
      headless: opts.headless ?? true,
      args: extraArgs.length ? extraArgs : undefined,
      stealthArgs: !hasSeed,
      humanize: opts.humanize,
      humanPreset: opts.humanPreset,
      viewport: opts.viewport ?? { width: 1920, height: 1080 },
      ...(opts.locale ? { locale: opts.locale } : {}),
    } as any);
    patchContextClose(context);

    return { browser: context.browser(), context };
  } catch (err) {
    // CloakBrowser is the default engine — failure must be LOUD, not silent
    console.error(`[nightcrawl] FATAL: CloakBrowser failed to launch: ${err}`);
    console.error(`[nightcrawl] Install: bun add cloakbrowser@latest`);
    console.error(`[nightcrawl] Falling back to stock Playwright (NO stealth patches)`);
    return launchPlaywrightFallback(opts);
  }
}

// ─── Fallback ──────────────────────────────────────────────

async function launchPlaywrightFallback(
  opts: CloakBrowserLaunchOptions,
): Promise<{ browser: Browser; context: BrowserContext }> {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch({
    headless: opts.headless ?? true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: opts.userAgent,
    viewport: opts.viewport ?? { width: 1920, height: 1080 },
  });
  return { browser, context };
}

async function createTempProfile(): Promise<string> {
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'nightcrawl-cloak-'));
}
