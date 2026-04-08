/**
 * [INPUT]: cleanup module + write-commands handler
 * [OUTPUT]: validates cleanup removes noise, preserves content
 * [POS]: integration tests for the cleanup command
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';
import { handleReadCommand } from '../src/read-commands';

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;
  bm = new BrowserManager();
  await bm.launch();
});

afterAll(() => {
  try { testServer.server.stop(); } catch {}
  setTimeout(() => process.exit(0), 500);
});

// ─── Helper ────────────────────────────────────────────────────

async function gotoAndCleanup(fixture: string): Promise<string> {
  await handleWriteCommand('goto', [`${baseUrl}/${fixture}`], bm);
  return handleWriteCommand('cleanup', [], bm);
}

async function elementExists(selector: string): Promise<boolean> {
  const page = bm.getPage();
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el !== null && (el as HTMLElement).offsetParent !== null;
  }, selector);
}

async function elementVisible(selector: string): Promise<boolean> {
  const page = bm.getPage();
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }, selector);
}

// ─── Cookie Banners ────────────────────────────────────────────

describe('cleanup: cookie banners', () => {
  test('removes OneTrust cookie banner', async () => {
    const result = await gotoAndCleanup('cleanup.html');
    expect(result).toContain('cookie');
    const visible = await elementVisible('#onetrust-banner-sdk');
    expect(visible).toBe(false);
  });

  test('removes Cookiebot dialog', async () => {
    await gotoAndCleanup('cleanup.html');
    const visible = await elementVisible('#CybotCookiebotDialog');
    expect(visible).toBe(false);
  });

  test('removes generic cc-banner', async () => {
    await gotoAndCleanup('cleanup.html');
    const visible = await elementVisible('.cc-banner');
    expect(visible).toBe(false);
  });
});

// ─── Ad Containers ─────────────────────────────────────────────

describe('cleanup: ad containers', () => {
  test('removes Google AdSense containers', async () => {
    await gotoAndCleanup('cleanup.html');
    const visible = await elementVisible('.adsbygoogle');
    expect(visible).toBe(false);
  });

  test('removes GPT ad divs', async () => {
    await gotoAndCleanup('cleanup.html');
    const visible = await elementVisible('[id^="div-gpt-ad"]');
    expect(visible).toBe(false);
  });

  test('removes Taboola containers', async () => {
    await gotoAndCleanup('cleanup.html');
    const visible = await elementVisible('.taboola-container');
    expect(visible).toBe(false);
  });

  test('removes Outbrain widgets', async () => {
    await gotoAndCleanup('cleanup.html');
    const visible = await elementVisible('.OUTBRAIN');
    expect(visible).toBe(false);
  });
});

// ─── Overlays and Modals ───────────────────────────────────────

describe('cleanup: overlays', () => {
  test('removes fixed overlay covering >30% viewport', async () => {
    await gotoAndCleanup('cleanup.html');
    const visible = await elementVisible('#big-overlay');
    expect(visible).toBe(false);
  });

  test('removes modal with aria-modal="true"', async () => {
    await gotoAndCleanup('cleanup.html');
    const visible = await elementVisible('[aria-modal="true"]');
    expect(visible).toBe(false);
  });

  test('removes newsletter popup with email input', async () => {
    await gotoAndCleanup('cleanup.html');
    const visible = await elementVisible('.newsletter-popup');
    expect(visible).toBe(false);
  });
});

// ─── Paywall ───────────────────────────────────────────────────

describe('cleanup: paywall', () => {
  test('removes paywall overlay', async () => {
    await gotoAndCleanup('cleanup.html');
    const visible = await elementVisible('.paywall-overlay');
    expect(visible).toBe(false);
  });

  test('removes TP modal and backdrop', async () => {
    await gotoAndCleanup('cleanup.html');
    const tpModal = await elementVisible('.tp-modal');
    const tpBackdrop = await elementVisible('.tp-backdrop');
    expect(tpModal).toBe(false);
    expect(tpBackdrop).toBe(false);
  });
});

// ─── Content Preservation ──────────────────────────────────────

describe('cleanup: preserves content', () => {
  test('preserves main article content', async () => {
    await gotoAndCleanup('cleanup.html');
    const text = await handleReadCommand('text', [], bm);
    expect(text).toContain('Important Article Title');
    expect(text).toContain('main article body that must be preserved');
  });

  test('preserves navigation', async () => {
    await gotoAndCleanup('cleanup.html');
    const visible = await elementVisible('#main-nav');
    expect(visible).toBe(true);
  });

  test('preserves forms', async () => {
    await gotoAndCleanup('cleanup.html');
    const visible = await elementVisible('#contact-form');
    expect(visible).toBe(true);
  });

  test('restores body scroll after overlay removal', async () => {
    await gotoAndCleanup('cleanup.html');
    const page = bm.getPage();
    const overflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
    expect(overflow).not.toBe('hidden');
  });
});

// ─── Metrics ───────────────────────────────────────────────────

describe('cleanup: metrics', () => {
  test('reports removal count and estimated token savings', async () => {
    const result = await gotoAndCleanup('cleanup.html');
    expect(result).toContain('Cleaned');
    expect(result).toContain('token');
    // Should report numbers
    expect(result).toMatch(/\d+/);
  });
});

// ─── No-op on Clean Page ───────────────────────────────────────

describe('cleanup: clean page', () => {
  test('handles pages with no noise gracefully', async () => {
    const result = await gotoAndCleanup('cleanup-clean.html');
    expect(result).toContain('0');
    // Main content still there
    const text = await handleReadCommand('text', [], bm);
    expect(text).toContain('This Page Has No Noise');
  });
});

// ─── Shadow DOM ────────────────────────────────────────────────

describe('cleanup: shadow DOM', () => {
  test('handles Shadow DOM overlays', async () => {
    const result = await gotoAndCleanup('cleanup-shadow.html');
    // Content preserved
    const text = await handleReadCommand('text', [], bm);
    expect(text).toContain('Article Behind Shadow Overlay');
  });
});

// ─── Idempotency ───────────────────────────────────────────────

describe('cleanup: idempotent', () => {
  test('multiple cleanup calls are idempotent', async () => {
    await handleWriteCommand('goto', [`${baseUrl}/cleanup.html`], bm);
    const result1 = await handleWriteCommand('cleanup', [], bm);
    const result2 = await handleWriteCommand('cleanup', [], bm);
    // Second call should still work, just find nothing or less
    expect(result2).toContain('Cleaned');
    // Content still preserved
    const text = await handleReadCommand('text', [], bm);
    expect(text).toContain('Important Article Title');
  });
});
