/**
 * Unit tests for the plain-English health snapshot formatter.
 * The data-gathering side is exercised via the live daemon — this
 * file only covers the pure formatting from a fixed shape.
 */

import { describe, test, expect } from 'bun:test';
import { formatHealthSnapshot, type HealthSnapshot } from '../src/health-snapshot';

function baseSnapshot(): HealthSnapshot {
  return {
    daemon: {
      engine: 'cloakbrowser',
      seed: 80814,
      mode: 'launched',
      pid: 12345,
      uptimeSec: 7350, // 2h 2m 30s
    },
    browser: {
      url: 'https://example.com/',
      tabCount: 1,
      cookieCount: 1247,
    },
    sync: {
      runCount: 3,
      successCount: 3,
      errorCount: 0,
      lastRunAgoMs: 4_000,
      lastSuccessAgoMs: 4_000,
      lastImportedCount: 0,
      lastBrowser: 'arc',
      intervalMs: 600_000,
      lastError: null,
    },
    handoff: {
      grantedDomains: ['canvas.uw.edu', 'doubao.com'],
      pinnedDomains: ['doubao.com', 'datadome.co'],
    },
  };
}

describe('formatHealthSnapshot', () => {
  test('renders all sections in plain English', () => {
    const out = formatHealthSnapshot(baseSnapshot());
    expect(out).toContain('Daemon');
    expect(out).toContain('Browser');
    expect(out).toContain('Sync');
    expect(out).toContain('Auto-handoff');
    expect(out).toContain('cloakbrowser');
    expect(out).toContain('80814');
    expect(out).toContain('PID 12345');
    expect(out).toContain('1247 cookies');
    expect(out).toContain('canvas.uw.edu');
    expect(out).toContain('doubao.com');
    expect(out).toContain('Run `browse health stealth`');
  });

  test('formats uptime in human units', () => {
    const out = formatHealthSnapshot(baseSnapshot());
    expect(out).toMatch(/uptime.*2h.*2m/);
  });

  test('reports sync as healthy when last run was recent', () => {
    const out = formatHealthSnapshot(baseSnapshot());
    expect(out.toLowerCase()).toContain('last run: 4s ago');
  });

  test('flags sync as STALE when last run is older than 2x interval', () => {
    const snap = baseSnapshot();
    snap.sync.lastRunAgoMs = 25 * 60_000; // 25 min, interval is 10
    const out = formatHealthSnapshot(snap);
    expect(out.toLowerCase()).toContain('stale');
  });

  test('flags sync as DEGRADED when there is a recent error', () => {
    const snap = baseSnapshot();
    snap.sync.lastError = 'keychain access denied';
    snap.sync.errorCount = 2;
    const out = formatHealthSnapshot(snap);
    expect(out.toLowerCase()).toMatch(/degraded|error/);
    expect(out).toContain('keychain access denied');
  });

  test('handles fresh daemon with no sync runs yet', () => {
    const snap = baseSnapshot();
    snap.sync.runCount = 0;
    snap.sync.successCount = 0;
    snap.sync.lastRunAgoMs = null;
    snap.sync.lastSuccessAgoMs = null;
    snap.sync.lastImportedCount = 0;
    snap.sync.lastBrowser = null;
    const out = formatHealthSnapshot(snap);
    expect(out.toLowerCase()).toContain('no runs yet');
  });

  test('elides large granted/pinned lists', () => {
    const snap = baseSnapshot();
    snap.handoff.grantedDomains = Array.from({ length: 25 }, (_, i) => `g${i}.com`);
    snap.handoff.pinnedDomains = Array.from({ length: 25 }, (_, i) => `p${i}.com`);
    const out = formatHealthSnapshot(snap);
    expect(out).not.toContain('g24.com');
    expect(out).not.toContain('p24.com');
    expect(out).toContain('25');
  });

  test('renders mode = headed without breaking', () => {
    const snap = baseSnapshot();
    snap.daemon.mode = 'headed';
    const out = formatHealthSnapshot(snap);
    expect(out).toContain('headed');
  });

  test('handles empty handoff lists', () => {
    const snap = baseSnapshot();
    snap.handoff.grantedDomains = [];
    snap.handoff.pinnedDomains = [];
    const out = formatHealthSnapshot(snap);
    expect(out).toContain('Auto-handoff');
    expect(out).toContain('(none)');
  });
});
