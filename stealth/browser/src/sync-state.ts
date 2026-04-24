/**
 * [INPUT]: None — pure in-memory state
 * [OUTPUT]: Exports SyncTelemetry, getSyncTelemetry, recordSync*, formatSyncStatus
 * [POS]: Telemetry sink for runBackgroundSync (server.ts) and source
 *        for `nc sync status` (meta-commands.ts)
 *
 * In-memory only by design — no disk persistence. The daemon restarts
 * cleanly, telemetry resets. Persistence would require schema migration
 * for one diagnostic field; not worth it.
 */

const DEFAULT_INTERVAL_MS = 10 * 60_000;

export type SyncTrigger = 'poll' | 'watch' | 'manual';

export interface SyncTelemetry {
  intervalMs: number;
  runCount: number;
  successCount: number;
  errorCount: number;
  skippedCount: number;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastBrowser: string | null;
  lastImportedCount: number;
  lastNewDomains: string[];
  lastSkipReason: string | null;
  lastTrigger: SyncTrigger | null;
  triggerCounts: { poll: number; watch: number; manual: number };
  watchPath: string | null;
}

const telemetry: SyncTelemetry = {
  intervalMs: DEFAULT_INTERVAL_MS,
  runCount: 0,
  successCount: 0,
  errorCount: 0,
  skippedCount: 0,
  lastRunAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  lastBrowser: null,
  lastImportedCount: 0,
  lastNewDomains: [],
  lastSkipReason: null,
  lastTrigger: null,
  triggerCounts: { poll: 0, watch: 0, manual: 0 },
  watchPath: null,
};

export function getSyncTelemetry(): Readonly<SyncTelemetry> {
  return telemetry;
}

export function recordSyncStart(trigger: SyncTrigger = 'manual'): void {
  telemetry.runCount++;
  telemetry.lastRunAt = Date.now();
  telemetry.lastTrigger = trigger;
  telemetry.triggerCounts[trigger]++;
}

export function setWatchPath(p: string | null): void {
  telemetry.watchPath = p;
}

export function recordSyncSuccess(result: {
  importedCount: number;
  newDomains: string[];
  browser: string | null;
}): void {
  telemetry.successCount++;
  telemetry.lastSuccessAt = Date.now();
  telemetry.lastImportedCount = result.importedCount;
  telemetry.lastNewDomains = result.newDomains;
  telemetry.lastBrowser = result.browser;
  telemetry.lastError = null;
}

export function recordSyncError(err: unknown): void {
  telemetry.errorCount++;
  telemetry.lastErrorAt = Date.now();
  if (err instanceof Error) {
    telemetry.lastError = err.message;
  } else if (typeof err === 'string') {
    telemetry.lastError = err;
  } else {
    try {
      telemetry.lastError = JSON.stringify(err);
    } catch {
      telemetry.lastError = String(err);
    }
  }
}

export function recordSyncSkipped(reason: string): void {
  telemetry.skippedCount++;
  telemetry.lastSkipReason = reason;
}

export function resetSyncTelemetryForTesting(): void {
  telemetry.intervalMs = DEFAULT_INTERVAL_MS;
  telemetry.runCount = 0;
  telemetry.successCount = 0;
  telemetry.errorCount = 0;
  telemetry.skippedCount = 0;
  telemetry.lastRunAt = null;
  telemetry.lastSuccessAt = null;
  telemetry.lastErrorAt = null;
  telemetry.lastError = null;
  telemetry.lastBrowser = null;
  telemetry.lastImportedCount = 0;
  telemetry.lastNewDomains = [];
  telemetry.lastSkipReason = null;
  telemetry.lastTrigger = null;
  telemetry.triggerCounts = { poll: 0, watch: 0, manual: 0 };
  telemetry.watchPath = null;
}

function formatAge(then: number, now: number): string {
  const ms = Math.max(0, now - then);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function formatSyncStatus(t: Readonly<SyncTelemetry>, now: number = Date.now()): string {
  const lines: string[] = [];
  lines.push('Background sync (default browser → nightCrawl)');
  if (t.watchPath) {
    lines.push(`  Watcher: real-time on ${t.watchPath}`);
    lines.push(`  Poll fallback: every ${Math.round(t.intervalMs / 60_000)} min`);
  } else {
    lines.push(`  Watcher: (not running — using poll only)`);
    lines.push(`  Interval: every ${Math.round(t.intervalMs / 60_000)} min`);
  }
  lines.push(
    `  Runs: ${t.runCount} (success: ${t.successCount}, errors: ${t.errorCount}, skipped: ${t.skippedCount})`,
  );
  lines.push(
    `  Triggers: watch ${t.triggerCounts.watch}, poll ${t.triggerCounts.poll}, manual ${t.triggerCounts.manual}`,
  );

  if (t.lastRunAt === null) {
    lines.push('  Last run: never — daemon just started, watcher will fire on next Arc cookie write.');
  } else {
    const triggerStr = t.lastTrigger ? ` (${t.lastTrigger})` : '';
    lines.push(`  Last run: ${formatAge(t.lastRunAt, now)}${triggerStr}`);
  }

  if (t.lastSuccessAt !== null) {
    const browserLabel = t.lastBrowser || '(none)';
    lines.push(
      `  Last success: ${formatAge(t.lastSuccessAt, now)} — imported ${t.lastImportedCount} cookies, ` +
        `${t.lastNewDomains.length} new domain(s) from ${browserLabel}`
    );
    if (t.lastNewDomains.length > 0 && t.lastNewDomains.length <= 10) {
      lines.push(`    Domains: ${t.lastNewDomains.join(', ')}`);
    } else if (t.lastNewDomains.length > 10) {
      lines.push(`    (${t.lastNewDomains.length} domains — pass --verbose for full list)`);
    }
  }

  if (t.lastSkipReason && t.lastRunAt !== null) {
    lines.push(`  Last skip reason: ${t.lastSkipReason}`);
  }

  if (t.lastError) {
    const ageStr = t.lastErrorAt !== null ? ` (${formatAge(t.lastErrorAt, now)})` : '';
    lines.push(`  Last error${ageStr}: ${t.lastError}`);
  }

  return lines.join('\n');
}
