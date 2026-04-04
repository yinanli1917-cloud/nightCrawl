/**
 * Login Wall Detection tests — integration tests with real browser.
 *
 * Tests detectLoginWall() against HTML fixtures (login form vs open page),
 * URL pattern matching, and gating by env/mode.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';

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

// ─── HTML Fixture Detection ─────────────────────────────────────

describe('detectLoginWall with fixtures', () => {
  test('returns detected:true for login-wall.html (password input + Chinese heading)', async () => {
    // Enable auto-handover for detection to work
    const prev = process.env.BROWSE_AUTO_HANDOVER;
    process.env.BROWSE_AUTO_HANDOVER = '1';

    try {
      await handleWriteCommand('goto', [baseUrl + '/login-wall.html'], bm);
      const result = await bm.detectLoginWall();
      expect(result).not.toBeNull();
      expect(result!.detected).toBe(true);
    } finally {
      process.env.BROWSE_AUTO_HANDOVER = prev;
    }
  }, 15000);

  test('returns null for open-page.html (no login elements)', async () => {
    const prev = process.env.BROWSE_AUTO_HANDOVER;
    process.env.BROWSE_AUTO_HANDOVER = '1';

    try {
      await handleWriteCommand('goto', [baseUrl + '/open-page.html'], bm);
      const result = await bm.detectLoginWall();
      expect(result).toBeNull();
    } finally {
      process.env.BROWSE_AUTO_HANDOVER = prev;
    }
  }, 15000);
});

// ─── URL Pattern Detection ──────────────────────────────────────

describe('detectLoginWall URL patterns', () => {
  // URL pattern detection triggers before page content checks,
  // so we test by navigating to URLs that match the patterns.
  // The test server returns 404 for unknown paths, but that's fine —
  // the URL check happens regardless of page content.

  const loginUrls = [
    '/login',
    '/auth/callback',
    '/captcha/verify',
    '/?action=login',
    '/user/signin',
    '/accounts/sign-in',
  ];

  for (const urlPath of loginUrls) {
    test(`detects login URL: ${urlPath}`, async () => {
      const prev = process.env.BROWSE_AUTO_HANDOVER;
      process.env.BROWSE_AUTO_HANDOVER = '1';

      try {
        await handleWriteCommand('goto', [baseUrl + urlPath], bm);
        const result = await bm.detectLoginWall();
        expect(result).not.toBeNull();
        expect(result!.detected).toBe(true);
        expect(result!.reason).toContain('Login URL detected');
      } finally {
        process.env.BROWSE_AUTO_HANDOVER = prev;
      }
    }, 15000);
  }
});

// ─── Gating: BROWSE_AUTO_HANDOVER ───────────────────────────────

describe('detectLoginWall gating', () => {
  test('returns null when BROWSE_AUTO_HANDOVER is not set', async () => {
    const prev = process.env.BROWSE_AUTO_HANDOVER;
    delete process.env.BROWSE_AUTO_HANDOVER;

    try {
      await handleWriteCommand('goto', [baseUrl + '/login-wall.html'], bm);
      const result = await bm.detectLoginWall();
      expect(result).toBeNull();
    } finally {
      if (prev !== undefined) process.env.BROWSE_AUTO_HANDOVER = prev;
    }
  }, 15000);

  test('returns null when BROWSE_AUTO_HANDOVER is 0', async () => {
    const prev = process.env.BROWSE_AUTO_HANDOVER;
    process.env.BROWSE_AUTO_HANDOVER = '0';

    try {
      await handleWriteCommand('goto', [baseUrl + '/login-wall.html'], bm);
      const result = await bm.detectLoginWall();
      expect(result).toBeNull();
    } finally {
      process.env.BROWSE_AUTO_HANDOVER = prev;
    }
  }, 15000);

  test('returns null when in headed mode', async () => {
    const prev = process.env.BROWSE_AUTO_HANDOVER;
    process.env.BROWSE_AUTO_HANDOVER = '1';

    // Simulate headed mode without actually launching headed
    (bm as any).isHeaded = true;

    try {
      await handleWriteCommand('goto', [baseUrl + '/login-wall.html'], bm);
      const result = await bm.detectLoginWall();
      expect(result).toBeNull();
    } finally {
      (bm as any).isHeaded = false;
      process.env.BROWSE_AUTO_HANDOVER = prev;
    }
  }, 15000);
});
