/**
 * Stealth reinforcement loop tests.
 *
 * The reinforcement loop runs verifyStealth() every 6h while the
 * server is alive. After consecutive failures it self-heals
 * (re-applies patches) and ultimately writes a critical alert file.
 *
 * Tests inject the verifier and timer functions for hermetic runs.
 *
 * [INPUT]: stealth-reinforcement.ts
 * [OUTPUT]: Pass/fail per loop scenario
 * [POS]: Unit tests within stealth/browser/test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  startReinforcementLoop,
  stopReinforcementLoop,
  type ReinforcementOptions,
} from '../src/stealth-reinforcement';
import type { VerifyResult } from '../src/stealth-verifier';

let tmpDir: string;
let alertPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcrawl-reinf-'));
  alertPath = path.join(tmpDir, 'stealth-alert.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────

function passResult(): VerifyResult {
  return {
    passed: true,
    checks: [{ name: 'launch', passed: true, detail: 'ok' }],
    durationMs: 1,
  };
}

function failResult(): VerifyResult {
  return {
    passed: false,
    checks: [{ name: 'webdriver', passed: false, detail: 'leaked' }],
    durationMs: 1,
  };
}

interface FakeTimer {
  scheduled: Array<{ delayMs: number; cb: () => void }>;
  fire: (idx: number) => Promise<void>;
}

function makeFakeTimer(): FakeTimer {
  const scheduled: Array<{ delayMs: number; cb: () => void }> = [];
  return {
    scheduled,
    async fire(idx) {
      const entry = scheduled[idx];
      if (!entry) throw new Error(`no scheduled timer at ${idx}`);
      await entry.cb();
    },
  };
}

function makeOpts(deps: {
  verifyResults: VerifyResult[];
  timer: FakeTimer;
  patchesApplied?: () => void;
}): ReinforcementOptions {
  let verifyIdx = 0;
  return {
    intervalMs: 6 * 60 * 60 * 1000,
    initialDelayMs: 60 * 60 * 1000,
    stateDir: tmpDir,
    runVerifier: async () => {
      const result = deps.verifyResults[Math.min(verifyIdx, deps.verifyResults.length - 1)];
      verifyIdx++;
      return result;
    },
    reapplyPatches: async () => {
      deps.patchesApplied?.();
    },
    schedule: (delayMs: number, cb: () => void) => {
      deps.timer.scheduled.push({ delayMs, cb });
      return deps.timer.scheduled.length - 1;
    },
    cancel: (_handle: any) => {},
    log: () => {},
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('startReinforcementLoop', () => {
  test('schedules first check at initialDelayMs', () => {
    const timer = makeFakeTimer();
    startReinforcementLoop(makeOpts({ verifyResults: [passResult()], timer }));
    expect(timer.scheduled).toHaveLength(1);
    expect(timer.scheduled[0].delayMs).toBe(60 * 60 * 1000);
  });

  test('reschedules at intervalMs after a successful check', async () => {
    const timer = makeFakeTimer();
    startReinforcementLoop(makeOpts({ verifyResults: [passResult()], timer }));
    await timer.fire(0);
    expect(timer.scheduled.length).toBe(2);
    expect(timer.scheduled[1].delayMs).toBe(6 * 60 * 60 * 1000);
  });

  test('first failure re-applies patches and re-verifies', async () => {
    const timer = makeFakeTimer();
    let patchReapplied = 0;
    startReinforcementLoop(makeOpts({
      verifyResults: [failResult(), passResult()],
      timer,
      patchesApplied: () => { patchReapplied++; },
    }));
    await timer.fire(0);
    expect(patchReapplied).toBe(1);
  });

  test('three consecutive failures write critical alert file', async () => {
    const timer = makeFakeTimer();
    startReinforcementLoop(makeOpts({
      verifyResults: [failResult(), failResult(), failResult()],
      timer,
    }));
    // The implementation may run all checks within a single tick
    await timer.fire(0);
    // Drain any rescheduled checks until alert appears or queue empty
    let safety = 10;
    while (safety-- > 0 && !fs.existsSync(alertPath) && timer.scheduled.length > 1) {
      await timer.fire(timer.scheduled.length - 1);
    }
    expect(fs.existsSync(alertPath)).toBe(true);
    const alert = JSON.parse(fs.readFileSync(alertPath, 'utf-8'));
    expect(alert.consecutiveFailures).toBeGreaterThanOrEqual(3);
  });

  test('successful check resets failure counter', async () => {
    const timer = makeFakeTimer();
    startReinforcementLoop(makeOpts({
      verifyResults: [failResult(), passResult(), passResult(), passResult(), passResult()],
      timer,
    }));
    // Fire several rounds — never reach 3 consecutive failures
    let safety = 10;
    while (safety-- > 0 && timer.scheduled.length < 5) {
      await timer.fire(timer.scheduled.length - 1);
    }
    expect(fs.existsSync(alertPath)).toBe(false);
  });
});

describe('stopReinforcementLoop', () => {
  test('cancels the scheduled timer', () => {
    const timer = makeFakeTimer();
    let cancelled = false;
    const opts: ReinforcementOptions = {
      ...makeOpts({ verifyResults: [passResult()], timer }),
      cancel: () => { cancelled = true; },
    };
    const handle = startReinforcementLoop(opts);
    stopReinforcementLoop(handle);
    expect(cancelled).toBe(true);
  });
});
