/**
 * Unit tests for sync-state — pure in-memory telemetry for the
 * background Arc→nightCrawl cookie sync. Telemetry powers
 * `nc sync status` and lets the user diagnose silent sync failures
 * without reading daemon logs.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getSyncTelemetry,
  recordSyncStart,
  recordSyncSuccess,
  recordSyncError,
  recordSyncSkipped,
  resetSyncTelemetryForTesting,
  formatSyncStatus,
  setWatchPath,
} from '../src/sync-state';

describe('sync-state', () => {
  beforeEach(() => resetSyncTelemetryForTesting());

  test('initial state has zero counters and null timestamps', () => {
    const t = getSyncTelemetry();
    expect(t.runCount).toBe(0);
    expect(t.successCount).toBe(0);
    expect(t.errorCount).toBe(0);
    expect(t.skippedCount).toBe(0);
    expect(t.lastRunAt).toBeNull();
    expect(t.lastSuccessAt).toBeNull();
    expect(t.lastErrorAt).toBeNull();
    expect(t.lastError).toBeNull();
    expect(t.lastBrowser).toBeNull();
    expect(t.lastImportedCount).toBe(0);
    expect(t.lastNewDomains).toEqual([]);
    expect(t.intervalMs).toBe(10 * 60_000);
    expect(t.lastTrigger).toBeNull();
    expect(t.triggerCounts).toEqual({ poll: 0, watch: 0, manual: 0 });
    expect(t.watchPath).toBeNull();
  });

  test('recordSyncStart increments runCount, sets lastRunAt, defaults trigger to manual', () => {
    const before = Date.now();
    recordSyncStart();
    const t = getSyncTelemetry();
    expect(t.runCount).toBe(1);
    expect(t.lastRunAt).not.toBeNull();
    expect(t.lastRunAt!).toBeGreaterThanOrEqual(before);
    expect(t.lastTrigger).toBe('manual');
    expect(t.triggerCounts.manual).toBe(1);
  });

  test('recordSyncStart records explicit trigger and bumps trigger counter', () => {
    recordSyncStart('watch');
    recordSyncStart('watch');
    recordSyncStart('poll');
    const t = getSyncTelemetry();
    expect(t.lastTrigger).toBe('poll');
    expect(t.triggerCounts).toEqual({ poll: 1, watch: 2, manual: 0 });
    expect(t.runCount).toBe(3);
  });

  test('setWatchPath populates watchPath, formatSyncStatus shows real-time', () => {
    setWatchPath('/path/to/Cookies');
    const t = getSyncTelemetry();
    expect(t.watchPath).toBe('/path/to/Cookies');
    const out = formatSyncStatus(t);
    expect(out).toContain('real-time');
    expect(out).toContain('/path/to/Cookies');
  });

  test('recordSyncSuccess records result, increments successCount, clears lastError', () => {
    recordSyncStart();
    recordSyncError('previous error');
    recordSyncSuccess({ importedCount: 5, newDomains: ['a.com', 'b.com'], browser: 'arc' });
    const t = getSyncTelemetry();
    expect(t.successCount).toBe(1);
    expect(t.lastImportedCount).toBe(5);
    expect(t.lastNewDomains).toEqual(['a.com', 'b.com']);
    expect(t.lastBrowser).toBe('arc');
    expect(t.lastError).toBeNull();
    expect(t.lastSuccessAt).not.toBeNull();
  });

  test('recordSyncError increments errorCount, stores message and timestamp', () => {
    recordSyncError(new Error('boom'));
    const t = getSyncTelemetry();
    expect(t.errorCount).toBe(1);
    expect(t.lastError).toBe('boom');
    expect(t.lastErrorAt).not.toBeNull();
  });

  test('recordSyncError accepts strings and unknowns', () => {
    recordSyncError('plain string');
    expect(getSyncTelemetry().lastError).toBe('plain string');
    recordSyncError({ weird: 'object' });
    expect(getSyncTelemetry().lastError).toContain('object');
  });

  test('error after success keeps lastSuccessAt populated', () => {
    recordSyncSuccess({ importedCount: 1, newDomains: [], browser: 'arc' });
    const successAt = getSyncTelemetry().lastSuccessAt;
    recordSyncError('boom');
    const t = getSyncTelemetry();
    expect(t.lastSuccessAt).toBe(successAt);
    expect(t.lastError).toBe('boom');
  });

  test('recordSyncSkipped increments skippedCount with a reason', () => {
    recordSyncSkipped('headed-mode');
    const t = getSyncTelemetry();
    expect(t.skippedCount).toBe(1);
    expect(t.lastSkipReason).toBe('headed-mode');
  });

  test('formatSyncStatus on fresh state explains daemon just started', () => {
    const out = formatSyncStatus(getSyncTelemetry(), Date.now());
    expect(out).toContain('Background sync');
    expect(out).toContain('every 10 min');
    expect(out).toMatch(/never|just started|fire on next/i);
  });

  test('formatSyncStatus shows last success summary', () => {
    recordSyncStart();
    recordSyncSuccess({ importedCount: 12, newDomains: ['news.ycombinator.com'], browser: 'arc' });
    const t = getSyncTelemetry();
    const now = (t.lastSuccessAt as number) + 30_000;
    const out = formatSyncStatus(t, now);
    expect(out).toContain('imported 12');
    expect(out).toContain('news.ycombinator.com');
    expect(out).toContain('arc');
  });

  test('formatSyncStatus surfaces a recent error', () => {
    recordSyncStart();
    recordSyncError('keychain denied');
    const t = getSyncTelemetry();
    const out = formatSyncStatus(t, (t.lastErrorAt as number) + 1000);
    expect(out).toContain('keychain denied');
    expect(out.toLowerCase()).toContain('error');
  });

  test('formatSyncStatus elides large domain lists', () => {
    const many = Array.from({ length: 50 }, (_, i) => `d${i}.com`);
    recordSyncSuccess({ importedCount: 100, newDomains: many, browser: 'arc' });
    const out = formatSyncStatus(getSyncTelemetry(), Date.now());
    // Should not dump all 50 inline
    expect(out).not.toContain('d49.com');
    expect(out).toContain('50');
  });
});
