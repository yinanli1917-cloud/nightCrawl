/**
 * [INPUT]: Depends on fingerprint-clone.ts (device-anchor capture + apply).
 * [OUTPUT]: Verifies anchor round-trips to disk, applyAnchor merges the soft
 *           signals into launch options while KEEPING the persistent seed, and a
 *           null anchor is a no-op.
 * [POS]: Phase-3A Engine-H test. The honest scope: this aligns UA/screen/
 *        timezone/locale to the real device (what cookies/anti-bot read); it
 *        does NOT touch the seed-derived canvas/WebGL hashes (CloakBrowser has
 *        no per-dimension API — documented limitation).
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fpclone-'));
process.env.BROWSE_STATE_FILE = path.join(TMP, 'state', 'browse.json');
fs.mkdirSync(path.dirname(process.env.BROWSE_STATE_FILE), { recursive: true });

import {
  applyAnchor,
  loadDeviceAnchor,
  saveDeviceAnchor,
  anchorFilePath,
  type DeviceAnchor,
} from '../src/fingerprint-clone';

function anchor(): DeviceAnchor {
  return {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) RealChrome/126',
    screen: { width: 1512, height: 982, deviceScaleFactor: 2 },
    platform: 'MacIntel',
    timezone: 'America/Los_Angeles',
    languages: ['en-US', 'en'],
    capturedAt: 1700000000000,
  };
}

describe('fingerprint-clone anchor', () => {
  test('anchorFilePath lives under the isolated stateDir', () => {
    expect(anchorFilePath()).toBe(path.join(TMP, 'state', 'device-anchor.json'));
  });

  test('save then load round-trips the anchor', () => {
    saveDeviceAnchor(anchor());
    const loaded = loadDeviceAnchor();
    expect(loaded).not.toBeNull();
    expect(loaded!.userAgent).toContain('RealChrome/126');
    expect(loaded!.timezone).toBe('America/Los_Angeles');
    expect(loaded!.screen.width).toBe(1512);
  });

  test('loadDeviceAnchor returns null when absent', () => {
    try { fs.unlinkSync(anchorFilePath()); } catch {}
    expect(loadDeviceAnchor()).toBeNull();
  });

  test('applyAnchor merges soft signals but KEEPS the persistent seed', () => {
    const opts = applyAnchor({ fingerprintSeed: 80814, headless: true }, anchor());
    expect(opts.fingerprintSeed).toBe(80814);            // seed untouched
    expect(opts.userAgent).toContain('RealChrome/126');  // UA from anchor
    expect(opts.viewport).toEqual({ width: 1512, height: 982 });
    expect(opts.locale).toBe('en-US');                   // first language
    expect(opts.timezone).toBe('America/Los_Angeles');
    expect(opts.headless).toBe(true);                    // unrelated opts preserved
  });

  test('applyAnchor with a null anchor is a no-op', () => {
    const base = { fingerprintSeed: 80814, headless: true, userAgent: 'orig' };
    expect(applyAnchor(base, null)).toEqual(base);
  });

  test('applyAnchor does not clobber an explicit caller userAgent override', () => {
    // If the caller already set a UA (e.g. a test or BROWSE override), respect it.
    const opts = applyAnchor({ fingerprintSeed: 1, userAgent: 'caller-ua' }, anchor());
    expect(opts.userAgent).toBe('caller-ua');
  });
});
