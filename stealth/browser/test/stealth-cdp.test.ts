/**
 * CDP Patch Application tests — source-level audits + file existence checks.
 *
 * Verifies that stealth patches are correctly wired into browser-manager.ts
 * and that all 6 patch files exist in the expected location.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const BROWSER_MANAGER_SRC = fs.readFileSync(
  path.join(import.meta.dir, '../src/browser-manager.ts'), 'utf-8'
);

const PATCHES_DIR = path.resolve(import.meta.dir, '..', '..', 'patches', 'cdp');

// Helper: extract a block of source between two markers (from server-auth.test.ts pattern)
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Marker not found: ${startMarker}`);
  const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) throw new Error(`End marker not found: ${endMarker}`);
  return source.slice(startIdx, endIdx);
}

// ─── Source-Level Audit: Patch Wiring ───────────────────────────

describe('CDP patch wiring (source audit)', () => {
  test('applyStealthPatches() is called before chromium.launch in launch()', () => {
    const launchBlock = sliceBetween(BROWSER_MANAGER_SRC, 'async launch()', 'async launchHeaded');
    const patchIdx = launchBlock.indexOf('applyStealthPatches()');
    const chromiumLaunchIdx = launchBlock.indexOf('chromium.launch');
    const persistentContextIdx = launchBlock.indexOf('chromium.launchPersistentContext');

    expect(patchIdx).not.toBe(-1);
    // Patches must come before either launch variant
    const earliestLaunch = Math.min(
      chromiumLaunchIdx === -1 ? Infinity : chromiumLaunchIdx,
      persistentContextIdx === -1 ? Infinity : persistentContextIdx,
    );
    expect(patchIdx).toBeLessThan(earliestLaunch);
  });

  test('applyStealthPatches() is called before chromium.launch in launchHeaded()', () => {
    const headedBlock = sliceBetween(BROWSER_MANAGER_SRC, 'async launchHeaded', 'async close()');
    const patchIdx = headedBlock.indexOf('applyStealthPatches()');
    const persistentContextIdx = headedBlock.indexOf('chromium.launchPersistentContext');

    expect(patchIdx).not.toBe(-1);
    expect(persistentContextIdx).not.toBe(-1);
    expect(patchIdx).toBeLessThan(persistentContextIdx);
  });

  test('REBROWSER_PATCHES_RUNTIME_FIX_MODE is set to addBinding in launch()', () => {
    const launchBlock = sliceBetween(BROWSER_MANAGER_SRC, 'async launch()', 'async launchHeaded');
    expect(launchBlock).toContain("REBROWSER_PATCHES_RUNTIME_FIX_MODE");
    expect(launchBlock).toContain("'addBinding'");
  });

  test('REBROWSER_PATCHES_RUNTIME_FIX_MODE is set to addBinding in launchHeaded()', () => {
    const headedBlock = sliceBetween(BROWSER_MANAGER_SRC, 'async launchHeaded', 'async close()');
    expect(headedBlock).toContain("REBROWSER_PATCHES_RUNTIME_FIX_MODE");
    expect(headedBlock).toContain("'addBinding'");
  });
});

// ─── applyStealthPatches Function ───────────────────────────────

describe('applyStealthPatches function', () => {
  test('function exists in browser-manager.ts', () => {
    expect(BROWSER_MANAGER_SRC).toContain('async function applyStealthPatches()');
  });

  test('patch map references all 6 files', () => {
    // Extract the patchMap array from source
    const patchMapBlock = sliceBetween(BROWSER_MANAGER_SRC, 'const patchMap', '];');
    const expectedFiles = [
      'chromium/crConnection.js',
      'chromium/crPage.js',
      'chromium/crServiceWorker.js',
      'chromium/crDevTools.js',
      'frames.js',
      'page.js',
    ];
    for (const file of expectedFiles) {
      expect(patchMapBlock).toContain(file);
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
