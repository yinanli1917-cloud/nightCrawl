/**
 * Production VerifierBrowser implementation using Playwright.
 *
 * This is the real-browser counterpart to the fake browser used by
 * stealth-verifier.test.ts. It launches a fresh Playwright Chromium
 * (with whichever engine is currently selected), runs the actual
 * navigation and DOM checks, and reports back to verifyStealth().
 *
 * Lives in its own file so stealth-verifier.ts stays unit-testable
 * (no Playwright import = fast tests).
 *
 * SCOPE: only Tier 1-2 sites. Hostile platforms are blocked at the
 * navigation layer by hostile-domains.ts anyway, but we don't even
 * try.
 *
 * [INPUT]: Playwright (lazy via getChromium), engine-config
 * [OUTPUT]: createPlaywrightVerifierBrowser(): VerifierBrowser
 * [POS]: Production wiring for the stealth verifier
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import type { VerifierBrowser } from './stealth-verifier';
import { findChromiumExecutable, applyStealthPatches } from './stealth';

const NAV_TIMEOUT_MS = 15000;

export function createPlaywrightVerifierBrowser(): VerifierBrowser {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  return {
    async launch() {
      await applyStealthPatches();
      const { chromium } = await import('playwright');
      const exePath = findChromiumExecutable();
      browser = await chromium.launch({
        headless: true,
        ...(exePath ? { executablePath: exePath } : {}),
      });
      context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
      });
      page = await context.newPage();
    },

    async navigate(url: string) {
      if (!page) throw new Error('verifier browser not launched');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    },

    async evaluateWebdriver() {
      if (!page) throw new Error('verifier browser not launched');
      // Navigate to a blank-ish page first if needed; we evaluate
      // navigator.webdriver on whatever page is currently loaded.
      const result = await page.evaluate(() => (navigator as any).webdriver);
      return result === true;
    },

    async checkSannysoft() {
      if (!page) throw new Error('verifier browser not launched');
      await page.waitForTimeout(2000); // sannysoft tests run via JS
      // Critical rows: WebDriver, Chrome, User Agent — pull table
      // and ensure none of those say "missing"/"failed"/"present" (red).
      const result = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tr'));
        const critical = ['WebDriver', 'Chrome (New)', 'User Agent'];
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 2) continue;
          const label = cells[0]?.textContent?.trim() || '';
          const verdict = cells[1]?.textContent?.trim() || '';
          if (critical.some((c) => label.includes(c))) {
            // Red verdicts contain "failed", "missing (failed)", or "present (failed)"
            if (/failed/i.test(verdict)) return false;
          }
        }
        return true;
      });
      return result;
    },

    async checkRebrowser() {
      if (!page) throw new Error('verifier browser not launched');
      // bot-detector.rebrowser.net runs JS tests for ~5 seconds
      await page.waitForTimeout(8000);
      // The page exposes results via a global object or DOM.
      // We look for any element marked red/failed for the CDP test.
      const passed = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        // The page reports "Detected" or specific test names with red text.
        // We treat any "Detected" / "leaked" mention as failure.
        if (/runtimeEnableLeak.*RED|runtimeEnableLeak.*detected/i.test(text)) return false;
        if (/navigator\.webdriver.*RED|navigator\.webdriver.*detected/i.test(text)) return false;
        return true;
      });
      return passed;
    },

    async close() {
      try { await page?.close(); } catch {}
      try { await context?.close(); } catch {}
      try { await browser?.close(); } catch {}
      page = null;
      context = null;
      browser = null;
    },
  };
}
