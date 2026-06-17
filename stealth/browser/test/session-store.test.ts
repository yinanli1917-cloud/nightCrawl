/**
 * [INPUT]: Depends on session-store.ts (checkpointSession/restoreSession/flushNativeProfile)
 *          and BrowserManager for a real CloakBrowser context.
 * [OUTPUT]: Verifies the single-source cookie checkpoint survives clear + restore,
 *           merge keeps existing cookies, and the file is written atomically.
 * [POS]: Phase-0 persistence foundation test — the RED that reproduces Session 10
 *        cookie loss before the checkpoint discipline lands.
 *
 * No network: cookies are injected via context.addCookies and read back via
 * context.cookies(), so the test is deterministic and only pays CloakBrowser
 * launch cost once.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate ALL state into a temp dir BEFORE importing the engine — parseEngineConfig
// and resolveConfig read these at launch/call time, not import time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sessionstore-'));
process.env.BROWSE_STATE_FILE = path.join(TMP, 'state', 'browse.json');
process.env.BROWSE_PROFILE_DIR = path.join(TMP, 'profile');
process.env.BROWSE_EXTENSIONS = 'none';
fs.mkdirSync(path.dirname(process.env.BROWSE_STATE_FILE), { recursive: true });

import { BrowserManager } from '../src/browser-manager';
import {
  checkpointSession,
  restoreSession,
  flushNativeProfile,
  sessionFilePath,
} from '../src/session-store';

let bm: BrowserManager;

beforeAll(async () => {
  bm = new BrowserManager();
  await bm.launch();
});

afterAll(async () => {
  try { await bm.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(0), 500);
}, 30000);

describe('session-store checkpoint/restore', () => {
  test('sessionFilePath lives under the isolated stateDir', () => {
    const p = sessionFilePath();
    expect(p).toBe(path.join(TMP, 'state', 'session.json'));
  });

  test('checkpoint then restore round-trips a cookie that was cleared', async () => {
    const ctx = bm.context!;
    await ctx.clearCookies();
    await ctx.addCookies([
      { name: 'nc_round', value: 'survived', domain: 'example.com', path: '/' },
    ]);

    const dest = path.join(TMP, 'rt.json');
    const count = await checkpointSession(ctx, dest);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(dest)).toBe(true);

    // Simulate the crash: cookie jar emptied, file is the only survivor.
    await ctx.clearCookies();
    expect((await ctx.cookies()).some((c) => c.name === 'nc_round')).toBe(false);

    const restored = await restoreSession(ctx, dest, 'merge');
    expect(restored).toBeGreaterThanOrEqual(1);
    expect((await ctx.cookies()).some((c) => c.name === 'nc_round')).toBe(true);
  }, 30000);

  test('merge keeps cookies that already exist in the context', async () => {
    const ctx = bm.context!;
    await ctx.clearCookies();
    await ctx.addCookies([
      { name: 'nc_old', value: 'a', domain: 'example.com', path: '/' },
    ]);

    const dest = path.join(TMP, 'merge.json');
    await checkpointSession(ctx, dest);

    // A newer cookie lands after the checkpoint — merge must not erase it.
    await ctx.addCookies([
      { name: 'nc_new', value: 'b', domain: 'example.com', path: '/' },
    ]);

    await restoreSession(ctx, dest, 'merge');
    const names = (await ctx.cookies()).map((c) => c.name);
    expect(names).toContain('nc_old');
    expect(names).toContain('nc_new');
  }, 30000);

  test('checkpoint writes atomically (no leftover .tmp)', async () => {
    const ctx = bm.context!;
    const dest = path.join(TMP, 'atomic.json');
    await checkpointSession(ctx, dest);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(dest + '.tmp')).toBe(false);
  }, 30000);

  test('restoreSession on a missing file returns 0 and does not throw', async () => {
    const ctx = bm.context!;
    const restored = await restoreSession(ctx, path.join(TMP, 'does-not-exist.json'), 'merge');
    expect(restored).toBe(0);
  });

  test('flushNativeProfile resolves without throwing', async () => {
    await expect(flushNativeProfile(bm.context!)).resolves.toBeUndefined();
  }, 15000);
});
