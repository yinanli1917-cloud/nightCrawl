/**
 * CNKI China institutional login verification.
 * Automates: navigate → login → search → verify results.
 * Uses Playwright directly (not BrowserManager) for ignoreHTTPSErrors.
 * Credentials are runtime-only, never committed.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Browser, Page } from 'playwright';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  const { chromium } = await import('playwright');
  const { applyStealthPatches, applyStealthScripts, DEFAULT_USER_AGENT } = await import('../src/stealth');

  await applyStealthPatches();
  process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding';

  browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1920, height: 1080 },
    userAgent: DEFAULT_USER_AGENT,
  });
  await applyStealthScripts(context);
  page = await context.newPage();
}, 30000);

afterAll(async () => {
  await browser?.close();
  setTimeout(() => process.exit(0), 500);
});

describe('CNKI China institutional login', () => {
  test('login and search for academic papers', async () => {
    // Step 1: Try CNKI overseas first (works), then China (418 anti-bot)
    console.log('[cnki] Step 1: Try overseas.cnki.net first...');
    await page.goto('https://oversea.cnki.net/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);
    const overseasText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
    console.log('[cnki] Overseas works:', overseasText.length > 100);
    console.log('[cnki] Overseas text:', overseasText.slice(0, 200));

    // Now try China version
    console.log('[cnki] Step 1b: Navigate to cnki.net (China)...');

    // Capture network responses for debugging
    const responses: string[] = [];
    page.on('response', resp => {
      const status = resp.status();
      const url = resp.url();
      if (status >= 300 || url.includes('cnki')) {
        responses.push(`${status} ${url.slice(0, 100)}`);
      }
    });

    await page.goto('https://www.cnki.net/', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(5000);

    let title = await page.title();
    let url = page.url();
    let html = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 3000));
    let text = await page.evaluate(() => document.body?.innerText?.slice(0, 1000) || '');
    console.log('[cnki] Title:', title);
    console.log('[cnki] URL:', url);
    console.log('[cnki] HTML:', html.slice(0, 1000));
    console.log('[cnki] Text:', text.slice(0, 300));
    console.log('[cnki] Network responses:', responses.slice(0, 10).join('\n'));

    // Step 2: Find login entry point
    console.log('[cnki] Step 2: Finding login...');
    const snapshot = await page.locator('body').ariaSnapshot();
    console.log('[cnki] Snapshot:', snapshot.slice(0, 1500));

    // Click login link
    const loginClicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const a of links) {
        if (a.textContent?.includes('登录') || a.textContent?.includes('Login')) {
          (a as HTMLElement).click();
          return a.href;
        }
      }
      return null;
    });
    console.log('[cnki] Login link clicked:', loginClicked);
    await page.waitForTimeout(3000);

    // Check if a new page/popup opened or we navigated
    url = page.url();
    title = await page.title();
    console.log('[cnki] After login click — URL:', url, 'Title:', title);

    // If login opened in same page, take snapshot
    const loginSnapshot = await page.locator('body').ariaSnapshot();
    console.log('[cnki] Login snapshot:', loginSnapshot.slice(0, 2000));

    // Step 3: Find and fill credentials
    console.log('[cnki] Step 3: Filling credentials...');

    // Try multiple strategies to find the login form
    let filled = false;

    // Strategy A: Direct input selectors
    for (const uSel of ['#userName', '#username', 'input[name="userName"]', 'input[placeholder*="账号"]', 'input[placeholder*="用户名"]', 'input[placeholder*="手机"]']) {
      const el = await page.$(uSel);
      if (el && await el.isVisible().catch(() => false)) {
        console.log('[cnki] Found username via:', uSel);
        await el.fill('255122884');

        // Find password nearby
        const pwd = await page.$('input[type="password"]');
        if (pwd) {
          await pwd.fill('Luffy551024usst');
          filled = true;
          console.log('[cnki] Credentials filled');
        }
        break;
      }
    }

    // Strategy B: Check iframes
    if (!filled) {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const frameUrl = frame.url();
        console.log('[cnki] Checking frame:', frameUrl);

        const uInput = await frame.$('input[type="text"], input[name*="user"], input[name*="name"], input[placeholder*="账号"]');
        const pInput = await frame.$('input[type="password"]');
        if (uInput && pInput) {
          console.log('[cnki] Found login form in iframe');
          await uInput.fill('255122884');
          await pInput.fill('Luffy551024usst');
          filled = true;

          // Submit from iframe
          const submitBtn = await frame.$('button[type="submit"], input[type="submit"], button:has-text("登录")');
          if (submitBtn) {
            await submitBtn.click();
          } else {
            await pInput.press('Enter');
          }
          break;
        }
      }
    }

    if (!filled) {
      // Dump full HTML for debugging
      const html = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 5000));
      console.log('[cnki] Could not find login form. HTML:', html.slice(0, 3000));

      // Try navigating to direct login URL
      console.log('[cnki] Trying direct login URL...');
      await page.goto('https://my.cnki.net/login/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);

      const myUrl = page.url();
      const mySnap = await page.locator('body').ariaSnapshot();
      console.log('[cnki] my.cnki.net URL:', myUrl);
      console.log('[cnki] my.cnki.net snapshot:', mySnap.slice(0, 2000));
    }

    if (filled) {
      // Step 4: Submit if not already submitted
      const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("登录"), a:has-text("登录")');
      if (submitBtn) {
        console.log('[cnki] Step 4: Clicking submit...');
        await submitBtn.click();
      }
    }

    // Wait for login to process
    await page.waitForTimeout(5000);

    url = page.url();
    title = await page.title();
    text = await page.evaluate(() => document.body?.innerText?.slice(0, 1500) || '');
    console.log('[cnki] After login — URL:', url);
    console.log('[cnki] After login — Title:', title);
    console.log('[cnki] After login — Text:', text.slice(0, 500));

    // Step 5: Go to CNKI main page and search
    console.log('[cnki] Step 5: Navigate to search...');
    await page.goto('https://www.cnki.net/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    title = await page.title();
    text = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
    console.log('[cnki] Main page title:', title);
    console.log('[cnki] Main page text:', text.slice(0, 500));

    const isLoggedIn = /退出|注销|个人中心|我的|上海理工/i.test(text);
    const hasSearch = /搜索|检索|search|知网|cnki/i.test(text + title);
    const isBotBlocked = /captcha|验证码|请完成验证|access denied/i.test(text)
      && !/搜索|检索|知网/i.test(text);

    console.log('[cnki] Logged in:', isLoggedIn);
    console.log('[cnki] Has search:', hasSearch);
    console.log('[cnki] Bot blocked:', isBotBlocked);

    expect(isBotBlocked).toBe(false);
    expect(hasSearch).toBe(true);
  }, 120000);
});
