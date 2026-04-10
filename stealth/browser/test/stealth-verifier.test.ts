/**
 * Stealth verifier tests.
 *
 * The verifier launches a browser, runs a small set of stealth
 * checks, and returns pass/fail. The auto-updater calls it after
 * every update; the reinforcement loop calls it every 6 hours.
 *
 * These tests inject a fake browser factory so they're hermetic.
 *
 * [INPUT]: stealth-verifier.ts
 * [OUTPUT]: Pass/fail per verification scenario
 * [POS]: Unit tests within stealth/browser/test
 */

import { describe, test, expect } from 'bun:test';
import { verifyStealth, type VerifierBrowser } from '../src/stealth-verifier';

// ─── Fake browser ───────────────────────────────────────────────

interface FakeOpts {
  webdriver?: boolean;            // navigator.webdriver value
  sannysoftPass?: boolean;        // simulated sannysoft result
  rebrowserPass?: boolean;        // simulated rebrowser result
  launchFails?: boolean;
  navigationTimesOut?: string[];  // urls that should timeout
}

function makeFake(opts: FakeOpts = {}): VerifierBrowser {
  return {
    async launch() {
      if (opts.launchFails) throw new Error('simulated launch failure');
    },
    async navigate(url: string) {
      if (opts.navigationTimesOut?.includes(url)) {
        throw new Error('Navigation timeout');
      }
    },
    async evaluateWebdriver() {
      return opts.webdriver ?? false;
    },
    async checkSannysoft() {
      return opts.sannysoftPass ?? true;
    },
    async checkRebrowser() {
      return opts.rebrowserPass ?? true;
    },
    async close() {},
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('verifyStealth', () => {
  test('passes when all checks succeed', async () => {
    const result = await verifyStealth({ browser: makeFake() });
    expect(result.passed).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  test('fails when launch fails', async () => {
    const result = await verifyStealth({ browser: makeFake({ launchFails: true }) });
    expect(result.passed).toBe(false);
    const launchCheck = result.checks.find((c) => c.name === 'launch');
    expect(launchCheck?.passed).toBe(false);
  });

  test('fails when navigator.webdriver is exposed', async () => {
    const result = await verifyStealth({ browser: makeFake({ webdriver: true }) });
    expect(result.passed).toBe(false);
    const wdCheck = result.checks.find((c) => c.name === 'webdriver');
    expect(wdCheck?.passed).toBe(false);
  });

  test('fails when sannysoft critical row fails', async () => {
    const result = await verifyStealth({ browser: makeFake({ sannysoftPass: false }) });
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.name === 'sannysoft');
    expect(check?.passed).toBe(false);
  });

  test('fails when bot-detector CDP test fails', async () => {
    const result = await verifyStealth({ browser: makeFake({ rebrowserPass: false }) });
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.name === 'rebrowser');
    expect(check?.passed).toBe(false);
  });

  test('treats network timeout as pass-with-warning, not failure', async () => {
    const result = await verifyStealth({
      browser: makeFake({ navigationTimesOut: ['https://bot.sannysoft.com/'] }),
    });
    // Pass — flaky internet should never trigger a rollback
    expect(result.passed).toBe(true);
    const check = result.checks.find((c) => c.name === 'sannysoft');
    expect(check?.warning).toBe(true);
  });

  test('records duration', async () => {
    const result = await verifyStealth({ browser: makeFake() });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('NEVER navigates to hostile platforms (Tier 4-5)', async () => {
    const navigated: string[] = [];
    const browser: VerifierBrowser = {
      async launch() {},
      async navigate(url: string) { navigated.push(url); },
      async evaluateWebdriver() { return false; },
      async checkSannysoft() { return true; },
      async checkRebrowser() { return true; },
      async close() {},
    };
    await verifyStealth({ browser });
    for (const url of navigated) {
      expect(url).not.toContain('xiaohongshu');
      expect(url).not.toContain('douyin');
      expect(url).not.toContain('weibo');
      expect(url).not.toContain('linkedin');
      expect(url).not.toContain('instagram');
    }
  });

  test('always closes browser on success', async () => {
    let closed = false;
    const browser: VerifierBrowser = {
      ...makeFake(),
      async close() { closed = true; },
    };
    await verifyStealth({ browser });
    expect(closed).toBe(true);
  });

  test('always closes browser on failure', async () => {
    let closed = false;
    const browser: VerifierBrowser = {
      ...makeFake({ webdriver: true }),
      async close() { closed = true; },
    };
    await verifyStealth({ browser });
    expect(closed).toBe(true);
  });
});
