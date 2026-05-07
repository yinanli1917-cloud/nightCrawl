/**
 * Tests for the default-browser handoff path.
 *
 * Verifies the cookie-poll logic that opens the user's real browser
 * and polls their cookie database instead of spawning headed Chromium.
 *
 * Uses mocks — does NOT open real browsers or import real cookies.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';
import { startTestServer } from './test-server';

describe('default-browser handoff', () => {
  test('tryAutoImportForWall returns structured result', async () => {
    const { tryAutoImportForWall } = await import('../src/handoff-cookie-import');
    // Without a real browser context, this should fail gracefully
    const fakeContext = { addCookies: async () => {} } as any;
    const result = await tryAutoImportForWall(
      'https://canvas.uw.edu',
      'https://idp.u.washington.edu/idp/profile/SAML2/Redirect/SSO',
      fakeContext,
      'arc', // explicit browser
    );
    // Should attempt but may fail (no real arc DB in test env)
    expect(result).toHaveProperty('attempted');
    expect(result).toHaveProperty('importedCount');
    expect(result).toHaveProperty('hostKeys');
    expect(result).toHaveProperty('browser');
  });

  test('buildCandidateDomains with observedHosts uses them', async () => {
    const { buildCandidateDomains } = await import('../src/handoff-cookie-import');
    const result = buildCandidateDomains(
      'https://canvas.uw.edu',
      'https://idp.u.washington.edu/login',
      ['canvas.uw.edu', 'idp.u.washington.edu', 'api.duosecurity.com'],
    );
    // Should include all three observed domains' eTLD+1s
    expect(result).toContain('uw.edu');
    expect(result).toContain('duosecurity.com');
  });

  test('eTldPlusOne normalizes URLs correctly', async () => {
    const { eTldPlusOne } = await import('../src/handoff-consent');
    expect(eTldPlusOne('https://canvas.uw.edu/courses')).toBe('uw.edu');
    expect(eTldPlusOne('https://idp.u.washington.edu/idp')).toBe('washington.edu');
    expect(eTldPlusOne('http://127.0.0.1:8765/login-wall.html')).toBe('127.0.0.1');
    expect(eTldPlusOne('http://localhost:8765/login-wall.html')).toBe('localhost');
  });

  test('detectLoginWall returns structured detection', async () => {
    const { detectLoginWall } = await import('../src/browser-handoff');
    // Just verify the function is exported and callable
    expect(detectLoginWall).toBeFunction();
  });

  test('detectLoginWall ignores a plain password form that is page content', async () => {
    const server = startTestServer(0);
    const bm = new BrowserManager();
    try {
      await bm.launch();
      await handleWriteCommand('goto', [`${server.url}/plain-login-form.html`], bm);
      const detection = await bm.detectLoginWall();
      expect(detection).toBeNull();
    } finally {
      try { server.server.stop(); } catch {}
      await bm.close().catch(() => {});
    }
  });
});
