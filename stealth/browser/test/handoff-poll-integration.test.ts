/**
 * Integration test: drive a real headless browser through a 4-step redirect
 * chain (login -> "duo" -> callback -> landing), exercising decidePoll() on
 * each tick. Proves end-to-end that the polling fix:
 *   1. Detects the initial login wall
 *   2. Does NOT resume during intermediate hops
 *   3. Captures the FINAL session cookie (the one set on the landing page)
 *
 * This is the integration counterpart to the pure unit tests in
 * handoff-poll.test.ts. Together they cover both the timing logic AND
 * the real-browser observation path.
 *
 * Why we don't run the full autoHandover() in this test: it spawns a
 * headed browser (foreground window). A headless integration test that
 * exercises the polling decision against a real navigating page gives
 * the same evidence without disturbing the user's screen.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';
import {
  decidePoll,
  initialPollState,
  defaultPollOptions,
  type PollAction,
} from '../src/handoff-poll';

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;
  bm = new BrowserManager();
  await bm.launch();
});

afterAll(() => {
  try { testServer.server.stop(); } catch {}
  setTimeout(() => process.exit(0), 500);
});

describe('autoHandover polling — multi-redirect chain', () => {
  test('detects wall + waits through 4-hop chain + captures final session cookie', async () => {
    // 1. Navigate to step1 (login page with password input + auto-redirect chain).
    await handleWriteCommand('goto', [`${baseUrl}/multi-step-1-login.html`], bm);
    const startUrl = bm.getCurrentUrl();
    expect(startUrl).toContain('multi-step-1-login.html');

    // 2. Confirm detection fires on the login page (URL pattern OR password input).
    //    detectLoginWall isn't directly used here — we verify the wall exists by
    //    checking for password input, mirroring what detectLoginWall does.
    const page = bm.getPage()!;
    const initialHasWall = await page.evaluate(
      () => document.querySelectorAll('input[type="password"]').length > 0,
    );
    expect(initialHasWall).toBe(true);

    // 3. Run the polling loop manually. Use the same options autoHandover uses
    //    in production, but with shorter stability so the test runs in seconds.
    const opts = {
      ...defaultPollOptions(startUrl),
      loginWallSeen: true,
      maxWaitMs: 30_000,
      stabilityMs: 2000, // shortened from 5s for faster test
    };
    const state = initialPollState(startUrl);
    const observedUrls: string[] = [];
    const decisions: { url: string; action: PollAction; reason: string; t: number }[] = [];
    const startTime = Date.now();
    let action: PollAction = 'continue';

    while (action === 'continue' && Date.now() - startTime < opts.maxWaitMs) {
      await new Promise(r => setTimeout(r, 300));
      const url = await page.evaluate(() => location.href).catch(() => startUrl);
      const hasWall = await page.evaluate(
        () => document.querySelectorAll('input[type="password"]').length > 0,
      ).catch(() => false);
      const elapsedMs = Date.now() - startTime;
      const decision = decidePoll({ url, hasWall, elapsedMs }, opts, state);
      observedUrls.push(url);
      decisions.push({ url, action: decision.action, reason: decision.reason, t: elapsedMs });
      action = decision.action;
    }

    // 4. The chain should have produced multiple distinct URLs.
    const uniqueUrls = new Set(observedUrls);
    expect(uniqueUrls.size).toBeGreaterThanOrEqual(3);

    // 5. The polling MUST have resumed (not timed out).
    expect(action).toBe('resume');

    // 6. The final URL when polling resumed MUST be the landing page —
    //    NOT step 2 (duo) and NOT step 3 (callback). This is the entire bug.
    const finalUrl = observedUrls[observedUrls.length - 1];
    expect(finalUrl).toContain('multi-step-4-landing.html');

    // 7. The session cookie set by the LANDING page should be present.
    //    (If polling resumed at step 2 or 3, this cookie would be missing —
    //    same root cause as the missing _shibsession_* for canvas.uw.edu.)
    const cookies = await page.context().cookies();
    const appSession = cookies.find(c => c.name === 'app_session');
    expect(appSession).toBeDefined();
    expect(appSession!.value).toBe('complete');

    // 8. Sanity: also have the SP-side session from step 3.
    const spSession = cookies.find(c => c.name === 'sp_session');
    expect(spSession).toBeDefined();
  }, 60_000);
});
