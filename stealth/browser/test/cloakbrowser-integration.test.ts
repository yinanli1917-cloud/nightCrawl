/**
 * CloakBrowser integration tests
 *
 * Tests: package availability, config parsing, fingerprint profiles,
 * engine selection logic, and seed determinism.
 *
 * Does NOT launch real browsers — unit tests only.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Package Availability ──────────────────────────────────

describe('cloakbrowser package', () => {
  test('is importable', async () => {
    const cb = await import('cloakbrowser');
    expect(cb.launch).toBeFunction();
    expect(cb.launchContext).toBeFunction();
    expect(cb.launchPersistentContext).toBeFunction();
  });

  test('exports getDefaultStealthArgs', async () => {
    const cb = await import('cloakbrowser');
    expect(cb.getDefaultStealthArgs).toBeFunction();
  });

  test('exports ensureBinary', async () => {
    const cb = await import('cloakbrowser');
    expect(cb.ensureBinary).toBeFunction();
  });
});

// ─── Config Parsing ────────────────────────────────────────

describe('engine config', () => {
  test('parseEngineConfig defaults to cloakbrowser', async () => {
    const { parseEngineConfig } = await import('../src/engine-config');
    const cfg = parseEngineConfig({});
    expect(cfg.engine).toBe('cloakbrowser');
    expect(cfg.fingerprintSeed).toBeUndefined();
    expect(cfg.humanize).toBe(false);
  });

  test('parseEngineConfig reads BROWSE_ENGINE=cloakbrowser', async () => {
    const { parseEngineConfig } = await import('../src/engine-config');
    const cfg = parseEngineConfig({ BROWSE_ENGINE: 'cloakbrowser' });
    expect(cfg.engine).toBe('cloakbrowser');
  });

  test('parseEngineConfig reads BROWSE_FINGERPRINT_SEED', async () => {
    const { parseEngineConfig } = await import('../src/engine-config');
    const cfg = parseEngineConfig({ BROWSE_FINGERPRINT_SEED: '42567' });
    expect(cfg.fingerprintSeed).toBe(42567);
  });

  test('parseEngineConfig reads BROWSE_HUMANIZE=1', async () => {
    const { parseEngineConfig } = await import('../src/engine-config');
    const cfg = parseEngineConfig({ BROWSE_HUMANIZE: '1' });
    expect(cfg.humanize).toBe(true);
  });

  test('parseEngineConfig ignores invalid BROWSE_ENGINE', async () => {
    const { parseEngineConfig } = await import('../src/engine-config');
    const cfg = parseEngineConfig({ BROWSE_ENGINE: 'firefox' });
    expect(cfg.engine).toBe('cloakbrowser');
  });

  test('parseEngineConfig ignores non-numeric seed', async () => {
    const { parseEngineConfig } = await import('../src/engine-config');
    const cfg = parseEngineConfig({ BROWSE_FINGERPRINT_SEED: 'abc' });
    expect(cfg.fingerprintSeed).toBeUndefined();
  });
});

// ─── Fingerprint Profiles ──────────────────────────────────

describe('fingerprint profiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `nightcrawl-fp-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('getOrCreateSeed creates deterministic seed for identity', async () => {
    const { getOrCreateSeed } = await import('../src/fingerprint-profiles');
    const seed1 = getOrCreateSeed('alice', tmpDir);
    const seed2 = getOrCreateSeed('alice', tmpDir);
    expect(seed1).toBe(seed2);
    expect(seed1).toBeGreaterThanOrEqual(10000);
    expect(seed1).toBeLessThanOrEqual(99999);
  });

  test('different identities get different seeds', async () => {
    const { getOrCreateSeed } = await import('../src/fingerprint-profiles');
    const seedA = getOrCreateSeed('alice', tmpDir);
    const seedB = getOrCreateSeed('bob', tmpDir);
    expect(seedA).not.toBe(seedB);
  });

  test('seed persists to disk', async () => {
    const { getOrCreateSeed } = await import('../src/fingerprint-profiles');
    const seed = getOrCreateSeed('charlie', tmpDir);
    const filePath = path.join(tmpDir, 'charlie.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.seed).toBe(seed);
  });

  test('listIdentities returns all identities', async () => {
    const { getOrCreateSeed, listIdentities } = await import('../src/fingerprint-profiles');
    getOrCreateSeed('alice', tmpDir);
    getOrCreateSeed('bob', tmpDir);
    const ids = listIdentities(tmpDir);
    expect(ids).toContain('alice');
    expect(ids).toContain('bob');
    expect(ids.length).toBe(2);
  });

  test('deleteIdentity removes identity file', async () => {
    const { getOrCreateSeed, deleteIdentity, listIdentities } = await import('../src/fingerprint-profiles');
    getOrCreateSeed('temp', tmpDir);
    expect(listIdentities(tmpDir)).toContain('temp');
    deleteIdentity('temp', tmpDir);
    expect(listIdentities(tmpDir)).not.toContain('temp');
  });

  test('deleteIdentity is no-op for nonexistent identity', async () => {
    const { deleteIdentity } = await import('../src/fingerprint-profiles');
    expect(() => deleteIdentity('nonexistent', tmpDir)).not.toThrow();
  });

  test('listIdentities returns empty array for empty dir', async () => {
    const { listIdentities } = await import('../src/fingerprint-profiles');
    expect(listIdentities(tmpDir)).toEqual([]);
  });
});

// ─── Screencast Compat ────────────────────────────────────

describe('screencast compat patch', () => {
  test('patchScreencast adds stub when missing', async () => {
    const { patchScreencast } = await import('../src/cloakbrowser-engine');
    const fakePage: any = {};
    patchScreencast(fakePage);
    expect(fakePage.screencast).toBeDefined();
    expect(fakePage.screencast.handlePageOrContextClose).toBeFunction();
    // Must not throw
    await fakePage.screencast.handlePageOrContextClose();
  });

  test('patchScreencast preserves existing screencast', async () => {
    const { patchScreencast } = await import('../src/cloakbrowser-engine');
    const original = { handlePageOrContextClose: async () => 'original' };
    const fakePage: any = { screencast: original };
    patchScreencast(fakePage);
    expect(fakePage.screencast).toBe(original);
  });

  test('patchScreencast stub is no-op (returns undefined)', async () => {
    const { patchScreencast } = await import('../src/cloakbrowser-engine');
    const fakePage: any = {};
    patchScreencast(fakePage);
    const result = await fakePage.screencast.handlePageOrContextClose();
    expect(result).toBeUndefined();
  });
});

// ─── Engine Selection ──────────────────────────────────────

describe('engine selection', () => {
  test('shouldSkipCdpPatches returns true for cloakbrowser', async () => {
    const { shouldSkipCdpPatches } = await import('../src/cloakbrowser-engine');
    expect(shouldSkipCdpPatches('cloakbrowser')).toBe(true);
  });

  test('shouldSkipCdpPatches returns false for playwright', async () => {
    const { shouldSkipCdpPatches } = await import('../src/cloakbrowser-engine');
    expect(shouldSkipCdpPatches('playwright')).toBe(false);
  });

  test('launchCloakBrowser is exported', async () => {
    const { launchCloakBrowser } = await import('../src/cloakbrowser-engine');
    expect(launchCloakBrowser).toBeFunction();
  });
});
