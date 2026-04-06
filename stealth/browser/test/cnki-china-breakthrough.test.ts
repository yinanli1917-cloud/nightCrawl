/**
 * CNKI China via university VPN proxy — uses nightcrawl's BrowserManager.
 * VPN URL pattern: www.cnki.net → www--cnki--net--https.cnki.mdjsf.utuvpn.utuedu.com:9000
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';

const BASE = 'http://www--cnki--net--https.cnki.mdjsf.utuvpn.utuedu.com:9000';

let bm: BrowserManager;

beforeAll(async () => {
  process.env.BROWSE_EXTENSIONS = 'none';
  process.env.BROWSE_EXTENSIONS_DIR = '';
  process.env.BROWSE_IGNORE_HTTPS_ERRORS = '1';

  bm = new BrowserManager();
  await bm.launch();
}, 30000);

afterAll(async () => {
  await bm.close();
  setTimeout(() => process.exit(0), 500);
});

describe('CNKI China via VPN (nightcrawl)', () => {
  test('access main page with institutional access', async () => {
    await handleWriteCommand('goto', [BASE + '/'], bm);
    const page = bm.getPage();
    await page.waitForTimeout(2000);

    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
    console.log('[cnki] Title:', title);
    console.log('[cnki] Text:', text.slice(0, 200));

    expect(title).toContain('知网');
    const hasInstitution = /师范学院|理工大学|机构/i.test(text);
    console.log('[cnki] Has institution:', hasInstitution);
  }, 30000);

  test('personal login with credentials', async () => {
    const page = bm.getPage();

    // Click 个人登录
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('a, span, div')) {
        if (el.textContent?.trim() === '个人登录') {
          (el as HTMLElement).click();
          return;
        }
      }
    });
    await page.waitForTimeout(3000);

    // Login modal appears — find the visible password input
    // The modal may have multiple login tabs (手机/账号)
    // Try clicking the account login tab first
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('a, span, li, div')) {
        const text = el.textContent?.trim() || '';
        if (text === '账号登录' || text === '密码登录') {
          (el as HTMLElement).click();
          return;
        }
      }
    });
    await page.waitForTimeout(1000);

    // Now find the VISIBLE inputs in the login modal
    const filled = await page.evaluate(() => {
      const pwdInputs = document.querySelectorAll('input[type="password"]');
      for (const pwd of pwdInputs) {
        const el = pwd as HTMLInputElement;
        if (el.offsetParent !== null) { // visible
          // Find the username input in the same form/container
          const container = el.closest('form, div[class*="login"], div[class*="modal"], div[class*="popup"]') || el.parentElement?.parentElement;
          if (container) {
            const textInputs = container.querySelectorAll('input[type="text"], input[type="tel"], input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])');
            for (const inp of textInputs) {
              const input = inp as HTMLInputElement;
              if (input.offsetParent !== null) {
                input.value = '255122884';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                break;
              }
            }
          }
          el.value = 'Luffy551024usst';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }
      return false;
    });

    console.log('[cnki] Credentials filled:', filled);

    if (filled) {
      // Click submit button in the login modal
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button, input[type="submit"], a.btn');
        for (const btn of btns) {
          const el = btn as HTMLElement;
          if (el.offsetParent !== null && /登录|login|sign/i.test(el.textContent || '')) {
            el.click();
            return;
          }
        }
      });
      await page.waitForTimeout(5000);
    }

    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
    console.log('[cnki] After login:', text.slice(0, 200));

    const isLoggedIn = /退出|注销|个人中心|我的/i.test(text);
    const hasError = /密码错误|验证码|登录失败/i.test(text);
    console.log('[cnki] Logged in:', isLoggedIn);
    console.log('[cnki] Login error:', hasError);
  }, 60000);

  test('search for 人工智能 and get results', async () => {
    const page = bm.getPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Fill search using nightcrawl's text input
    const searchInput = page.getByRole('textbox', { name: /文献/ });
    await searchInput.fill('人工智能');
    await searchInput.press('Enter');
    await page.waitForTimeout(8000);

    const searchUrl = page.url();
    const searchText = await page.evaluate(() => document.body?.innerText?.slice(0, 1000) || '');
    console.log('[cnki] Search URL:', searchUrl);
    console.log('[cnki] Results:', searchText.slice(0, 500));

    const hasResults = /篇|万|条|结果|论文|期刊|下载/i.test(searchText);
    console.log('[cnki] Has results:', hasResults);
    expect(hasResults).toBe(true);
  }, 60000);
});
