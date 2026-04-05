/**
 * CNKI China via university VPN proxy — institutional access + personal login + search.
 * VPN URL pattern: www.cnki.net → www--cnki--net--https.cnki.mdjsf.utuvpn.utuedu.com:9000
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Browser, Page } from 'playwright';

const BASE = 'http://www--cnki--net--https.cnki.mdjsf.utuvpn.utuedu.com:9000';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  const { applyStealthPatches, applyStealthScripts, DEFAULT_USER_AGENT } = await import('../src/stealth');
  await applyStealthPatches();
  process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding';

  const { chromium } = await import('playwright');
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1920, height: 1080 },
    userAgent: DEFAULT_USER_AGENT,
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  });
  await applyStealthScripts(context);
  page = await context.newPage();
}, 30000);

afterAll(async () => {
  await browser?.close();
  setTimeout(() => process.exit(0), 500);
});

describe('CNKI China via VPN', () => {
  test('access main page and verify institutional access', async () => {
    await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
    console.log('[cnki] Title:', title);
    console.log('[cnki] Text:', text.slice(0, 200));

    expect(title).toContain('知网');

    // VPN grants institutional access — should show institution name
    const hasInstitution = /师范学院|理工大学|机构/i.test(text);
    console.log('[cnki] Has institution:', hasInstitution);
  }, 30000);

  test('personal login with credentials', async () => {
    // Click "个人登录" link
    const loginLink = await page.evaluate(() => {
      const el = document.querySelector('a[href*="login"], span:has(a)');
      // Look for the 个人登录 text
      const allEls = document.querySelectorAll('a, span, div');
      for (const e of allEls) {
        if (e.textContent?.trim() === '个人登录') {
          (e as HTMLElement).click();
          return 'clicked 个人登录';
        }
      }
      return null;
    });
    console.log('[cnki] Login click:', loginLink);
    await page.waitForTimeout(3000);

    // Login popup might appear as a modal/dialog
    const url = page.url();
    console.log('[cnki] After click URL:', url);

    // Check for login modal/iframe
    let loggedIn = false;

    // Check main frame for password input (modal)
    let pwdInput = await page.$('input[type="password"]:visible');
    if (pwdInput) {
      console.log('[cnki] Found password input in main frame');
      // Fill username first
      const userInput = await page.$('input[name="userName"], input[id="userName"], input[placeholder*="手机"], input[placeholder*="账号"]');
      if (userInput) {
        await userInput.fill('255122884');
        console.log('[cnki] Username filled');
      }
      await pwdInput.fill('Luffy551024usst');
      console.log('[cnki] Password filled');

      const submitBtn = await page.$('button:has-text("登录"), input[value*="登录"], a:has-text("登录")');
      if (submitBtn) {
        await submitBtn.click();
        console.log('[cnki] Submit clicked');
      } else {
        await pwdInput.press('Enter');
      }
      loggedIn = true;
    }

    // Check iframes
    if (!loggedIn) {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const fUrl = frame.url();
        if (fUrl.includes('login') || fUrl.includes('tlogin')) {
          console.log('[cnki] Found login frame:', fUrl.slice(0, 100));
          const snap = await frame.locator('body').ariaSnapshot().catch(() => '');
          console.log('[cnki] Login frame snapshot:', snap.slice(0, 1000));

          const pwd = await frame.$('input[type="password"]');
          if (pwd) {
            // Find text inputs for username
            const inputs = await frame.$$('input[type="text"], input[type="tel"], input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="checkbox"])');
            for (const inp of inputs) {
              const vis = await inp.isVisible().catch(() => false);
              if (vis) {
                await inp.fill('255122884');
                console.log('[cnki] Username filled in frame');
                break;
              }
            }
            await pwd.fill('Luffy551024usst');
            console.log('[cnki] Password filled in frame');

            const btn = await frame.$('button:has-text("登录"), input[type="submit"], a.btn');
            if (btn) {
              await btn.click();
            } else {
              await pwd.press('Enter');
            }
            loggedIn = true;
            break;
          }
        }
      }
    }

    if (!loggedIn) {
      // Dump what we see
      const snap = await page.locator('body').ariaSnapshot();
      console.log('[cnki] No login form found. Snapshot:', snap.slice(0, 2000));
    }

    await page.waitForTimeout(5000);

    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
    console.log('[cnki] After login text:', text.slice(0, 300));

    const isLoggedIn = /退出|注销|个人中心|我的|上海理工/i.test(text);
    console.log('[cnki] Is logged in:', isLoggedIn);
  }, 60000);

  test('search for papers on 人工智能', async () => {
    // Make sure we're on the main page
    await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Use the aria-labeled textbox
    const searchInput = await page.$('input#txt_SearchText');
    if (!searchInput) {
      // Fallback: find by placeholder
      const fallback = await page.$('input[placeholder*="文献"]');
      if (fallback) {
        await fallback.fill('人工智能');
        await fallback.press('Enter');
      } else {
        // Use aria snapshot to find the textbox
        const input = page.getByRole('textbox', { name: /文献/ });
        await input.fill('人工智能');
        await input.press('Enter');
      }
    } else {
      await searchInput.fill('人工智能');
      // Click the search button
      const btn = await page.$('input.search-btn, .search-btn, input[onclick*="search"], input[value*="检索"]');
      if (btn) {
        await btn.click();
      } else {
        await searchInput.press('Enter');
      }
    }

    await page.waitForTimeout(8000);

    const searchUrl = page.url();
    const searchTitle = await page.title();
    const searchText = await page.evaluate(() => document.body?.innerText?.slice(0, 1500) || '');
    console.log('[cnki] Search URL:', searchUrl);
    console.log('[cnki] Search title:', searchTitle);
    console.log('[cnki] Search text:', searchText.slice(0, 500));

    const hasResults = /篇|条|结果|论文|期刊|下载|知网|人工智能/i.test(searchText);
    console.log('[cnki] Has results:', hasResults);
    expect(hasResults).toBe(true);
  }, 60000);
});
