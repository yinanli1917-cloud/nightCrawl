/**
 * [INPUT]: Depends on browser-manager (detectLoginWall) + test-server fixtures.
 * [OUTPUT]: Scores the login-wall DETECTOR's precision as a confusion matrix against
 *           paired fixtures: a real password wall and a QR login MUST be flagged; a
 *           signup form (password field, no blocking copy) and prose that merely mentions
 *           logging in must NOT be. Both false-positive and missed rates must be 0.
 * [POS]: Artifact 1 (offline false-handover gate), detection layer — the precision side of
 *        the false-handover problem: a lookalike must not trigger a hand-back. Runs a real
 *        headless browser against local 127.0.0.1 fixtures.
 *
 * Scope note: this covers the DOM detection paths (form / QR / auth-text). The URL-path
 * check (detectLoginWall line ~577) over-fires on paths like /login-help; tightening that
 * regex risks missing real login URLs, so it is tracked separately behind its own URL
 * corpus, not changed here.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;
  bm = new BrowserManager();
  await bm.launch();
}, 90_000);

afterAll(() => {
  try { testServer.server.stop(); } catch {}
  setTimeout(() => process.exit(0), 500);
});

interface Twin { file: string; mustDetect: boolean; note: string; }
const TWINS: Twin[] = [
  { file: 'real-password-wall.html', mustDetect: true, note: 'password form + "sign in to continue"' },
  { file: 'qr-code-wall.html', mustDetect: true, note: 'visible QR login code' },
  { file: 'signup-open.html', mustDetect: false, note: 'password field but NO blocking copy (signup)' },
  { file: 'help-article.html', mustDetect: false, note: 'prose that merely mentions logging in' },
];

async function detects(file: string): Promise<boolean> {
  await handleWriteCommand('goto', [`${baseUrl}/${file}`], bm);
  const d = await bm.detectLoginWall();
  return d?.detected === true;
}

describe('login-detection twins — DOM precision confusion matrix', () => {
  test('no false wall: a signup form and login-mentioning prose are NOT flagged', async () => {
    const falsePos: string[] = [];
    for (const t of TWINS.filter((x) => !x.mustDetect)) {
      if (await detects(t.file)) falsePos.push(t.note);
    }
    expect(falsePos).toEqual([]);
  });

  test('no missed wall: a real password form and a QR login ARE flagged', async () => {
    const missed: string[] = [];
    for (const t of TWINS.filter((x) => x.mustDetect)) {
      if (!(await detects(t.file))) missed.push(t.note);
    }
    expect(missed).toEqual([]);
  });
});
