/**
 * [INPUT]: Depends on config.resolveConfig (stateDir) and handoff-consent.eTldPlusOne.
 * [OUTPUT]: Exports EngineDecisionRecord, EngineStats, LearnedRecommendation,
 *           AdviceRegret, recordDecision, readDecisions, aggregateByEngine,
 *           filterRecent, recommendFromStats, recommendForDomain, adviceRegret,
 *           pruneJournal, journalPath, RECENCY_WINDOW_MS.
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
  // ── Reflection (gap #9): what the router ADVISED vs what was actually used, so
  // the system can later measure whether following its own advice helped. Without
  // this pairing aggregateByEngine only knows raw per-engine success, never advice
  // quality. recommended = the engine resolveAutoEngine would pick at decision time.
  recommended?: Engine;
  chosenBy?: 'auto' | 'explicit'; // 'auto' = router resolved it; 'explicit' = agent forced --engine
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
  samples?: number;        // attempts behind the winning engine (for honest prose)
  untried?: Engine;        // the OTHER engine has zero history here — exploration nudge
}

/** Outcome counts for one side of the advice-followed / advice-overridden split. */
export interface RegretBucket {
  attempts: number;
  oks: number;
  successRate: number;
}

export interface AdviceRegret {
  followed: RegretBucket;   // chose the recommended engine
  overridden: RegretBucket; // chose the other engine despite the recommendation
}

const ENGINES: Engine[] = ['headless', 'real'];

// A recommendation is only "learned" once an engine has at least this many
// samples; below it we still recommend but flag the advice as thin.
const MIN_LEARN_SAMPLES = 3;

// Opportunistic cap so the journal can't grow unbounded.
const MAX_JOURNAL_LINES = 5000;

// How far back a domain's outcomes still count. A site's bot posture / our own
// stealth changes over time, so a months-old failure must not dilute today's
// reality forever (mirrors domain-strategy.ts ENTRY_TTL_MS). Records with no
// usable ts are always kept — we never silently drop older-schema data.
export const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

/**
 * Keep only records inside the recency window. A record with no usable numeric
 * ts is kept (older-schema safety). Pure — `now` is injected so it's testable.
 */
export function filterRecent(
  records: EngineDecisionRecord[],
  now: number,
  windowMs: number = RECENCY_WINDOW_MS,
): EngineDecisionRecord[] {
  return records.filter((r) => typeof r.ts !== 'number' || now - r.ts <= windowMs);
}

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

  // Exploration (gap #6): a pure argmax over only the engines that already have
  // history can never discover that an UNTRIED engine is better. Surface the
  // engine with zero records here so the agent can choose to compare it. Advisory
  // only — we never silently route the live (real) browser to "experiment".
  const tried = new Set(candidates.map((c) => c.engine));
  const untried = ENGINES.find((e) => !tried.has(e));

  return {
    engine: best.engine,
    evidence: ranked.map(summary).join(' · '),
    confidence: best.attempts >= MIN_LEARN_SAMPLES ? 'learned' : 'thin',
    samples: best.attempts,
    untried,
  };
}

/**
 * Reflection (gap #9): split outcomes by whether the engine actually used MATCHED
 * the recommendation the router made at decision time. Lets the system audit its
 * own advice — "did following the recommendation succeed more than overriding it?"
 * Records with no captured `recommended` contribute to neither bucket. Pure.
 */
export function adviceRegret(records: EngineDecisionRecord[]): AdviceRegret {
  const mk = (): RegretBucket => ({ attempts: 0, oks: 0, successRate: 0 });
  const followed = mk();
  const overridden = mk();
  for (const r of records) {
    if (!r.recommended) continue;
    const bucket = r.engine === r.recommended ? followed : overridden;
    bucket.attempts++;
    if (r.ok) bucket.oks++;
  }
  followed.successRate = followed.attempts ? followed.oks / followed.attempts : 0;
  overridden.successRate = overridden.attempts ? overridden.oks / overridden.attempts : 0;
  return { followed, overridden };
}

/**
 * Human-readable reflection view (the `engine-stats` command). For each domain
 * inside the recency window: the learned recommendation, the per-engine evidence,
 * and — the point of gap #9 — whether FOLLOWING the router's advice did better
 * than OVERRIDING it. This is how the user/agent can SEE whether the dual-engine
 * decision-making is actually good, not just that it runs. Pure; `now` injected.
 */
export function formatEngineStats(
  records: EngineDecisionRecord[],
  now: number,
  domainFilter?: string,
): string {
  const recent = filterRecent(records, now).filter((r) => !domainFilter || r.domain === domainFilter);
  if (recent.length === 0) {
    return domainFilter
      ? `engine reflection — no outcomes recorded for ${domainFilter} in the last 30 days.`
      : `engine reflection — no outcomes recorded in the last 30 days yet. Browse a few sites and the router will start learning.`;
  }

  // Most-active domains first.
  const byDomain = new Map<string, EngineDecisionRecord[]>();
  for (const r of recent) {
    const g = byDomain.get(r.domain) ?? [];
    g.push(r);
    byDomain.set(r.domain, g);
  }
  const domains = [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length);

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const lines: string[] = ['engine reflection — last 30d (following the router vs overriding it)', ''];
  for (const [domain, rs] of domains) {
    const rec = recommendFromStats(aggregateByEngine(rs));
    lines.push(domain);
    if (rec) {
      lines.push(`  recommended: ${rec.engine} (${rec.confidence}) · ${rec.evidence}`);
      if (rec.untried) lines.push(`  untried: ${rec.untried} has no history here — consider comparing it.`);
    }
    const regret = adviceRegret(rs);
    const f = regret.followed;
    const o = regret.overridden;
    const followedStr = f.attempts ? `followed ${f.oks}/${f.attempts} ok (${pct(f.successRate)})` : 'followed — none';
    const overriddenStr = o.attempts ? `overridden ${o.oks}/${o.attempts} ok (${pct(o.successRate)})` : 'overridden — none';
    let verdict = '';
    if (f.attempts && o.attempts) {
      verdict = f.successRate > o.successRate ? '  ← following the router did better'
        : f.successRate < o.successRate ? '  ← overriding did better — advice may be wrong here'
        : '';
    }
    lines.push(`  advice: ${followedStr} · ${overriddenStr}${verdict}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Convenience: learn a recommendation for a URL's domain from the journal. Only
 * outcomes inside the recency window count (gap #7) — a site that fixed its wall
 * last week shouldn't keep getting mis-routed by months-old failures. `now` is
 * injectable for testing.
 */
export function recommendForDomain(
  domainOrUrl: string,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): LearnedRecommendation | null {
  const domain = domainOrUrl.includes('://') ? eTldPlusOne(domainOrUrl) : domainOrUrl;
  if (!domain) return null;
  const recent = filterRecent(readDecisions(domain, env), now);
  return recommendFromStats(aggregateByEngine(recent));
}
