/**
 * Regression test for P1 orphan-window bug (HANDOFF.md, 2026-04-15).
 *
 * Before the fix: handoff() spawned a headed Chromium that survived
 * BrowserManager.close() — pkill -f bun killed the daemon but left
 * the headed window on the user's screen.
 *
 * The fix: track the unique nightcrawl-handoff-XXXXXX userDataDir
 * and pkill -f against it after context.close() (belt-and-suspenders
 * for the case where context.close() hangs or shutdown is abrupt).
 *
 * This test asserts: post-close(), zero processes remain whose command
 * line references the handoff userDataDir we just spawned.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';

const testServer = startTestServer(0);
const baseUrl = testServer.url;

afterAll(() => {
  try { testServer.server.stop(); } catch {}
});

// ─── Helpers ──────────────────────────────────────────────────
function countProcesses(pattern: string): number {
  // pgrep returns 1 (no matches) or 0 (matches). Don't fail on exit code.
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf-8' });
  if (!r.stdout) return 0;
  return r.stdout.trim().split('\n').filter(Boolean).length;
}

// ─── The Test ─────────────────────────────────────────────────
describe('handoff orphan cleanup', () => {
  test('headed Chromium does not survive BrowserManager.close()', async () => {
    const bm = new BrowserManager();
    await bm.launch();

    // Drive the daemon into headed mode via the real handoff path.
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const handoffResult = await bm.handoff('orphan-cleanup test');
    expect(handoffResult).toContain('HANDOFF:');
    expect(bm.getIsHeaded()).toBe(true);

    // The handoff stamps a unique userDataDir prefix on the manager so
    // close() / emergencyCleanup() can pkill -f it.
    const userDataDir = (bm as any).headedUserDataDir;
    expect(userDataDir).toBeTruthy();
    expect(userDataDir).toContain('nightcrawl-handoff-');

    // Sanity: at least one Chromium process is currently using this dir.
    const beforeCount = countProcesses(userDataDir);
    expect(beforeCount).toBeGreaterThan(0);

    // The fix under test: close() must leave zero orphans.
    await bm.close();

    // Give the OS a beat to reap the killed processes.
    await new Promise(r => setTimeout(r, 1000));

    const afterCount = countProcesses(userDataDir);
    expect(afterCount).toBe(0);
  }, 60000);
});
