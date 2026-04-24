/**
 * Unit tests for the cookie-watch module — fs.watch wrapper that
 * debounces SQLite write bursts (page write + WAL flush + journal)
 * into a single onChange callback.
 *
 * Tests use a tmp dir so we don't touch real Arc/Chrome state.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { watchBrowserCookieDb, type CookieWatcher } from '../src/cookie-watch';

let tmpDir: string;
let dbPath: string;
let watcher: CookieWatcher | null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cookie-watch-'));
  dbPath = path.join(tmpDir, 'Cookies');
  fs.writeFileSync(dbPath, 'sqlite-stub-content');
  watcher = null;
});

afterEach(() => {
  if (watcher) watcher.stop();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('watchBrowserCookieDb', () => {
  test('exposes watchedPath for telemetry', () => {
    watcher = watchBrowserCookieDb(dbPath, () => {}, { debounceMs: 50 });
    expect(watcher.watchedPath).toBe(dbPath);
  });

  test('fires onChange after a write to Cookies', async () => {
    let calls = 0;
    watcher = watchBrowserCookieDb(dbPath, () => { calls++; }, { debounceMs: 50 });
    await sleep(60); // past warm-up
    fs.writeFileSync(dbPath, 'updated');
    await sleep(120);
    expect(calls).toBe(1);
  });

  test('fires onChange after a write to Cookies-journal (WAL sidecar)', async () => {
    let calls = 0;
    watcher = watchBrowserCookieDb(dbPath, () => { calls++; }, { debounceMs: 50 });
    await sleep(60); // past warm-up
    fs.writeFileSync(path.join(tmpDir, 'Cookies-journal'), 'wal');
    await sleep(120);
    expect(calls).toBe(1);
  });

  test('coalesces a burst of writes into one onChange', async () => {
    let calls = 0;
    watcher = watchBrowserCookieDb(dbPath, () => { calls++; }, { debounceMs: 80 });
    await sleep(60); // past warm-up
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(dbPath, `burst ${i}`);
      await sleep(5);
    }
    await sleep(150);
    expect(calls).toBe(1);
  });

  test('ignores unrelated files in the same directory', async () => {
    let calls = 0;
    watcher = watchBrowserCookieDb(dbPath, () => { calls++; }, { debounceMs: 50 });
    // Wait past the warm-up window so we test steady-state filtering, not the
    // FSEvents-on-macOS startup echo.
    await sleep(60);
    fs.writeFileSync(path.join(tmpDir, 'Preferences'), 'pref');
    fs.writeFileSync(path.join(tmpDir, 'Network'), 'net');
    await sleep(120);
    expect(calls).toBe(0);
  });

  test('fires again after a quiet period for a second burst', async () => {
    let calls = 0;
    watcher = watchBrowserCookieDb(dbPath, () => { calls++; }, { debounceMs: 50 });
    await sleep(60); // past warm-up
    fs.writeFileSync(dbPath, 'first');
    await sleep(120);
    fs.writeFileSync(dbPath, 'second');
    await sleep(120);
    expect(calls).toBe(2);
  });

  test('stop() prevents subsequent callbacks', async () => {
    let calls = 0;
    watcher = watchBrowserCookieDb(dbPath, () => { calls++; }, { debounceMs: 50 });
    await sleep(60); // past warm-up
    watcher.stop();
    watcher = null;
    fs.writeFileSync(dbPath, 'after-stop');
    await sleep(120);
    expect(calls).toBe(0);
  });

  test('callback that throws does not crash the watcher', async () => {
    let calls = 0;
    watcher = watchBrowserCookieDb(
      dbPath,
      () => { calls++; throw new Error('boom'); },
      { debounceMs: 50 },
    );
    await sleep(60); // past warm-up
    fs.writeFileSync(dbPath, 'first');
    await sleep(120);
    fs.writeFileSync(dbPath, 'second');
    await sleep(120);
    expect(calls).toBe(2);
  });

  test('stop() is idempotent', () => {
    watcher = watchBrowserCookieDb(dbPath, () => {}, { debounceMs: 50 });
    watcher.stop();
    expect(() => watcher!.stop()).not.toThrow();
  });
});
