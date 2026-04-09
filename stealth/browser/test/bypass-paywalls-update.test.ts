/**
 * [INPUT]: Depends on stealth/extensions/bypass-paywalls-chrome/ on disk
 * [OUTPUT]: Validates extension integrity, version, and site coverage
 * [POS]: TDD guard for bypass-paywalls-chrome-clean extension updates
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const EXT_DIR = path.resolve(
  import.meta.dir, '../../extensions/bypass-paywalls-chrome'
);

// ─── Manifest Integrity ────────────────────────────────────────

describe('bypass-paywalls-chrome manifest', () => {
  test('manifest.json exists', () => {
    expect(fs.existsSync(path.join(EXT_DIR, 'manifest.json'))).toBe(true);
  });

  test('manifest.json is valid JSON', () => {
    const raw = fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test('manifest has required fields', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf-8')
    );
    expect(manifest.name).toBe('Bypass Paywalls Clean');
    expect(manifest.manifest_version).toBeGreaterThanOrEqual(2);
    expect(manifest.version).toBeDefined();
    expect(manifest.description).toContain('Bypass Paywalls');
  });

  test('version is 4.3.4.0 or newer', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf-8')
    );
    const parts = manifest.version.split('.').map(Number);
    // Compare as [major, minor, patch, build] >= [4, 3, 4, 0]
    const min = [4, 3, 4, 0];
    let cmp = 0;
    for (let i = 0; i < 4; i++) {
      const a = parts[i] || 0;
      const b = min[i] || 0;
      if (a > b) { cmp = 1; break; }
      if (a < b) { cmp = -1; break; }
    }
    expect(cmp).toBeGreaterThanOrEqual(0);
  });
});

// ─── Key Files Exist ───────────────────────────────────────────

describe('bypass-paywalls-chrome key files', () => {
  test('has background script (service worker for MV3)', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf-8')
    );
    // MV3 uses service_worker, MV2 uses background.scripts
    const bgFile = manifest.manifest_version === 3
      ? manifest.background?.service_worker
      : manifest.background?.scripts?.[manifest.background.scripts.length - 1];
    expect(bgFile).toBeDefined();
    expect(fs.existsSync(path.join(EXT_DIR, bgFile))).toBe(true);
  });

  test('has content scripts', () => {
    expect(fs.existsSync(path.join(EXT_DIR, 'contentScript.js'))).toBe(true);
    expect(fs.existsSync(path.join(EXT_DIR, 'contentScript_once.js'))).toBe(true);
  });

  test('has sites configuration', () => {
    expect(fs.existsSync(path.join(EXT_DIR, 'sites.js'))).toBe(true);
  });

  test('has options page', () => {
    expect(fs.existsSync(path.join(EXT_DIR, 'options'))).toBe(true);
  });
});

// ─── Site Coverage ─────────────────────────────────────────────

describe('bypass-paywalls-chrome site coverage', () => {
  const MAJOR_SITES = [
    'nytimes.com',
    'theatlantic.com',
    'washingtonpost.com',
    'wsj.com',
    'wired.com',
    'bloomberg.com',
    'economist.com',
    'ft.com',
  ];

  test('manifest covers major paywalled sites', () => {
    const raw = fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf-8');
    for (const site of MAJOR_SITES) {
      expect(raw).toContain(site);
    }
  });

  test('sites.js references major paywalled sites', () => {
    const sitesRaw = fs.readFileSync(path.join(EXT_DIR, 'sites.js'), 'utf-8');
    for (const site of MAJOR_SITES) {
      expect(sitesRaw).toContain(site);
    }
  });
});
