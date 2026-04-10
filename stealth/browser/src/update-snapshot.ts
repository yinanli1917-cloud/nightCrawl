/**
 * Update snapshot — captures package.json + bun.lock before any
 * dependency mutation, so the auto-updater can roll back on failure.
 *
 * Snapshot lifecycle:
 *   1. createUpdateSnapshot()      — read current state into memory
 *   2. saveSnapshot()              — persist to ~/.nightcrawl/update-snapshot.json
 *   3. (auto-updater runs updates)
 *   4a. on success: delete the snapshot file
 *   4b. on failure: restoreSnapshotFiles() + run `bun install`
 *
 * Snapshots are intentionally small — just the lockfile + manifest.
 * Restoring those + a `bun install` is enough to get back to the
 * exact dependency tree we started from.
 *
 * [INPUT]: package.json path, bun.lock path
 * [OUTPUT]: UpdateSnapshot type, create/save/load/restore functions
 * [POS]: Snapshot layer for the auto-updater
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────

export interface UpdateSnapshot {
  timestamp: number;
  packageJson: string;        // full file content (UTF-8)
  bunLock: string;            // full file content; empty string if missing
  playwrightVersion: string;  // extracted from package.json deps
  cloakbrowserVersion: string | null;
}

export interface SnapshotPaths {
  packageJsonPath: string;
  bunLockPath: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function readFileOrEmpty(p: string): string {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

function extractDepVersion(pkgContent: string, dep: string): string | null {
  try {
    const pkg = JSON.parse(pkgContent);
    return pkg.dependencies?.[dep] ?? null;
  } catch {
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────

export function createUpdateSnapshot(paths: SnapshotPaths): UpdateSnapshot {
  const packageJson = fs.readFileSync(paths.packageJsonPath, 'utf-8');
  const bunLock = readFileOrEmpty(paths.bunLockPath);
  return {
    timestamp: Date.now(),
    packageJson,
    bunLock,
    playwrightVersion: extractDepVersion(packageJson, 'playwright-core') ?? 'unknown',
    cloakbrowserVersion: extractDepVersion(packageJson, 'cloakbrowser'),
  };
}

export function saveSnapshot(snapshot: UpdateSnapshot, stateDir: string): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'update-snapshot.json'),
    JSON.stringify(snapshot, null, 2),
  );
}

export function loadSnapshot(stateDir: string): UpdateSnapshot | null {
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'update-snapshot.json'), 'utf-8');
    return JSON.parse(raw) as UpdateSnapshot;
  } catch {
    return null;
  }
}

export function deleteSnapshot(stateDir: string): void {
  try {
    fs.unlinkSync(path.join(stateDir, 'update-snapshot.json'));
  } catch {
    // already gone — fine
  }
}

export function preserveFailedSnapshot(stateDir: string, snapshot: UpdateSnapshot): void {
  const fname = `update-snapshot-failed-${snapshot.timestamp}.json`;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, fname), JSON.stringify(snapshot, null, 2));
  } catch {
    // disk failure — nothing we can do
  }
}

export function restoreSnapshotFiles(
  snapshot: UpdateSnapshot,
  paths: SnapshotPaths,
): void {
  fs.writeFileSync(paths.packageJsonPath, snapshot.packageJson);
  if (snapshot.bunLock !== '') {
    fs.writeFileSync(paths.bunLockPath, snapshot.bunLock);
  }
}
