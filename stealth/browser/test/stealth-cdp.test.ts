/**
 * CDP Patch tests — file existence checks + stealth module audit.
 *
 * Verifies that patch files exist and stealth functions are exported.
 * CDP patches are currently disabled (incompatible with Playwright 1.58.2)
 * but the files must remain for when we port them to the new version.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const STEALTH_SRC = fs.readFileSync(
  path.join(import.meta.dir, '../src/stealth.ts'), 'utf-8'
);

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

  test('browser-manager imports from stealth module', () => {
    expect(BROWSER_MANAGER_SRC).toContain("from './stealth'");
    expect(BROWSER_MANAGER_SRC).toContain('applyStealthScripts');
    expect(BROWSER_MANAGER_SRC).toContain('DEFAULT_USER_AGENT');
  });

  test('applyStealthScripts called in launch()', () => {
    const idx = BROWSER_MANAGER_SRC.indexOf('async launch()');
    const block = BROWSER_MANAGER_SRC.slice(idx, BROWSER_MANAGER_SRC.indexOf('async launchHeaded', idx));
    expect(block).toContain('applyStealthScripts');
  });

  test('applyStealthScripts called in launchHeaded()', () => {
    const idx = BROWSER_MANAGER_SRC.indexOf('async launchHeaded');
    const block = BROWSER_MANAGER_SRC.slice(idx, BROWSER_MANAGER_SRC.indexOf('async close()', idx));
    expect(block).toContain('applyStealthScripts');
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
