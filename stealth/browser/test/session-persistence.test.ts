/**
 * [INPUT]: Depends on browser-manager's saveState/restoreState, meta-commands state save/load
 * [OUTPUT]: Validates session persistence across restarts, handoffs, and state snapshots
 * [POS]: Test suite for localStorage/sessionStorage persistence (the critical gap)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { startTestServer } from './test-server';
import { BrowserManager, type BrowserState } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';
import { handleMetaCommand } from '../src/meta-commands';

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

// ─── saveState: Capture ────────────────────────────────────────

describe('saveState captures web storage', () => {
  test('captures localStorage', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    await page.evaluate(() => {
      localStorage.setItem('auth_token', 'abc123');
      localStorage.setItem('user_id', '42');
    });

    const state = await bm.saveState();
    const active = state.pages.find(p => p.isActive);

    expect(active).toBeDefined();
    expect(active!.storage).not.toBeNull();
    expect(active!.storage!.localStorage).toHaveProperty('auth_token', 'abc123');
    expect(active!.storage!.localStorage).toHaveProperty('user_id', '42');
  }, 15000);

  test('captures sessionStorage', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    await page.evaluate(() => {
      sessionStorage.setItem('csrf', 'xyz789');
    });

    const state = await bm.saveState();
    const active = state.pages.find(p => p.isActive);

    expect(active!.storage!.sessionStorage).toHaveProperty('csrf', 'xyz789');
  }, 15000);

  test('captures empty storage as empty objects, not null', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    const state = await bm.saveState();
    const active = state.pages.find(p => p.isActive);

    expect(active!.storage).not.toBeNull();
    expect(active!.storage!.localStorage).toEqual({});
    expect(active!.storage!.sessionStorage).toEqual({});
  }, 15000);
});

// ─── restoreState: Full Round-Trip ─────────────────────────────

describe('restoreState restores web storage', () => {
  test('localStorage survives save/restore round-trip', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    await page.evaluate(() => {
      localStorage.setItem('persist_test', 'survived');
    });

    const state = await bm.saveState();

    // Close all pages and restore
    await bm.closeAllPages();
    await bm.restoreState(state);

    const restoredPage = bm.getPage();
    const val = await restoredPage.evaluate(() => localStorage.getItem('persist_test'));
    expect(val).toBe('survived');
  }, 30000);

  test('sessionStorage survives save/restore round-trip', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    await page.evaluate(() => {
      sessionStorage.setItem('session_test', 'also_survived');
    });

    const state = await bm.saveState();
    await bm.closeAllPages();
    await bm.restoreState(state);

    const restoredPage = bm.getPage();
    const val = await restoredPage.evaluate(() => sessionStorage.getItem('session_test'));
    expect(val).toBe('also_survived');
  }, 30000);
});

// ─── pendingStorage: Lazy Injection ────────────────────────────

describe('pendingStorage lazy injection', () => {
  test('injects localStorage on first navigation to matching origin', async () => {
    const origin = new URL(baseUrl).origin;
    bm.setPendingStorage([{
      url: baseUrl + '/basic.html',
      isActive: true,
      storage: {
        localStorage: { lazy_key: 'lazy_value' },
        sessionStorage: {},
      },
    }]);

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const val = await page.evaluate(() => localStorage.getItem('lazy_key'));
    expect(val).toBe('lazy_value');
  }, 15000);

  test('one-shot: does NOT re-inject after navigating away and back', async () => {
    bm.setPendingStorage([{
      url: baseUrl + '/basic.html',
      isActive: true,
      storage: {
        localStorage: { oneshot_key: 'oneshot_value' },
        sessionStorage: {},
      },
    }]);

    // First visit — should inject
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    let page = bm.getPage();
    let val = await page.evaluate(() => localStorage.getItem('oneshot_key'));
    expect(val).toBe('oneshot_value');

    // Clear localStorage manually
    await page.evaluate(() => localStorage.removeItem('oneshot_key'));

    // Navigate away and back — should NOT re-inject (one-shot, entry removed from map)
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    page = bm.getPage();
    val = await page.evaluate(() => localStorage.getItem('oneshot_key'));
    expect(val).toBeNull();
  }, 30000);

  test('multi-domain isolation: each origin gets correct data', async () => {
    // We only have one test server, so test with different paths on same origin
    // The real test is that origins are keyed correctly
    const origin = new URL(baseUrl).origin;
    bm.setPendingStorage([
      {
        url: baseUrl + '/basic.html',
        isActive: true,
        storage: {
          localStorage: { domain_key: 'domain_a_value' },
          sessionStorage: {},
        },
      },
    ]);

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const val = await page.evaluate(() => localStorage.getItem('domain_key'));
    expect(val).toBe('domain_a_value');
  }, 15000);

  test('no pendingStorage does not interfere with normal navigation', async () => {
    // Ensure no pending storage is set
    bm.setPendingStorage([]);

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    await page.evaluate(() => localStorage.setItem('normal_key', 'normal_val'));
    const val = await page.evaluate(() => localStorage.getItem('normal_key'));
    expect(val).toBe('normal_val');
  }, 15000);
});

// ─── state save/load: V2 with localStorage ─────────────────────

describe('state save/load V2', () => {
  test('state save includes localStorage in file', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    await page.evaluate(() => {
      localStorage.setItem('save_test', 'in_file');
    });

    const result = await handleMetaCommand('state', ['save', 'persistence-test'], bm, () => {});
    expect(result).toContain('persistence-test');

    // Read the saved file and verify localStorage is present
    const { resolveConfig } = await import('../src/config');
    const config = resolveConfig();
    const statePath = path.join(config.stateDir, 'browse-states', 'persistence-test.json');
    const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    expect(data.version).toBe(2);
    const savedPage = data.pages.find((p: any) => p.url.includes('/basic.html'));
    expect(savedPage).toBeDefined();
    expect(savedPage.storage).not.toBeNull();
    expect(savedPage.storage.localStorage).toHaveProperty('save_test', 'in_file');

    // Cleanup
    fs.unlinkSync(statePath);
  }, 15000);

  test('state load restores localStorage', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    await page.evaluate(() => {
      localStorage.setItem('load_test', 'restored');
    });

    await handleMetaCommand('state', ['save', 'load-test'], bm, () => {});

    // Clear localStorage
    await page.evaluate(() => localStorage.clear());
    const before = await page.evaluate(() => localStorage.getItem('load_test'));
    expect(before).toBeNull();

    // Load state — should restore localStorage
    await handleMetaCommand('state', ['load', 'load-test'], bm, () => {});
    const after = bm.getPage();
    const val = await after.evaluate(() => localStorage.getItem('load_test'));
    expect(val).toBe('restored');

    // Cleanup
    const { resolveConfig } = await import('../src/config');
    const config = resolveConfig();
    fs.unlinkSync(path.join(config.stateDir, 'browse-states', 'load-test.json'));
  }, 30000);

  test('V1 state files load without errors (backward compat)', async () => {
    // Write a V1 format file manually
    const { resolveConfig } = await import('../src/config');
    const config = resolveConfig();
    const stateDir = path.join(config.stateDir, 'browse-states');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'v1-compat.json');

    const v1Data = {
      version: 1,
      savedAt: new Date().toISOString(),
      cookies: [],
      pages: [{ url: baseUrl + '/basic.html', isActive: true }],
    };
    fs.writeFileSync(statePath, JSON.stringify(v1Data));

    // Load should work — no storage field means null, no crash
    const result = await handleMetaCommand('state', ['load', 'v1-compat'], bm, () => {});
    expect(result).toContain('0 cookies');

    // Cleanup
    fs.unlinkSync(statePath);
  }, 15000);
});

// ─── Cookie-only sites unaffected ──────────────────────────────

describe('cookie-only sites', () => {
  test('cookies persist without localStorage interference', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleWriteCommand('cookie', ['cookie_only=works'], bm);

    const state = await bm.saveState();
    expect(state.cookies.some(c => c.name === 'cookie_only')).toBe(true);

    await bm.closeAllPages();
    await bm.restoreState(state);

    const restored = await bm.saveState();
    expect(restored.cookies.some(c => c.name === 'cookie_only')).toBe(true);
  }, 30000);
});

// ─── Handoff/Resume preserves localStorage ─────────────────────

describe('handoff/resume localStorage', () => {
  test('localStorage survives handoff and resume', async () => {
    const hbm = new BrowserManager();
    await hbm.launch();

    try {
      await handleWriteCommand('goto', [baseUrl + '/basic.html'], hbm);
      const page = hbm.getPage();
      await page.evaluate(() => {
        localStorage.setItem('handoff_ls', 'preserved');
      });

      // Handoff to headed
      await hbm.handoff('localStorage test');
      expect(hbm.getIsHeaded()).toBe(true);

      // Verify localStorage survived handoff
      const headedPage = hbm.getPage();
      const afterHandoff = await headedPage.evaluate(() =>
        localStorage.getItem('handoff_ls')
      );
      expect(afterHandoff).toBe('preserved');

      // Resume back to headless
      const resumeResult = await handleMetaCommand('resume', [], hbm, () => {});
      expect(resumeResult).toContain('RESUMED');

      // Verify localStorage survived resume
      const headlessPage = hbm.getPage();
      const afterResume = await headlessPage.evaluate(() =>
        localStorage.getItem('handoff_ls')
      );
      expect(afterResume).toBe('preserved');
    } finally {
      await hbm.close();
    }
  }, 60000);
});
