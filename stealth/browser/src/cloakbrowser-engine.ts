/**
 * [INPUT]: Depends on cloakbrowser npm package, engine-config, fingerprint-profiles
 * [OUTPUT]: Exports launchCloakBrowser, buildCloakBrowserArgs, shouldSkipCdpPatches
 * [POS]: Alternative browser engine using CloakBrowser within browser module
 */

import type { Browser, BrowserContext } from 'playwright';
import type { BrowserEngine, EngineConfig } from './engine-config';

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

// ─── Args Builder ──────────────────────────────────────────

/**
 * Build Chrome args for CloakBrowser launch.
 * Fingerprint seed and extensions are passed as CLI flags.
 */
export function buildCloakBrowserArgs(opts: CloakBrowserLaunchOptions): string[] {
  const args: string[] = [
    '--disable-blink-features=AutomationControlled',
  ];

  if (opts.fingerprintSeed !== undefined) {
    args.push(`--fingerprint=${opts.fingerprintSeed}`);
  }

  if (opts.extensionsDir) {
    args.push(`--disable-extensions-except=${opts.extensionsDir}`);
    args.push(`--load-extension=${opts.extensionsDir}`);
  }

  return args;
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
 * Launch a browser via CloakBrowser.
 * Falls back to stock Playwright if CloakBrowser is unavailable.
 *
 * Returns { browser, context } — caller manages lifecycle.
 */
export async function launchCloakBrowser(
  opts: CloakBrowserLaunchOptions = {},
): Promise<{ browser: Browser | null; context: BrowserContext }> {
  const args = buildCloakBrowserArgs(opts);

  try {
    const cb = await import('cloakbrowser');

    // Persistent context needed for extensions (same as stock Playwright path)
    if (opts.extensionsDir || opts.userDataDir) {
      const userDataDir = opts.userDataDir || await createTempProfile();
      const context = await cb.launchPersistentContext({
        userDataDir,
        headless: opts.headless ?? true,
        args,
        humanize: opts.humanize,
        humanPreset: opts.humanPreset,
        userAgent: opts.userAgent,
        viewport: opts.viewport ?? { width: 1920, height: 1080 },
      });
      return { browser: context.browser(), context };
    }

    // Standard launch — isolated context
    const browser = await cb.launch({
      headless: opts.headless ?? true,
      args,
      humanize: opts.humanize,
      humanPreset: opts.humanPreset,
    });

    const context = await browser.newContext({
      userAgent: opts.userAgent,
      viewport: opts.viewport ?? { width: 1920, height: 1080 },
    });

    return { browser, context };
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
