/**
 * [INPUT]: Depends on daemon-readiness.ts (classifyStartup + READY_TIMEOUT_MS).
 * [OUTPUT]: Verifies the startup-wait decision: ready on health, fail-fast on a dead
 *           process / error log, keep waiting while Chromium is still booting.
 * [POS]: Pillar A4 test. Pure logic — encodes the fix for the Cursor-course
 *        "Server failed to start within 8s" churn (8s was too short for a cold boot;
 *        the loop also couldn't tell "still booting" from "actually died").
 */

import { describe, test, expect } from 'bun:test';
import { classifyStartup, READY_TIMEOUT_MS } from '../src/daemon-readiness';

describe('classifyStartup', () => {
  test('ready as soon as health passes (health is definitive)', () => {
    expect(classifyStartup({ healthy: true, errorLogged: false })).toBe('ready');
    expect(classifyStartup({ healthy: true, errorLogged: true })).toBe('ready');
  });

  test('fails fast when a startup error was logged', () => {
    expect(classifyStartup({ healthy: false, errorLogged: true })).toBe('failed');
  });

  test('keeps waiting while not yet healthy and no error logged (cold Chromium boot)', () => {
    expect(classifyStartup({ healthy: false, errorLogged: false })).toBe('waiting');
  });

  test('budget is generous enough for a cold CloakBrowser boot (was 8s)', () => {
    expect(READY_TIMEOUT_MS).toBeGreaterThanOrEqual(30000);
  });
});
