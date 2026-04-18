/**
 * First-run detection and welcome flow
 *
 * [INPUT]: Depends on cookie-import-browser's findInstalledBrowsers/importCookies
 * [INPUT]: Depends on handoff-cookie-import's pickDefaultBrowser
 * [INPUT]: Depends on config's readConfigValue
 * [OUTPUT]: Exports isFirstRun, runOnboarding, saveOnboardingConfig, OnboardingResult
 * [POS]: Onboarding entry point within browser module
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BrowserContext } from 'playwright';
import { findInstalledBrowsers, importCookies, listDomains } from './cookie-import-browser';
import { pickDefaultBrowser } from './handoff-cookie-import';

// ─── Types ──────────────────────────────────────────────────────

export interface OnboardingResult {
  mode: 'full' | 'ask' | 'manual';
  imported: number;
  browser: string | null;
}

// ─── First-run detection ────────────────────────────────────────

/**
 * Check if this is the first run. True when the cookie storage file
 * is missing, empty, or contains no real cookies.
 *
 * Accepts an explicit path for testability; defaults to the standard
 * ~/.nightcrawl/browse-cookies.json location.
 */
export function isFirstRun(
  cookiePath: string = path.join(process.env.HOME || '/tmp', '.nightcrawl', 'browse-cookies.json'),
): boolean {
  try {
    const raw = fs.readFileSync(cookiePath, 'utf-8').trim();
    if (raw.length === 0) return true;
    const parsed = JSON.parse(raw);
    // A valid cookie file has a non-empty cookies array
    if (Array.isArray(parsed?.cookies) && parsed.cookies.length > 0) return false;
    return true;
  } catch {
    return true;
  }
}

// ─── Config persistence ─────────────────────────────────────────

/**
 * Save the cookie import mode to config.yaml.
 * Creates the file/directory if needed. Preserves existing keys.
 */
export function saveOnboardingConfig(
  mode: string,
  configPath: string = path.join(process.env.HOME || '/tmp', '.nightcrawl', 'state', 'config.yaml'),
): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  let existing = '';
  try { existing = fs.readFileSync(configPath, 'utf-8'); } catch {}

  // Replace existing cookie_mode line or append
  const line = `cookie_mode: ${mode}`;
  if (/^cookie_mode:/m.test(existing)) {
    existing = existing.replace(/^cookie_mode:.*$/m, line);
  } else {
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    existing = existing + sep + line + '\n';
  }

  fs.writeFileSync(configPath, existing);
}

// ─── Welcome message ────────────────────────────────────────────

function formatWelcome(browserNames: string[]): string {
  const browsers = browserNames.length > 0
    ? browserNames.join(', ')
    : 'none found';

  return [
    '',
    '  \u{1F319} Welcome to nightCrawl \u2014 your digital twin in the browser.',
    '',
    '  nightCrawl browses the web as you, using your real browser cookies.',
    '  Everything stays on your machine. No data is sent anywhere.',
    '',
    `  Detected browsers: ${browsers}`,
    '',
  ].join('\n');
}

function formatModePrompt(): string {
  return [
    '  How should nightCrawl handle your cookies?',
    '',
    '  [1] full   \u2014 Import all cookies from your default browser (recommended)',
    '  [2] ask    \u2014 Ask before importing from each domain',
    '  [3] manual \u2014 Never auto-import; you run cookie-import yourself',
    '',
  ].join('\n');
}

function formatImportSuccess(count: number, browser: string): string {
  const formatted = count.toLocaleString();
  return `  Imported ${formatted} cookies from ${browser}. You're ready to go!`;
}

function formatManualHint(): string {
  return [
    '  To import cookies manually, run:',
    '    browse cookie-import-browser --browser arc',
    '',
  ].join('\n');
}

// ─── Full-import helper ─────────────────────────────────────────

async function importAllFromBrowser(
  browserName: string,
  context: BrowserContext,
): Promise<number> {
  // Get all domains from the browser's cookie DB
  const { domains } = listDomains(browserName);
  if (domains.length === 0) return 0;

  const hostKeys = domains.map(d => d.domain);
  const result = await importCookies(browserName, hostKeys);
  if (result.cookies.length > 0) {
    await context.addCookies(result.cookies);
  }
  return result.count;
}

// ─── Main onboarding flow ───────────────────────────────────────

/**
 * Run the first-run onboarding flow. Detects browsers, prints welcome,
 * and returns a structured result.
 *
 * The `mode` parameter lets the caller pre-select the mode (for
 * non-interactive daemon use). If not provided, defaults to 'full'.
 *
 * In daemon mode there is no interactive stdin, so the mode must be
 * passed explicitly or default to 'full'. The CLI wrapper can present
 * the prompt and pass the user's choice here.
 */
export async function runOnboarding(
  context: BrowserContext,
  mode: 'full' | 'ask' | 'manual' = 'full',
): Promise<OnboardingResult> {
  // Detect installed browsers
  const installed = findInstalledBrowsers();
  const browserNames = installed.map(b => b.name);

  // Print welcome
  console.log(formatWelcome(browserNames));
  console.log(formatModePrompt());
  console.log(`  Selected mode: ${mode}`);

  // Save the choice
  saveOnboardingConfig(mode);

  const result: OnboardingResult = { mode, imported: 0, browser: null };

  if (mode === 'full') {
    const browser = pickDefaultBrowser();
    if (browser) {
      try {
        const count = await importAllFromBrowser(browser, context);
        result.imported = count;
        result.browser = browser;
        console.log(formatImportSuccess(count, browser));
      } catch (err: any) {
        console.error(`  Cookie import failed: ${err?.message ?? err}`);
      }
    } else {
      console.log('  No supported browser found for cookie import.');
    }
  } else if (mode === 'manual') {
    console.log(formatManualHint());
  } else {
    // 'ask' mode — no immediate import
    console.log('  Cookies will be imported per-domain when login walls are hit.');
  }

  console.log('');
  return result;
}
