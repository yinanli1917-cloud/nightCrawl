/**
 * Auto-updater orchestrator tests.
 *
 * Verifies the gate logic, snapshot/restore sequencing, verification
 * triggering, and rollback behavior — all with injected dependencies.
 *
 * Real subprocess + browser launches happen only in integration tests.
 *
 * [INPUT]: auto-updater.ts
 * [OUTPUT]: Pass/fail per gate/sequence scenario
 * [POS]: Unit tests within stealth/browser/test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  maybeAutoUpdate,
  type AutoUpdateOptions,
  type AutoUpdateResult,
} from '../src/auto-updater';
import type { DependencyStatus } from '../src/update-checker';
import type { VerifyResult } from '../src/stealth-verifier';
import type { ExecutorResult } from '../src/update-executor';

// ─── Test environment ──────────────────────────────────────────

let tmpDir: string;
let stateDir: string;
let pkgPath: string;
let lockPath: string;
let patchesDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcrawl-au-'));
  stateDir = path.join(tmpDir, 'state');
  pkgPath = path.join(tmpDir, 'package.json');
  lockPath = path.join(tmpDir, 'bun.lock');
  patchesDir = path.join(tmpDir, 'patches');

  fs.writeFileSync(pkgPath, JSON.stringify({
    name: 'test',
    dependencies: {
      'playwright-core': '1.59.1',
      'cloakbrowser': '0.3.21',
    },
  }, null, 2));
  fs.writeFileSync(lockPath, '# lock\n');
  fs.mkdirSync(patchesDir, { recursive: true });
  fs.writeFileSync(path.join(patchesDir, 'VERSION'), '1.0.19\n');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────

interface FakeDeps {
  configEnabled?: boolean;
  outdated?: DependencyStatus[];
  rebrowserCompatible?: boolean;
  installResult?: ExecutorResult;
  verifyResult?: VerifyResult;
  cooldownActive?: boolean;
}

function makeOpts(deps: FakeDeps = {}): AutoUpdateOptions {
  const recordedCalls: string[] = [];
  const opts: AutoUpdateOptions = {
    stateDir,
    packageJsonPath: pkgPath,
    bunLockPath: lockPath,
    patchesDir,
    cwd: tmpDir,
    readConfigValue: (key: string) => {
      if (key === 'auto_upgrade') return deps.configEnabled ? 'true' : 'false';
      return null;
    },
    isCooldownActive: () => deps.cooldownActive ?? false,
    writeCooldown: () => {},
    detectUpdates: async () => deps.outdated ?? null,
    checkRebrowserCompat: async () => ({
      compatible: deps.rebrowserCompatible ?? true,
      latestRebrowser: '1.0.20',
      targetPwVersion: '1.60.0',
      matchedRelease: 'v1.0.20',
    }),
    runExecutor: async (cmd: string) => {
      recordedCalls.push(cmd);
      return deps.installResult ?? { success: true, exitCode: 0, stdout: '', stderr: '' };
    },
    runVerifier: async () => deps.verifyResult ?? {
      passed: true,
      checks: [{ name: 'launch', passed: true, detail: 'ok' }],
      durationMs: 1,
    },
    applyPatches: async () => {},
    log: () => {},
  };
  (opts as any).recordedCalls = recordedCalls;
  return opts;
}

function safeOutdated(): DependencyStatus[] {
  return [
    { name: 'cloakbrowser', current: '0.3.21', latest: '0.3.22', outdated: true },
  ];
}

function pwOutdated(): DependencyStatus[] {
  return [
    { name: 'playwright-core', current: '1.59.1', latest: '1.60.0', outdated: true },
  ];
}

// ─── Gate tests ────────────────────────────────────────────────

describe('maybeAutoUpdate gates', () => {
  test('skips when auto_upgrade config is false', async () => {
    const result = await maybeAutoUpdate(makeOpts({ configEnabled: false }));
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('disabled');
  });

  test('skips when cooldown is active', async () => {
    const result = await maybeAutoUpdate(makeOpts({
      configEnabled: true,
      cooldownActive: true,
    }));
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('cooldown');
  });

  test('skips when nothing is outdated', async () => {
    const result = await maybeAutoUpdate(makeOpts({
      configEnabled: true,
      outdated: [
        { name: 'cloakbrowser', current: '0.3.22', latest: '0.3.22', outdated: false },
      ],
    }));
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('up to date');
  });

  test('skips when detection returns null (cooldown inside checker)', async () => {
    const result = await maybeAutoUpdate(makeOpts({
      configEnabled: true,
      outdated: undefined,
    }));
    expect(result.skipped).toBe(true);
  });
});

// ─── Compatibility gate ────────────────────────────────────────

describe('maybeAutoUpdate compatibility gate', () => {
  test('skips Playwright update when no compatible rebrowser-patches', async () => {
    const opts = makeOpts({
      configEnabled: true,
      outdated: pwOutdated(),
      rebrowserCompatible: false,
    });
    const result = await maybeAutoUpdate(opts);
    // playwright-core is the ONLY outdated dep and it was blocked,
    // so we end up with nothing to update
    expect(result.updated).toEqual([]);
  });

  test('still updates CloakBrowser when Playwright is blocked', async () => {
    const opts = makeOpts({
      configEnabled: true,
      outdated: [...pwOutdated(), ...safeOutdated()],
      rebrowserCompatible: false,
    });
    const result = await maybeAutoUpdate(opts);
    expect(result.updated).toContain('cloakbrowser');
    expect(result.updated).not.toContain('playwright-core');
  });

  test('updates Playwright when rebrowser-patches IS compatible', async () => {
    const result = await maybeAutoUpdate(makeOpts({
      configEnabled: true,
      outdated: pwOutdated(),
      rebrowserCompatible: true,
    }));
    expect(result.updated).toContain('playwright-core');
  });
});

// ─── Snapshot + verification ───────────────────────────────────

describe('maybeAutoUpdate snapshot and verification', () => {
  test('creates snapshot before executing updates', async () => {
    let snapshotted = false;
    const opts = makeOpts({ configEnabled: true, outdated: safeOutdated() });
    opts.onSnapshot = () => { snapshotted = true; };
    await maybeAutoUpdate(opts);
    expect(snapshotted).toBe(true);
  });

  test('triggers verification after update', async () => {
    let verified = false;
    const opts = makeOpts({ configEnabled: true, outdated: safeOutdated() });
    opts.runVerifier = async () => {
      verified = true;
      return { passed: true, checks: [], durationMs: 1 };
    };
    await maybeAutoUpdate(opts);
    expect(verified).toBe(true);
  });

  test('rolls back on verification failure', async () => {
    let rolledBack = false;
    const opts = makeOpts({
      configEnabled: true,
      outdated: safeOutdated(),
      verifyResult: { passed: false, checks: [{ name: 'webdriver', passed: false, detail: 'leaked' }], durationMs: 1 },
    });
    opts.onRollback = () => { rolledBack = true; };
    const result = await maybeAutoUpdate(opts);
    expect(rolledBack).toBe(true);
    expect(result.rolledBack).toBe(true);
  });

  test('does NOT rollback on verification success', async () => {
    let rolledBack = false;
    const opts = makeOpts({ configEnabled: true, outdated: safeOutdated() });
    opts.onRollback = () => { rolledBack = true; };
    const result = await maybeAutoUpdate(opts);
    expect(rolledBack).toBe(false);
    expect(result.rolledBack).toBeFalsy();
  });

  test('rolls back when install itself fails', async () => {
    let rolledBack = false;
    const opts = makeOpts({
      configEnabled: true,
      outdated: safeOutdated(),
      installResult: { success: false, exitCode: 1, stdout: '', stderr: 'install failed' },
    });
    opts.onRollback = () => { rolledBack = true; };
    const result = await maybeAutoUpdate(opts);
    expect(rolledBack).toBe(true);
    expect(result.rolledBack).toBe(true);
  });
});

// ─── Patch re-application ──────────────────────────────────────

describe('maybeAutoUpdate patch handling', () => {
  test('re-applies CDP patches after Playwright update', async () => {
    let patched = false;
    const opts = makeOpts({
      configEnabled: true,
      outdated: pwOutdated(),
      rebrowserCompatible: true,
    });
    opts.applyPatches = async () => { patched = true; };
    await maybeAutoUpdate(opts);
    expect(patched).toBe(true);
  });

  test('does NOT re-apply patches when only CloakBrowser updated', async () => {
    let patched = false;
    const opts = makeOpts({
      configEnabled: true,
      outdated: safeOutdated(),
    });
    opts.applyPatches = async () => { patched = true; };
    await maybeAutoUpdate(opts);
    expect(patched).toBe(false);
  });
});
