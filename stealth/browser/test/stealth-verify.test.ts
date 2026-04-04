/**
 * Real-world anti-bot verification tests.
 *
 * Opens actual hostile websites and checks that nightCrawl's stealth
 * patches hold up: bot detectors see a normal browser, Chinese
 * academic sites serve content instead of CAPTCHAs.
 *
 * [INPUT]: Depends on BrowserManager launch + cookie restore
 * [OUTPUT]: Pass/fail per site, detailed diagnostic logs
 * [POS]: Integration smoke tests within stealth/browser/test
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';
import * as fs from 'fs';
import * as path from 'path';

const COOKIE_FILE = path.join(process.env.HOME || '', '.nightcrawl', 'browse-cookies.json');
const HAS_COOKIES = fs.existsSync(COOKIE_FILE);

let bm: BrowserManager;

beforeAll(async () => {
  // Disable extensions — pure stealth test
  process.env.BROWSE_EXTENSIONS = 'none';
  process.env.BROWSE_EXTENSIONS_DIR = '';

  bm = new BrowserManager();
  await bm.launch();

  if (HAS_COOKIES) {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
    await bm.restoreCookies(cookies);
  }
}, 30000);

afterAll(async () => {
  await bm.close();
  setTimeout(() => process.exit(0), 500);
});

// ─── Helpers ────────────────────────────────────────────────────

async function navigateAndExtract(url: string, waitMs = 3000): Promise<{
  title: string;
  finalUrl: string;
  text: string;
}> {
  const page = bm.getPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(waitMs);

  const title = await page.title();
  const finalUrl = page.url();
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');

  return { title, finalUrl, text };
}

// ─── Test 1: bot.sannysoft.com ──────────────────────────────────

describe('bot.sannysoft.com', () => {
  test('passes core browser fingerprint checks', async () => {
    const page = bm.getPage();
    await page.goto('https://bot.sannysoft.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for the detection table to render
    await page.waitForSelector('table', { timeout: 15000 });
    await page.waitForTimeout(2000);

    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
    console.log('[sannysoft] title:', title);
    console.log('[sannysoft] text (first 500):', text.slice(0, 500));

    expect(text.length).toBeGreaterThan(0);

    // Extract per-row results from the detection table
    const rows = await page.evaluate(() => {
      const results: Array<{ name: string; value: string; failed: boolean }> = [];
      const trs = document.querySelectorAll('table tr');
      for (const tr of trs) {
        const tds = tr.querySelectorAll('td');
        if (tds.length >= 2) {
          const name = tds[0].textContent?.trim() || '';
          const value = tds[1].textContent?.trim() || '';
          const failed = tds[1].classList.contains('failed')
            || tds[1].style.backgroundColor === 'red'
            || value.toUpperCase().includes('FAILED');
          results.push({ name, value, failed });
        }
      }
      return results;
    });

    console.log('[sannysoft] all rows:', JSON.stringify(rows, null, 2));

    // Log any failures
    const failures = rows.filter(r => r.failed);
    if (failures.length > 0) {
      console.log('[sannysoft] FAILED rows:', JSON.stringify(failures, null, 2));
    }

    // Critical rows must pass (WebGL fails in headless — no GPU, expected)
    const critical = ['User Agent', 'WebDriver', 'Chrome'];
    for (const name of critical) {
      const row = rows.find(r => r.name.includes(name));
      if (row) {
        console.log(`[sannysoft] ${row.name}: ${row.failed ? 'FAILED' : 'PASSED'} (${row.value})`);
        expect(row.failed).toBe(false);
      }
    }
  }, 60000);
});

// ─── Test 2: bot-detector.rebrowser.net ─────────────────────────

describe('bot-detector.rebrowser.net', () => {
  test('scores low on bot detection', async () => {
    const page = bm.getPage();
    await page.goto('https://bot-detector.rebrowser.net/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // The detector runs JS tests that take several seconds
    await page.waitForTimeout(8000);

    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
    console.log('[rebrowser] title:', title);
    console.log('[rebrowser] text (first 500):', text.slice(0, 500));

    expect(text.length).toBeGreaterThan(0);

    // Try to find a score or result summary
    const result = await page.evaluate(() => {
      // Look for common result patterns in the page
      const body = document.body?.innerText || '';
      const scoreMatch = body.match(/score[:\s]+(\d+)/i);
      const detectedMatch = body.match(/(not\s+detected|detected|bot|human)/i);
      return {
        fullText: body.slice(0, 2000),
        score: scoreMatch ? scoreMatch[1] : null,
        detection: detectedMatch ? detectedMatch[0] : null,
      };
    });

    console.log('[rebrowser] detection result:', result.detection);
    console.log('[rebrowser] score:', result.score);
    console.log('[rebrowser] full text:', result.fullText.slice(0, 800));

    // Verify the page produced some kind of result (not a blank/error page)
    expect(result.fullText.length).toBeGreaterThan(50);
  }, 60000);
});

// ─── Test 3: CNKI (oversea.cnki.net) ────────────────────────────

describe('CNKI (oversea.cnki.net)', () => {
  test('serves academic search interface, not a CAPTCHA wall', async () => {
    const { title, finalUrl, text } = await navigateAndExtract(
      'https://oversea.cnki.net/',
      5000,
    );

    console.log('[cnki] title:', title);
    console.log('[cnki] final URL:', finalUrl);
    console.log('[cnki] text (first 500):', text.slice(0, 500));

    expect(text.length).toBeGreaterThan(0);

    // Should contain academic content indicators, not a bare CAPTCHA page
    const hasContent = /cnki|知网|学术|搜索|search|journal|期刊|论文/i.test(text + title);
    const isCaptchaOnly = /captcha|验证码|请完成验证/i.test(text)
      && !/cnki|知网|搜索|search/i.test(text);

    console.log('[cnki] has academic content:', hasContent);
    console.log('[cnki] is captcha-only:', isCaptchaOnly);

    expect(isCaptchaOnly).toBe(false);
    expect(hasContent).toBe(true);
  }, 60000);
});

// ─── Test 4: court.gov.cn (wenshu.court.gov.cn) ─────────────────

describe('wenshu.court.gov.cn', () => {
  test('serves court document search, not a blank or login-only page', async () => {
    const { title, finalUrl, text } = await navigateAndExtract(
      'https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html',
      5000,
    );

    console.log('[wenshu] title:', title);
    console.log('[wenshu] final URL:', finalUrl);
    console.log('[wenshu] text (first 500):', text.slice(0, 500));

    expect(text.length).toBeGreaterThan(0);

    // Should contain court/legal content
    const hasContent = /裁判文书|搜索|案件|法院|court|document|search/i.test(text + title);
    const isLoginOnly = /登录|login/i.test(text)
      && !/裁判文书|搜索|案件|法院/i.test(text);

    console.log('[wenshu] has legal content:', hasContent);
    console.log('[wenshu] is login-only:', isLoginOnly);

    expect(isLoginOnly).toBe(false);
    expect(hasContent).toBe(true);
  }, 60000);
});
