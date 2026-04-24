/**
 * [INPUT]: HealthSnapshot — pre-gathered daemon/browser/sync/handoff state
 * [OUTPUT]: Exports HealthSnapshot type + formatHealthSnapshot pure formatter
 * [POS]: View layer for `browse health` plain-English diagnostic.
 *        Data gathering lives in meta-commands.ts so this stays pure/testable.
 *
 * The deep stealth verifier still exists at `browse health stealth` —
 * this is the "is everything OK right now?" daily-driver view.
 */

export interface HealthSnapshot {
  daemon: {
    engine: string;
    seed: number | null;
    mode: string;
    pid: number;
    uptimeSec: number;
  };
  browser: {
    url: string;
    tabCount: number;
    cookieCount: number;
  };
  sync: {
    runCount: number;
    successCount: number;
    errorCount: number;
    lastRunAgoMs: number | null;
    lastSuccessAgoMs: number | null;
    lastImportedCount: number;
    lastBrowser: string | null;
    intervalMs: number;
    lastError: string | null;
  };
  handoff: {
    grantedDomains: string[];
    pinnedDomains: string[];
  };
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m - h * 60;
  if (h < 24) return `${h}h ${remM}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h - d * 24}h`;
}

function formatAgo(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function summarizeList(items: string[], cap: number = 8): string {
  if (items.length === 0) return '(none)';
  if (items.length <= cap) return items.join(', ');
  return `${items.slice(0, cap).join(', ')}, … (${items.length} total)`;
}

export function formatHealthSnapshot(s: HealthSnapshot): string {
  const lines: string[] = [];
  lines.push('nightCrawl Health Snapshot');
  lines.push('');

  // ─── Daemon ─────────────────────────────────────
  lines.push('Daemon');
  const seedStr = s.daemon.seed !== null ? `, seed ${s.daemon.seed}` : '';
  lines.push(`  Engine: ${s.daemon.engine}${seedStr}`);
  lines.push(`  Mode:   ${s.daemon.mode}`);
  lines.push(`  PID ${s.daemon.pid}, uptime ${formatDuration(s.daemon.uptimeSec)}`);
  lines.push('');

  // ─── Browser ────────────────────────────────────
  lines.push('Browser');
  lines.push(`  URL:     ${s.browser.url}`);
  lines.push(`  Tabs:    ${s.browser.tabCount}`);
  lines.push(`  Cookies: ${s.browser.cookieCount} cookies in jar`);
  lines.push('');

  // ─── Sync ───────────────────────────────────────
  const syncTags: string[] = [];
  const intervalMin = Math.round(s.sync.intervalMs / 60_000);
  if (s.sync.lastRunAgoMs !== null && s.sync.lastRunAgoMs > 2 * s.sync.intervalMs) {
    syncTags.push('STALE');
  }
  if (s.sync.lastError) {
    syncTags.push('DEGRADED');
  }
  const syncHeader = syncTags.length > 0 ? `Sync — ${syncTags.join(', ')}` : 'Sync';
  lines.push(syncHeader);
  lines.push(`  Cycle: every ${intervalMin} min`);
  if (s.sync.runCount === 0) {
    lines.push('  No runs yet — daemon recently started.');
  } else {
    const browserLabel = s.sync.lastBrowser || '(none)';
    if (s.sync.lastRunAgoMs !== null) {
      lines.push(`  Last run: ${formatAgo(s.sync.lastRunAgoMs)} (runs: ${s.sync.runCount}, errors: ${s.sync.errorCount})`);
    }
    if (s.sync.lastSuccessAgoMs !== null) {
      lines.push(`  Last success: ${formatAgo(s.sync.lastSuccessAgoMs)} — imported ${s.sync.lastImportedCount} cookies from ${browserLabel}`);
    }
  }
  if (s.sync.lastError) {
    lines.push(`  Last error: ${s.sync.lastError}`);
  }
  lines.push('');

  // ─── Auto-handoff ───────────────────────────────
  lines.push('Auto-handoff');
  lines.push(`  Granted (${s.handoff.grantedDomains.length}): ${summarizeList(s.handoff.grantedDomains)}`);
  lines.push(`  Pinned  (${s.handoff.pinnedDomains.length}): ${summarizeList(s.handoff.pinnedDomains)}`);
  lines.push('');

  lines.push('Run `browse health stealth` for the deep stealth verifier (~25s).');

  return lines.join('\n');
}
