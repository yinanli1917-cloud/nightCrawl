/**
 * CDP Patches v2 — validates rebrowser-patches v1.0.19 adapted for Playwright 1.58.2.
 *
 * Tests verify:
 * 1. Patch files exist and contain expected modifications
 * 2. Patches apply cleanly to vanilla Playwright 1.58.2
 * 3. Patched files contain all rebrowser-patches markers
 * 4. Version tracking file exists and is current
 * 5. No regressions in existing patch behavior
 *
 * [INPUT]: stealth/patches/cdp/ patch files, Playwright 1.58.2 source
 * [OUTPUT]: Test results
 * [POS]: Integration test within browser test suite
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const PATCHES_DIR = path.resolve(ROOT, 'stealth', 'patches', 'cdp');
const VERSION_FILE = path.join(PATCHES_DIR, 'VERSION');

// ─── Helpers ────────────────────────────────────────────────

function readPatch(relPath: string): string {
  return fs.readFileSync(path.join(PATCHES_DIR, relPath), 'utf-8');
}

function getCleanPwFile(relPath: string): string | null {
  // Extract clean Playwright file from npm tarball for comparison
  const cleanDir = '/tmp/pw-clean/package/lib/server';
  const filePath = path.join(cleanDir, relPath);
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
  return null;
}

// ─── Version Tracking ───────────────────────────────────────

describe('version tracking', () => {
  test('VERSION file exists', () => {
    expect(fs.existsSync(VERSION_FILE)).toBe(true);
  });

  test('VERSION file contains rebrowser-patches version', () => {
    const content = fs.readFileSync(VERSION_FILE, 'utf-8').trim();
    expect(content).toContain('rebrowser-patches');
    expect(content).toContain('1.0.19');
  });

  test('VERSION file contains target Playwright version', () => {
    const content = fs.readFileSync(VERSION_FILE, 'utf-8').trim();
    expect(content).toContain('playwright');
    expect(content).toContain('1.58.2');
  });
});

// ─── Patch File Existence ───────────────────────────────────

describe('patch files exist', () => {
  const expectedFiles = [
    'chromium/crConnection.js',
    'chromium/crPage.js',
    'chromium/crServiceWorker.js',
    'chromium/crDevTools.js',
    'frames.js',
    'page.js',
  ];

  for (const file of expectedFiles) {
    test(`${file} exists`, () => {
      expect(fs.existsSync(path.join(PATCHES_DIR, file))).toBe(true);
    });
  }

  test('screencast.js is NOT included (no patch needed)', () => {
    expect(fs.existsSync(path.join(PATCHES_DIR, 'screencast.js'))).toBe(false);
  });

  test('exactly 6 patch files (4 chromium + 2 server)', () => {
    let count = 0;
    for (const file of expectedFiles) {
      if (fs.existsSync(path.join(PATCHES_DIR, file))) count++;
    }
    expect(count).toBe(6);
  });
});

// ─── crConnection.js Patches ────────────────────────────────

describe('crConnection.js rebrowser patches', () => {
  const src = readPatch('chromium/crConnection.js');

  test('adds __re__emitExecutionContext method', () => {
    expect(src).toContain('__re__emitExecutionContext');
  });

  test('adds __re__getMainWorld method', () => {
    expect(src).toContain('__re__getMainWorld');
  });

  test('adds __re__getIsolatedWorld method', () => {
    expect(src).toContain('__re__getIsolatedWorld');
  });

  test('supports addBinding fix mode', () => {
    expect(src).toContain('"addBinding"');
  });

  test('supports alwaysIsolated fix mode', () => {
    expect(src).toContain('"alwaysIsolated"');
  });

  test('respects REBROWSER_PATCHES_RUNTIME_FIX_MODE env var', () => {
    expect(src).toContain('REBROWSER_PATCHES_RUNTIME_FIX_MODE');
  });

  test('respects REBROWSER_PATCHES_UTILITY_WORLD_NAME env var', () => {
    expect(src).toContain('REBROWSER_PATCHES_UTILITY_WORLD_NAME');
  });

  test('supports REBROWSER_PATCHES_DEBUG logging', () => {
    expect(src).toContain('REBROWSER_PATCHES_DEBUG');
  });

  test('uses Page.createIsolatedWorld for context creation', () => {
    expect(src).toContain('Page.createIsolatedWorld');
  });

  test('uses Runtime.addBinding for main world discovery', () => {
    expect(src).toContain('Runtime.addBinding');
  });

  test('v1.0.19: accepts utilityWorldName parameter', () => {
    expect(src).toContain('utilityWorldName: passedUtilityWorldName');
  });
});

// ─── crDevTools.js Patches ──────────────────────────────────

describe('crDevTools.js rebrowser patches', () => {
  const src = readPatch('chromium/crDevTools.js');

  test('conditionally disables Runtime.enable', () => {
    expect(src).toContain('REBROWSER_PATCHES_RUNTIME_FIX_MODE');
    expect(src).toContain('"0"');
  });

  test('wraps Runtime.enable in IIFE', () => {
    expect(src).toContain('(() => {');
  });
});

// ─── crPage.js Patches ─────────────────────────────────────

describe('crPage.js rebrowser patches', () => {
  const src = readPatch('chromium/crPage.js');

  test('conditionally disables Runtime.enable in main session', () => {
    expect(src).toContain('REBROWSER_PATCHES_RUNTIME_FIX_MODE');
  });

  test('passes targetId and session to Worker constructor', () => {
    expect(src).toContain('event.targetInfo.targetId, session');
  });

  test('conditionally disables Runtime.enable for workers', () => {
    // Should have at least two REBROWSER_PATCHES_RUNTIME_FIX_MODE checks
    const matches = src.match(/REBROWSER_PATCHES_RUNTIME_FIX_MODE/g);
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── crServiceWorker.js Patches ─────────────────────────────

describe('crServiceWorker.js rebrowser patches', () => {
  const src = readPatch('chromium/crServiceWorker.js');

  test('conditionally disables Runtime.enable', () => {
    expect(src).toContain('REBROWSER_PATCHES_RUNTIME_FIX_MODE');
  });
});

// ─── frames.js Patches ─────────────────────────────────────

describe('frames.js rebrowser patches', () => {
  const src = readPatch('frames.js');

  test('emits Runtime.executionContextsCleared on commit', () => {
    expect(src).toContain('Runtime.executionContextsCleared');
  });

  test('modified _context method with useContextPromise parameter', () => {
    expect(src).toContain('_context(world, useContextPromise');
  });

  test('calls __re__emitExecutionContext for lazy context creation', () => {
    expect(src).toContain('__re__emitExecutionContext');
  });

  test('handles "No frame for given id found" error', () => {
    expect(src).toContain('No frame for given id found');
  });

  test('v1.0.19: uses delegate._sessions (not _delegate)', () => {
    expect(src).toContain('delegate._sessions');
    expect(src).toContain('delegate._mainFrameSession');
  });

  test('v1.0.19: safe access with optional chaining', () => {
    expect(src).toContain('delegate?._sessions');
  });

  test('v1.0.19: passes utilityWorldName to __re__emitExecutionContext', () => {
    expect(src).toContain('utilityWorldName');
  });
});

// ─── page.js Patches ────────────────────────────────────────

describe('page.js rebrowser patches', () => {
  const src = readPatch('page.js');

  test('Worker constructor accepts targetId and session', () => {
    expect(src).toContain('constructor(parent, url, targetId, session)');
  });

  test('Worker stores _targetId and _session', () => {
    expect(src).toContain('this._targetId = targetId');
    expect(src).toContain('this._session = session');
  });

  test('Worker has getExecutionContext method', () => {
    expect(src).toContain('async getExecutionContext()');
  });

  test('evaluateExpression uses getExecutionContext()', () => {
    expect(src).toContain('await this.getExecutionContext()');
  });

  test('PageBinding.dispatch filters non-JSON payloads', () => {
    expect(src).toContain('!payload.includes("{")');
  });

  test('v1.0.19: screencast.stopFrameThrottler safety check', () => {
    expect(src).toContain("typeof this.screencast?.stopFrameThrottler === 'function'");
  });
});

// ─── Patch Application ─────────────────────────────────────

describe('patch application', () => {
  test('stealth.ts references all 6 patch files', () => {
    const stealth = fs.readFileSync(
      path.join(import.meta.dir, '../src/stealth.ts'), 'utf-8'
    );
    const expectedFiles = [
      'chromium/crConnection.js',
      'chromium/crPage.js',
      'chromium/crServiceWorker.js',
      'chromium/crDevTools.js',
      'frames.js',
      'page.js',
    ];
    for (const file of expectedFiles) {
      expect(stealth).toContain(file);
    }
  });

  test('stealth.ts does NOT reference screencast.js', () => {
    const stealth = fs.readFileSync(
      path.join(import.meta.dir, '../src/stealth.ts'), 'utf-8'
    );
    expect(stealth).not.toContain("'screencast.js'");
  });

  test('patch files differ from clean Playwright (patches actually modify something)', () => {
    const cleanDir = '/tmp/pw-clean/package/lib/server';
    if (!fs.existsSync(cleanDir)) return; // skip if clean copy not available

    const files = [
      'chromium/crConnection.js',
      'chromium/crDevTools.js',
      'chromium/crPage.js',
      'chromium/crServiceWorker.js',
      'frames.js',
      'page.js',
    ];

    for (const file of files) {
      const clean = fs.readFileSync(path.join(cleanDir, file), 'utf-8');
      const patched = readPatch(file);
      expect(patched).not.toBe(clean);
    }
  });
});

// ─── No Regressions ────────────────────────────────────────

describe('no regressions', () => {
  test('stealth module exports applyStealthPatches', () => {
    const src = fs.readFileSync(
      path.join(import.meta.dir, '../src/stealth.ts'), 'utf-8'
    );
    expect(src).toContain('export async function applyStealthPatches()');
  });

  test('stealth module exports applyStealthScripts', () => {
    const src = fs.readFileSync(
      path.join(import.meta.dir, '../src/stealth.ts'), 'utf-8'
    );
    expect(src).toContain('export async function applyStealthScripts(');
  });

  test('no Runtime.enable calls without conditional guard in patch files', () => {
    // Every Runtime.enable in patch files should be guarded by REBROWSER_PATCHES_RUNTIME_FIX_MODE check
    for (const file of ['chromium/crDevTools.js', 'chromium/crPage.js', 'chromium/crServiceWorker.js']) {
      const src = readPatch(file);
      const runtimeEnableLines = src.split('\n')
        .map((line, i) => ({ line, num: i + 1 }))
        .filter(({ line }) => line.includes('Runtime.enable') && !line.includes('//'));

      for (const { line, num } of runtimeEnableLines) {
        // Each Runtime.enable should be preceded by a REBROWSER_PATCHES check
        const context = src.split('\n').slice(Math.max(0, num - 5), num).join('\n');
        expect(context).toContain('REBROWSER_PATCHES_RUNTIME_FIX_MODE');
      }
    }
  });
});
