/**
 * [INPUT]: Real BrowserManager + a local fixture server (like commands.test.ts).
 * [OUTPUT]: Verifies stage-4 per-session tab isolation end to end: two sessions
 *           own separate tabs in the ONE shared browser, never collide, and a
 *           session can't touch another's tab without Admin scope.
 * [POS]: Stage-4 acceptance. This is the feature — concurrent agents (two Claude
 *        Code windows, Codex, Cursor, OpenClaw) driving the same daemon must not
 *        steal, navigate, or close each other's tabs.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';
import { handleReadCommand } from '../src/read-commands';
import { handleMetaCommand } from '../src/meta-commands';
import type { TabView } from '../src/session-view';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;
let testProfileDir: string;
let originalProfileDir: string | undefined;

const noop = async () => {};

// Mimic handleCommand's goto preamble: a session lazily gets its OWN tab on goto.
async function gotoAs(view: TabView, url: string): Promise<string> {
  await view.ensureActiveTab();
  return handleWriteCommand('goto', [url], view);
}

beforeAll(async () => {
  originalProfileDir = process.env.BROWSE_PROFILE_DIR;
  testProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcrawl-session-iso-profile-'));
  process.env.BROWSE_PROFILE_DIR = testProfileDir;
  testServer = startTestServer(0);
  baseUrl = testServer.url;
  bm = new BrowserManager();
  await bm.launch();
});

afterAll(() => {
  try { testServer.server.stop(); } catch {}
  if (originalProfileDir === undefined) delete process.env.BROWSE_PROFILE_DIR;
  else process.env.BROWSE_PROFILE_DIR = originalProfileDir;
  setTimeout(() => process.exit(0), 500);
});

describe('Session isolation (stage 4)', () => {
  test('two sessions goto different urls with no collision', async () => {
    const A = bm.forSession('iso-A');
    const B = bm.forSession('iso-B');
    await gotoAs(A, baseUrl + '/basic.html');
    await gotoAs(B, baseUrl + '/forms.html');
    expect(A.getCurrentUrl()).toContain('/basic.html');
    expect(B.getCurrentUrl()).toContain('/forms.html');
    // Each session reads ITS OWN page, not the other's.
    const aText = await handleReadCommand('text', [], A);
    const bText = await handleReadCommand('text', [], B);
    expect(aText).not.toBe(bText);
  });

  test('a session with no tab throws on getPage — never returns another session\'s tab', () => {
    const C = bm.forSession('iso-C-fresh');
    expect(() => C.getPage()).toThrow(/No active page/);
    expect(C.getCurrentUrl()).toBe('about:blank');
  });

  test('closing one session\'s tab leaves the other unaffected', async () => {
    const A = bm.forSession('iso-A');
    const B = bm.forSession('iso-B');
    // A closes its own active tab (no id = active).
    await handleMetaCommand('closetab', [], A, noop, false);
    // A now has no tab.
    expect(() => A.getPage()).toThrow(/No active page/);
    // B is untouched and still readable.
    expect(B.getCurrentUrl()).toContain('/forms.html');
    const bText = await handleReadCommand('text', [], B);
    expect(bText.length).toBeGreaterThan(0);
  });

  test('tab list is session-scoped; --all needs Admin and shows every tab', async () => {
    const A = bm.forSession('iso-A2');
    const B = bm.forSession('iso-B2');
    await gotoAs(A, baseUrl + '/basic.html');
    await gotoAs(B, baseUrl + '/spa.html');

    const aList = await handleMetaCommand('tabs', [], A, noop, false);
    expect(aList).toContain('/basic.html');
    expect(aList).not.toContain('/spa.html'); // B's tab is invisible to A

    // --all without Admin is refused.
    await expect(handleMetaCommand('tabs', ['--all'], A, noop, false)).rejects.toThrow(/admin/i);

    // --all WITH Admin shows both sessions' tabs.
    const allList = await handleMetaCommand('tabs', ['--all'], A, noop, true);
    expect(allList).toContain('/basic.html');
    expect(allList).toContain('/spa.html');
  });

  test('cross-session closetab is refused without Admin, allowed with Admin', async () => {
    const A = bm.forSession('iso-A3');
    const B = bm.forSession('iso-B3');
    await gotoAs(A, baseUrl + '/basic.html');
    await gotoAs(B, baseUrl + '/forms.html');

    const bTabId = (await handleMetaCommand('tabs', [], B, noop, false))
      .match(/\[(\d+)\]/)?.[1];
    expect(bTabId).toBeDefined();

    // A (non-admin) cannot close B's tab.
    await expect(
      handleMetaCommand('closetab', [bTabId!], A, noop, false),
    ).rejects.toThrow(/owned by another session/i);
    // B's tab survives.
    expect(B.getCurrentUrl()).toContain('/forms.html');

    // A with Admin scope can close it.
    const res = await handleMetaCommand('closetab', [bTabId!], A, noop, true);
    expect(res).toContain('Closed tab');
    expect(() => B.getPage()).toThrow(/No active page/);
  });
});
