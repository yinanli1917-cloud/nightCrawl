/**
 * [INPUT]: Depends on config.resolveConfig (stateDir) and handoff-consent.eTldPlusOne.
 * [OUTPUT]: Exports EngineDecisionRecord, EngineStats, LearnedRecommendation,
 *           recordDecision, readDecisions, aggregateByEngine, recommendFromStats,
 *           recommendForDomain, pruneJournal, journalPath.
 * [POS]: A5 learned engine routing. An append-only journal of every engine
 *        decision + its real outcome, plus pure aggregation that DERIVES the
 *        per-domain recommendation from accumulated experience — not a preset
 *        rule table. The router (engine-routing.ts) reads recommendForDomain and
 *        lets it supersede the weak cold-start priors; safety rules still win.
 *
 * Why a journal and not just "last winner" (domain-strategy.ts): a single winner
 * can't express "real is 5/5 but headless times out 4/6 here" or learn from
 * FAILURES. Recording every outcome (latency, timeouts, re-login) is what lets
 * the recommendation keep improving as users hit scenarios we never pre-modeled.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveConfig } from './config';
import { eTldPlusOne } from './handoff-consent';

export type Engine = 'headless' | 'real';

// ─── Types ─────────────────────────────────────────────────

export interface EngineDecisionRecord {
  ts: number;
  domain: string;          // eTLD+1
  engine: Engine;          // the engine actually used
  command: string;         // e.g. 'goto', 'snapshot'
  ok: boolean;             // did the command succeed?
  latencyMs: number;
  timedOut?: boolean;      // bridge/command hard timeout
  axTimedOut?: boolean;    // accessibility-snapshot fell back (heavy-JS signal)
  reloginRequired?: boolean;
  error?: string;
}

export interface EngineStats {
  engine: Engine;
  attempts: number;
  oks: number;
  successRate: number;     // oks / attempts
  medianLatencyMs: number; // median over OK runs (fast-when-working), else over all
  timeouts: number;        // timedOut + axTimedOut occurrences
  relogins: number;
}

export interface LearnedRecommendation {
  engine: Engine;
  evidence: string;        // human/agent-readable summary of the history
  confidence: 'thin' | 'learned';
}

// A recommendation is only "learned" once an engine has at least this many
// samples; below it we still recommend but flag the advice as thin.
const MIN_LEARN_SAMPLES = 3;

// Opportunistic cap so the journal can't grow unbounded.
const MAX_JOURNAL_LINES = 5000;

// ─── Paths ─────────────────────────────────────────────────

export function journalPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveConfig(env).stateDir, 'engine-decisions.jsonl');
}

// ─── Persistence ───────────────────────────────────────────

/** Append one decision. Never throws — telemetry must not break navigation. */
export function recordDecision(
  record: EngineDecisionRecord,
  env: Record<string, string | undefined> = process.env,
): void {
  try {
    const dest = journalPath(env);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.appendFileSync(dest, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch {}
}

/**
 * Read all decisions (optionally for one domain). Malformed lines are skipped,
 * a missing journal reads as empty — telemetry is best-effort, never a hard error.
 */
export function readDecisions(
  domain?: string,
  env: Record<string, string | undefined> = process.env,
): EngineDecisionRecord[] {
  let raw = '';
  try { raw = fs.readFileSync(journalPath(env), 'utf-8'); } catch { return []; }
  const out: EngineDecisionRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.engine === 'string' && typeof r.domain === 'string') {
        if (!domain || r.domain === domain) out.push(r);
      }
    } catch {}
  }
  return out;
}

/** Trim the journal to its most recent MAX_JOURNAL_LINES. Opportunistic, safe. */
export function pruneJournal(
  env: Record<string, string | undefined> = process.env,
): void {
  try {
    const dest = journalPath(env);
    const lines = fs.readFileSync(dest, 'utf-8').split('\n').filter((l) => l.trim());
    if (lines.length <= MAX_JOURNAL_LINES) return;
    const kept = lines.slice(lines.length - MAX_JOURNAL_LINES).join('\n') + '\n';
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, kept, { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch {}
}

// ─── Aggregation (pure) ────────────────────────────────────

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Group records by engine into success/latency/timeout stats. Pure. */
export function aggregateByEngine(records: EngineDecisionRecord[]): EngineStats[] {
  const groups = new Map<Engine, EngineDecisionRecord[]>();
  for (const r of records) {
    const g = groups.get(r.engine) ?? [];
    g.push(r);
    groups.set(r.engine, g);
  }
  const stats: EngineStats[] = [];
  for (const [engine, rs] of groups) {
    const oks = rs.filter((r) => r.ok);
    const okLatencies = oks.map((r) => r.latencyMs);
    const timeouts = rs.filter((r) => r.timedOut || r.axTimedOut).length;
    stats.push({
      engine,
      attempts: rs.length,
      oks: oks.length,
      successRate: rs.length ? oks.length / rs.length : 0,
      medianLatencyMs: median(okLatencies.length ? okLatencies : rs.map((r) => r.latencyMs)),
      timeouts,
      relogins: rs.filter((r) => r.reloginRequired).length,
    });
  }
  return stats;
}

/**
 * Derive a recommendation from per-engine stats. Pure, deterministic. Ranks by
 * success rate, then lower latency, then fewer timeouts. Returns null on no
 * history (the caller falls back to a cold-start prior). Confidence is "learned"
 * once the winner has enough samples, else "thin".
 */
export function recommendFromStats(stats: EngineStats[]): LearnedRecommendation | null {
  const candidates = stats.filter((s) => s.attempts > 0);
  if (candidates.length === 0) return null;

  const ranked = [...candidates].sort((a, b) =>
    b.successRate - a.successRate ||
    a.medianLatencyMs - b.medianLatencyMs ||
    a.timeouts - b.timeouts,
  );
  const best = ranked[0];

  const summary = (s: EngineStats) =>
    `${s.engine} ${s.oks}/${s.attempts} ok ~${(s.medianLatencyMs / 1000).toFixed(1)}s` +
    (s.timeouts ? `, ${s.timeouts} timeouts` : '');

  return {
    engine: best.engine,
    evidence: ranked.map(summary).join(' · '),
    confidence: best.attempts >= MIN_LEARN_SAMPLES ? 'learned' : 'thin',
  };
}

/** Convenience: learn a recommendation for a URL's domain from the journal. */
export function recommendForDomain(
  domainOrUrl: string,
  env: Record<string, string | undefined> = process.env,
): LearnedRecommendation | null {
  const domain = domainOrUrl.includes('://') ? eTldPlusOne(domainOrUrl) : domainOrUrl;
  if (!domain) return null;
  return recommendFromStats(aggregateByEngine(readDecisions(domain, env)));
}
