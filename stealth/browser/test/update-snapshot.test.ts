/**
 * Update snapshot/rollback tests.
 *
 * The auto-updater takes a snapshot before updating dependencies. If
 * verification fails, rollback restores the snapshot. These tests
 * exercise the snapshot create/save/load/restore lifecycle without
 * actually mutating real package files.
 *
 * [INPUT]: update-snapshot.ts
 * [OUTPUT]: Pass/fail per snapshot scenario
 * [POS]: Unit tests within stealth/browser/test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createUpdateSnapshot,
  saveSnapshot,
  loadSnapshot,
  restoreSnapshotFiles,
  type UpdateSnapshot,
} from '../src/update-snapshot';

let tmpDir: string;
let pkgPath: string;
let lockPath: string;
let stateDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcrawl-snap-'));
  pkgPath = path.join(tmpDir, 'package.json');
  lockPath = path.join(tmpDir, 'bun.lock');
  stateDir = path.join(tmpDir, 'state');
  fs.writeFileSync(pkgPath, JSON.stringify({
    name: 'test',
    dependencies: {
      'playwright-core': '1.59.1',
      'cloakbrowser': '0.3.21',
    },
  }, null, 2));
  fs.writeFileSync(lockPath, '# pretend lockfile content\n');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createUpdateSnapshot', () => {
  test('captures package.json content', () => {
    const snap = createUpdateSnapshot({ packageJsonPath: pkgPath, bunLockPath: lockPath });
    expect(snap.packageJson).toContain('playwright-core');
    expect(snap.packageJson).toContain('cloakbrowser');
  });

  test('captures bun.lock content', () => {
    const snap = createUpdateSnapshot({ packageJsonPath: pkgPath, bunLockPath: lockPath });
    expect(snap.bunLock).toContain('pretend lockfile');
  });

  test('extracts playwright + cloakbrowser versions from package.json', () => {
    const snap = createUpdateSnapshot({ packageJsonPath: pkgPath, bunLockPath: lockPath });
    expect(snap.playwrightVersion).toBe('1.59.1');
    expect(snap.cloakbrowserVersion).toBe('0.3.21');
  });

  test('records timestamp', () => {
    const before = Date.now();
    const snap = createUpdateSnapshot({ packageJsonPath: pkgPath, bunLockPath: lockPath });
    const after = Date.now();
    expect(snap.timestamp).toBeGreaterThanOrEqual(before);
    expect(snap.timestamp).toBeLessThanOrEqual(after);
  });

  test('handles missing bun.lock gracefully (empty string)', () => {
    fs.unlinkSync(lockPath);
    const snap = createUpdateSnapshot({ packageJsonPath: pkgPath, bunLockPath: lockPath });
    expect(snap.bunLock).toBe('');
  });
});

describe('saveSnapshot / loadSnapshot', () => {
  test('roundtrip preserves all fields', () => {
    const snap = createUpdateSnapshot({ packageJsonPath: pkgPath, bunLockPath: lockPath });
    saveSnapshot(snap, stateDir);
    const loaded = loadSnapshot(stateDir);
    expect(loaded).toEqual(snap);
  });

  test('loadSnapshot returns null when no snapshot exists', () => {
    expect(loadSnapshot(stateDir)).toBeNull();
  });

  test('loadSnapshot returns null on corrupt JSON', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'update-snapshot.json'), '{ not valid json');
    expect(loadSnapshot(stateDir)).toBeNull();
  });

  test('saveSnapshot creates state dir if missing', () => {
    const snap = createUpdateSnapshot({ packageJsonPath: pkgPath, bunLockPath: lockPath });
    expect(fs.existsSync(stateDir)).toBe(false);
    saveSnapshot(snap, stateDir);
    expect(fs.existsSync(stateDir)).toBe(true);
  });
});

describe('restoreSnapshotFiles', () => {
  test('writes package.json and bun.lock back to disk', () => {
    const snap = createUpdateSnapshot({ packageJsonPath: pkgPath, bunLockPath: lockPath });

    // Mutate the files
    fs.writeFileSync(pkgPath, '{"name":"corrupted"}');
    fs.writeFileSync(lockPath, 'corrupted lockfile');

    restoreSnapshotFiles(snap, { packageJsonPath: pkgPath, bunLockPath: lockPath });

    const restoredPkg = fs.readFileSync(pkgPath, 'utf-8');
    const restoredLock = fs.readFileSync(lockPath, 'utf-8');
    expect(restoredPkg).toContain('playwright-core');
    expect(restoredLock).toContain('pretend lockfile');
  });

  test('skips bun.lock write when snapshot.bunLock is empty', () => {
    const snap: UpdateSnapshot = {
      timestamp: Date.now(),
      packageJson: '{"name":"x","dependencies":{}}',
      bunLock: '',
      playwrightVersion: '1.0.0',
      cloakbrowserVersion: null,
    };
    fs.writeFileSync(lockPath, 'preserved');
    restoreSnapshotFiles(snap, { packageJsonPath: pkgPath, bunLockPath: lockPath });
    // lock should NOT be overwritten when snapshot was empty
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe('preserved');
  });
});
