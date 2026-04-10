/**
 * Stealth reinforcement loop — autonomous, continuous validation.
 *
 * While the server runs, this loop calls verifyStealth() every 6
 * hours to make sure stealth posture hasn't degraded:
 *   - User ran `bun update` outside nightCrawl
 *   - A bot detection site added new fingerprinting techniques
 *   - Patches were overwritten by a stray `bun install`
 *
 * Escalation ladder on consecutive failures:
 *   1. Self-heal: re-apply CDP stealth patches, re-verify
 *   2. Same. Log elevated warning.
 *   3. Write ~/.nightcrawl/stealth-alert.json. The server does NOT
 *      auto-shutdown (would break user session); the CLI surfaces
 *      this status.
 *
 * Any successful verification resets the counter.
 *
 * Design notes:
 *   - schedule/cancel are injected so tests can use a fake timer
 *   - runVerifier is injected so tests don't launch real browsers
 *   - reapplyPatches is injected so tests don't touch real files
 *
 * [INPUT]: ReinforcementOptions (verifier, timer, patch reapplier)
 * [OUTPUT]: startReinforcementLoop(), stopReinforcementLoop(), types
 * [POS]: Background self-validation layer for the server
 */

import * as fs from 'fs';
import * as path from 'path';
import type { VerifyResult } from './stealth-verifier';

// ─── Types ──────────────────────────────────────────────────────

export interface ReinforcementOptions {
  intervalMs: number;
  initialDelayMs: number;
  stateDir: string;
  runVerifier: () => Promise<VerifyResult>;
  reapplyPatches: () => Promise<void>;
  schedule: (delayMs: number, cb: () => void) => any;
  cancel: (handle: any) => void;
  log?: (msg: string) => void;
}

export interface ReinforcementHandle {
  stop: () => void;
}

interface LoopState {
  consecutiveFailures: number;
  lastTimerHandle: any;
  stopped: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────

function writeAlert(stateDir: string, state: LoopState, lastResult: VerifyResult): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const alertPath = path.join(stateDir, 'stealth-alert.json');
    fs.writeFileSync(alertPath, JSON.stringify({
      timestamp: Date.now(),
      consecutiveFailures: state.consecutiveFailures,
      lastResult,
      message: 'Stealth posture degraded — manual investigation required.',
    }, null, 2));
  } catch {
    // Disk failure — nothing we can do
  }
}

function clearAlert(stateDir: string): void {
  try {
    fs.unlinkSync(path.join(stateDir, 'stealth-alert.json'));
  } catch {
    // Already gone — fine
  }
}

// ─── Main loop ──────────────────────────────────────────────────

async function runOneCheck(
  opts: ReinforcementOptions,
  state: LoopState,
): Promise<void> {
  const log = opts.log ?? (() => {});
  if (state.stopped) return;

  let result: VerifyResult;
  try {
    result = await opts.runVerifier();
  } catch (err: any) {
    log(`[reinforcement] verifier error: ${err?.message || err}`);
    return;
  }

  if (result.passed) {
    if (state.consecutiveFailures > 0) {
      log(`[reinforcement] Recovered after ${state.consecutiveFailures} failures`);
      clearAlert(opts.stateDir);
    }
    state.consecutiveFailures = 0;
    return;
  }

  state.consecutiveFailures++;
  log(`[reinforcement] Verification failed (${state.consecutiveFailures} consecutive)`);

  if (state.consecutiveFailures >= 3) {
    log('[reinforcement] Critical: 3+ consecutive failures, writing alert');
    writeAlert(opts.stateDir, state, result);
    return;
  }

  // 1st or 2nd failure: self-heal
  try {
    await opts.reapplyPatches();
    log('[reinforcement] Re-applied stealth patches as self-heal');
  } catch (err: any) {
    log(`[reinforcement] Patch re-apply failed: ${err?.message || err}`);
  }
}

function scheduleNext(opts: ReinforcementOptions, state: LoopState, delayMs: number): void {
  if (state.stopped) return;
  state.lastTimerHandle = opts.schedule(delayMs, async () => {
    await runOneCheck(opts, state);
    if (!state.stopped) scheduleNext(opts, state, opts.intervalMs);
  });
}

// ─── Public API ─────────────────────────────────────────────────

export function startReinforcementLoop(opts: ReinforcementOptions): ReinforcementHandle {
  const state: LoopState = {
    consecutiveFailures: 0,
    lastTimerHandle: null,
    stopped: false,
  };
  scheduleNext(opts, state, opts.initialDelayMs);
  return {
    stop: () => {
      state.stopped = true;
      if (state.lastTimerHandle != null) {
        opts.cancel(state.lastTimerHandle);
      }
    },
  };
}

export function stopReinforcementLoop(handle: ReinforcementHandle): void {
  handle.stop();
}
