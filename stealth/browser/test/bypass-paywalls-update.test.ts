/**
 * [INPUT]: Depends on stealth/extensions/bypass-paywalls-chrome/ on disk
 * [OUTPUT]: Validates extension integrity, version, and site coverage
 * [POS]: TDD guard for bypass-paywalls-chrome-clean extension updates
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { parseBypassPaywallsUpdateXml } from '../src/extension-updater';

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

  test('version is 4.3.6.5', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf-8')
    );
    expect(manifest.version).toBe('4.3.6.5');
  });

  test('declares upstream CRX update feed', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf-8')
    );
    expect(manifest.update_url).toBe('https://gitflic.ru/project/magnolia1234/bpc_updates/blob/raw?file=updates.xml');
  });
});

describe('bypass-paywalls-chrome update feed', () => {
  test('parses upstream gupdate XML', () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='lkbebcjgcmobigpeffafkodonchffocl'>
    <updatecheck codebase='https://gitflic.ru/project/magnolia1234/bpc_uploads/blob/raw?file=bypass-paywalls-chrome-clean-4.3.6.5.crx' version='4.3.6.5' />
  </app>
</gupdate>`;
    expect(parseBypassPaywallsUpdateXml(xml)).toEqual({
      appId: 'lkbebcjgcmobigpeffafkodonchffocl',
      codebase: 'https://gitflic.ru/project/magnolia1234/bpc_uploads/blob/raw?file=bypass-paywalls-chrome-clean-4.3.6.5.crx',
      version: '4.3.6.5',
    });
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
