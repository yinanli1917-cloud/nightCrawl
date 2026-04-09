/**
 * CDP Patch tests — file existence checks + stealth module audit.
 *
 * Verifies that patch files exist and stealth functions are exported.
 * CDP patches are based on rebrowser-patches v1.0.19, adapted for Playwright 1.58.2.
 * See cdp-patches-v2.test.ts for detailed patch content verification.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const STEALTH_SRC = fs.readFileSync(
  path.join(import.meta.dir, '../src/stealth.ts'), 'utf-8'
);

// browser-manager.ts may or may not import from stealth directly;
// stealth integration is tested in cdp-patches-v2.test.ts
const BROWSER_MANAGER_SRC = fs.readFileSync(
  path.join(import.meta.dir, '../src/browser-manager.ts'), 'utf-8'
);

const PATCHES_DIR = path.resolve(import.meta.dir, '..', '..', 'patches', 'cdp');

// ─── Stealth Module Audit ──────────────────────────────────────

describe('stealth module', () => {
  test('exports applyStealthPatches', () => {
    expect(STEALTH_SRC).toContain('export async function applyStealthPatches()');
  });

  test('exports applyStealthScripts', () => {
    expect(STEALTH_SRC).toContain('export async function applyStealthScripts(');
  });

  test('exports DEFAULT_USER_AGENT derived from browsers.json', () => {
    expect(STEALTH_SRC).toContain('browsers.json');
    expect(STEALTH_SRC).toContain('export const DEFAULT_USER_AGENT');
  });

  test('exports findChromiumExecutable', () => {
    expect(STEALTH_SRC).toContain('export function findChromiumExecutable()');
  });

  test('browser-manager has applyStealthPatches function', () => {
    expect(BROWSER_MANAGER_SRC).toContain('applyStealthPatches');
    expect(BROWSER_MANAGER_SRC).toContain('DEFAULT_USER_AGENT');
  });

  test('stealth scripts patch navigator.webdriver', () => {
    expect(STEALTH_SRC).toContain("'webdriver'");
    expect(STEALTH_SRC).toContain('() => false');
  });

  test('patch map references all 6 files', () => {
    const expectedFiles = [
      'chromium/crConnection.js',
      'chromium/crPage.js',
      'chromium/crServiceWorker.js',
      'chromium/crDevTools.js',
      'frames.js',
      'page.js',
    ];
    for (const file of expectedFiles) {
      expect(STEALTH_SRC).toContain(file);
    }
  });
});

// ─── Patch Files Exist ──────────────────────────────────────────

describe('CDP patch files', () => {
  const expectedFiles = [
    'chromium/crConnection.js',
    'chromium/crPage.js',
    'chromium/crServiceWorker.js',
    'chromium/crDevTools.js',
    'frames.js',
    'page.js',
  ];

  for (const file of expectedFiles) {
    test(`${file} exists in patches/cdp/`, () => {
      const fullPath = path.join(PATCHES_DIR, file);
      expect(fs.existsSync(fullPath)).toBe(true);
    });
  }

  test('all 6 patch files are present', () => {
    let count = 0;
    for (const file of expectedFiles) {
      if (fs.existsSync(path.join(PATCHES_DIR, file))) count++;
    }
    expect(count).toBe(6);
  });
});
