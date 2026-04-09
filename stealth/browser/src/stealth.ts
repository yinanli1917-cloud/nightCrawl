/**
 * [INPUT]: Depends on playwright-core/browsers.json for version detection,
 *          stealth/patches/cdp/ for CDP patch files
 * [OUTPUT]: Exports getDefaultUserAgent, findChromiumExecutable, applyStealthPatches, applyStealthScripts
 * [POS]: Stealth hardening layer within browser engine
 */

import type { BrowserContext } from 'playwright';

// ─── Realistic User-Agent ───────────────────────────────────
// Derives Chrome version from Playwright's bundled Chromium at runtime.
// When Playwright updates, the UA automatically matches.
function getChromiumVersion(): string {
  try {
    const path = require('path');
    const fs = require('fs');
    const browsersJson = path.resolve(__dirname, '..', 'node_modules', 'playwright-core', 'browsers.json');
    const data = JSON.parse(fs.readFileSync(browsersJson, 'utf-8'));
    const chromium = data.browsers?.find((b: any) => b.name === 'chromium');
    if (chromium?.browserVersion) {
      const major = chromium.browserVersion.split('.')[0];
      return `${major}.0.0.0`;
    }
  } catch {}
  return '145.0.0.0';
}

export const DEFAULT_USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${getChromiumVersion()} Safari/537.36`;

// ─── Chromium Binary Resolution ─────────────────────────────
/**
 * Find the correct Chromium binary for headed mode.
 * Matches revision to the installed playwright-core version to prevent crashes.
 */
export function findChromiumExecutable(): string | undefined {
  const fs = require('fs');
  const path = require('path');
  const cacheDir = path.join(process.env.HOME || '/tmp', 'Library', 'Caches', 'ms-playwright');

  let expectedRevision: string | undefined;
  try {
    const browsersJson = path.resolve(__dirname, '..', 'node_modules', 'playwright-core', 'browsers.json');
    const browsers = JSON.parse(fs.readFileSync(browsersJson, 'utf-8'));
    const chromium = browsers.browsers?.find((b: any) => b.name === 'chromium');
    if (chromium?.revision) expectedRevision = chromium.revision;
  } catch {}

  try {
    if (expectedRevision) {
      const binary = path.join(cacheDir, `chromium-${expectedRevision}`, 'chrome-mac-arm64',
        'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (fs.existsSync(binary)) return binary;
    }
    const entries = fs.readdirSync(cacheDir)
      .filter((e: string) => e.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const entry of entries) {
      const binary = path.join(cacheDir, entry, 'chrome-mac-arm64',
        'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (fs.existsSync(binary)) return binary;
    }
  } catch {}
  return undefined;
}

// ─── CDP Patch Application ──────────────────────────────────
// Copies patched Playwright server files (from rebrowser-patches) over originals.
// Must run BEFORE Playwright is imported.
export async function applyStealthPatches(): Promise<void> {
  const fs = require('fs');
  const path = require('path');

  const cacheBase = path.join(process.env.HOME || '/tmp', '.bun', 'install', 'cache');
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheBase).filter((e: string) => e.startsWith('playwright-core@'));
  } catch {
    console.warn('[nightcrawl] Playwright cache not found — CDP patches skipped');
    return;
  }
  if (entries.length === 0) {
    console.warn('[nightcrawl] No playwright-core in bun cache — CDP patches skipped');
    return;
  }

  const patchesDir = path.resolve(__dirname, '..', '..', 'patches', 'cdp');
  const patchMap = [
    ['chromium/crConnection.js', 'chromium/crConnection.js'],
    ['chromium/crPage.js', 'chromium/crPage.js'],
    ['chromium/crServiceWorker.js', 'chromium/crServiceWorker.js'],
    ['chromium/crDevTools.js', 'chromium/crDevTools.js'],
    ['frames.js', 'frames.js'],
    ['page.js', 'page.js'],
  ];

  const patchTargets: string[] = [];
  for (const entry of entries) {
    patchTargets.push(path.join(cacheBase, entry, 'lib', 'server'));
  }
  const localPw = path.resolve(__dirname, '..', 'node_modules', 'playwright-core', 'lib', 'server');
  if (fs.existsSync(localPw)) patchTargets.push(localPw);

  let applied = 0;
  for (const pwDir of patchTargets) {
    for (const [src, dest] of patchMap) {
      const srcPath = path.join(patchesDir, src);
      const destPath = path.join(pwDir, dest);
      if (fs.existsSync(srcPath) && fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        applied++;
      }
    }
  }
  console.log(`[nightcrawl] Applied ${applied} CDP stealth patches`);
}

// ─── Init Scripts (anti-bot evasion) ────────────────────────
// Injected into every page before any site scripts run.
export async function applyStealthScripts(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // Hide webdriver flag — delete from Navigator prototype so it doesn't
    // appear in Object.getOwnPropertyNames(navigator). Then redefine on
    // the prototype with a getter that returns false.
    const proto = Object.getPrototypeOf(navigator);
    delete proto.webdriver;
    Object.defineProperty(proto, 'webdriver', {
      get: () => false,
      configurable: true,
    });

    // Remove ChromeDriver detection properties
    for (const key of Object.keys(window)) {
      if (key.startsWith('cdc_') || key.startsWith('$cdc_')) delete (window as any)[key];
    }

    // Realistic navigator.languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'zh-CN', 'zh'] });

    // Patch permissions.query — notifications should return 'granted'
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (desc: any) => {
      if (desc.name === 'notifications') {
        return Promise.resolve({ state: 'granted', onchange: null } as PermissionStatus);
      }
      return origQuery(desc);
    };

    // Ensure window.chrome looks real
    if (!(window as any).chrome) {
      (window as any).chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    } else if (!(window as any).chrome.runtime) {
      (window as any).chrome.runtime = {};
    }
  });
}
