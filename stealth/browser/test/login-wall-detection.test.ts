/**
 * Login Wall Detection tests — integration tests with real browser.
 *
 * Tests detectLoginWall() against HTML fixtures (login form vs open page),
 * URL pattern matching, and the new consent-based gate.
 *
 * Design: detectLoginWall ALWAYS runs (no env gate). The returned shape
 * now includes { domain, approved } so callers can decide whether to
 * invoke autoHandover (pop a window) or surface CONSENT_REQUIRED.
 * See memory/feedback_proactive_handoff_ux.md and
 * memory/project_canvas_regression_2026_04_14.md for why.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';
import { defaultConsentPath, grant, emptyStore, writeConsent } from '../src/handoff-consent';

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;
let savedConsent: string | null = null;

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

beforeEach(() => {
  // Snapshot and clear the real consent store so tests never leak approvals
  // into the user's ~/.nightcrawl/state/ or inherit prior test state.
  try {
    savedConsent = fs.readFileSync(defaultConsentPath(), 'utf-8');
  } catch {
    savedConsent = null;
  }
  try { fs.unlinkSync(defaultConsentPath()); } catch {}
});

afterEach(() => {
  if (savedConsent !== null) {
    fs.mkdirSync(path.dirname(defaultConsentPath()), { recursive: true });
    fs.writeFileSync(defaultConsentPath(), savedConsent);
  } else {
    try { fs.unlinkSync(defaultConsentPath()); } catch {}
  }
});

// ─── HTML Fixture Detection (always runs, no env gate) ──────

describe('detectLoginWall with fixtures', () => {
  test('returns detected:true for login-wall.html (password input + Chinese heading)', async () => {
    await handleWriteCommand('goto', [baseUrl + '/login-wall.html'], bm);
    const result = await bm.detectLoginWall();
    expect(result).not.toBeNull();
    expect(result!.detected).toBe(true);
  }, 15000);

  test('returns null for open-page.html (no login elements)', async () => {
    await handleWriteCommand('goto', [baseUrl + '/open-page.html'], bm);
    const result = await bm.detectLoginWall();
    expect(result).toBeNull();
  }, 15000);
});

// ─── URL Pattern Detection ──────────────────────────────────

describe('detectLoginWall URL patterns', () => {
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
      await handleWriteCommand('goto', [baseUrl + urlPath], bm);
      const result = await bm.detectLoginWall();
      expect(result).not.toBeNull();
      expect(result!.detected).toBe(true);
      expect(result!.reason).toContain('Login URL detected');
    }, 15000);
  }
});

// ─── Gating: by consent (replaces old env-var gate) ─────────

describe('detectLoginWall consent gating', () => {
  test('returns detected:true with approved:false when no consent entry exists', async () => {
    // No consent file → detected but NOT approved (agent must ask user).
    await handleWriteCommand('goto', [baseUrl + '/login-wall.html'], bm);
    const result = await bm.detectLoginWall();
    expect(result).not.toBeNull();
    expect(result!.detected).toBe(true);
    expect(result!.approved).toBe(false);
    expect(result!.domain).toBeTruthy();
  }, 15000);

  test('returns detected:true with approved:true after grant', async () => {
    // Grant consent for the test server's eTLD+1, then re-run.
    // baseUrl is like http://localhost:PORT — eTLD+1 becomes "localhost".
    const store = grant(emptyStore(), baseUrl);
    writeConsent(defaultConsentPath(), store);

    await handleWriteCommand('goto', [baseUrl + '/login-wall.html'], bm);
    const result = await bm.detectLoginWall();
    expect(result).not.toBeNull();
    expect(result!.detected).toBe(true);
    expect(result!.approved).toBe(true);
  }, 15000);

  test('returns null when in headed mode (detection suppressed)', async () => {
    // The isHeaded short-circuit remains — no point detecting walls when
    // the user is already driving the browser manually.
    (bm as any).isHeaded = true;
    try {
      await handleWriteCommand('goto', [baseUrl + '/login-wall.html'], bm);
      const result = await bm.detectLoginWall();
      expect(result).toBeNull();
    } finally {
      (bm as any).isHeaded = false;
    }
  }, 15000);
});
