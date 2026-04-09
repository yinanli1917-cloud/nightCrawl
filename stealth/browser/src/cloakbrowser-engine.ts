/**
 * [INPUT]: Depends on cloakbrowser npm package, engine-config
 * [OUTPUT]: Exports launchCloakBrowser, shouldSkipCdpPatches
 * [POS]: Alternative browser engine using CloakBrowser within browser module
 */

import type { Browser, BrowserContext } from 'playwright';
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
}

// ─── CDP Patch Guard ───────────────────────────────────────

/**
 * CloakBrowser has its own CDP patches baked in.
 * Skip nightCrawl's manual CDP patches when using CloakBrowser.
 */
export function shouldSkipCdpPatches(engine: BrowserEngine): boolean {
  return engine === 'cloakbrowser';
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

    // Persistent context needed for extensions (same as stock Playwright path)
    if (opts.extensionsDir || opts.userDataDir) {
      const userDataDir = opts.userDataDir || await createTempProfile();
      const context = await cb.launchPersistentContext({
        userDataDir,
        headless: opts.headless ?? true,
        args: extraArgs.length ? extraArgs : undefined,
        stealthArgs: !hasSeed, // let CloakBrowser handle args unless user overrides seed
        humanize: opts.humanize,
        humanPreset: opts.humanPreset,
        viewport: opts.viewport ?? { width: 1920, height: 1080 },
      });
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
    });

    return { browser: context.browser(), context };
  } catch (err) {
    console.warn(`[nightcrawl] CloakBrowser unavailable, falling back to Playwright: ${err}`);
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
