/**
 * CloakBrowser VerifierBrowser implementation.
 *
 * Mirrors stealth-verifier-playwright.ts but uses CloakBrowser's
 * stealth Chromium. This is the correct verifier when CloakBrowser
 * is the active engine — using the stock PW verifier would test
 * the wrong browser and report false negatives.
 *
 * [INPUT]: cloakbrowser-engine.ts (launchCloakBrowser + patchScreencast)
 * [OUTPUT]: createCloakVerifierBrowser(): VerifierBrowser
 * [POS]: Production wiring for stealth verifier under CloakBrowser engine
 */

import type { BrowserContext, Page } from 'playwright';
import type { VerifierBrowser } from './stealth-verifier';
import { launchCloakBrowser, patchScreencast } from './cloakbrowser-engine';

const NAV_TIMEOUT_MS = 15000;

export function createCloakVerifierBrowser(): VerifierBrowser {
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  return {
    async launch() {
      const result = await launchCloakBrowser({ headless: true });
      context = result.context;
      page = await context.newPage();
      patchScreencast(page);
    },

    async navigate(url: string) {
      if (!page) throw new Error('verifier browser not launched');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    },

    async evaluateWebdriver() {
      if (!page) throw new Error('verifier browser not launched');
      const result = await page.evaluate(() => (navigator as any).webdriver);
      return result === true;
    },

    async checkSannysoft() {
      if (!page) throw new Error('verifier browser not launched');
      await page.waitForTimeout(2000);
      const result = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tr'));
        const critical = ['WebDriver', 'Chrome (New)', 'User Agent'];
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 2) continue;
          const label = cells[0]?.textContent?.trim() || '';
          const verdict = cells[1]?.textContent?.trim() || '';
          if (critical.some((c) => label.includes(c))) {
            if (/failed/i.test(verdict)) return false;
          }
        }
        return true;
      });
      return result;
    },

    async checkRebrowser() {
      if (!page) throw new Error('verifier browser not launched');
      await page.waitForTimeout(8000);
      const passed = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        // Look for red circle (U+1F534) on critical tests — means detection
        // Green circle (U+1F7E2) or white circle (U+26AA) = pass/not triggered
        const lines = text.split('\n');
        for (const line of lines) {
          if (/runtimeEnableLeak/i.test(line) && !line.startsWith('\u{1F7E2}') && !line.startsWith('\u26AA')) {
            if (line.startsWith('\u{1F534}')) return false;
          }
          if (/navigatorWebdriver/i.test(line) && !line.startsWith('\u{1F7E2}') && !line.startsWith('\u26AA')) {
            if (line.startsWith('\u{1F534}')) return false;
          }
        }
        return true;
      });
      return passed;
    },

    async close() {
      try { await page?.close(); } catch {}
      try { await context?.close(); } catch {}
      page = null;
      context = null;
    },
  };
}
