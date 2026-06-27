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
import { score, isVerifyOk, isHeadedPopViolation, type MetricVector } from './metric-budget';

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
  // ── Multi-dimensional metric vector (Track A). Populated as the Track B signal
  // sources land; a missing field is N/A by design (excluded from scoring), never 0.
  navMs?: number;          // navigation-phase latency (excludes login-wall recovery)
  recoveryMs?: number;     // login-wall recovery phase — headless-only, NOT a latency penalty
  windowPopped?: boolean;  // a headed/visible window was shown for this command (focus-theft)
  tabDelta?: number;       // tabs created by this command (left open => tab leak)
  bannerEmitted?: boolean; // the engine-guidance banner printed (output noise)
  verifyOk?: boolean;      // deliverable verification passed (VERIFY_OK)
  policyViolated?: boolean;// a hard safety gate was tripped to complete (Completion-under-Policy fail)
  cpuPct?: number;         // daemon CPU% over this command
  rssMb?: number;          // daemon RSS (MB) at command end
}

export interface EngineStats {
  engine: Engine;
  attempts: number;
  oks: number;
  successRate: number;     // oks / attempts
  medianLatencyMs: number; // median over OK runs (fast-when-working), else over all
  timeouts: number;        // timedOut + axTimedOut occurrences
  relogins: number;
  metrics: MetricVector;   // the budget-scorable vector — this engine vs the seed SLOs
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

// Two engines whose budget scores fall within this band are a tie; we then prefer the
// less invasive engine (headless) rather than switching the user's live browser to
// shave a difference they cannot feel.
const SCORE_EPSILON = 0.02;

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

export interface LatencyMarks {
  startedAt: number;
  endedAt: number;
  recoveryStartedAt?: number; // when login-wall recovery began (headless only)
  recoveryEndedAt?: number;
}

/**
 * Split a command's wall time into the navigation phase (navMs) and the login-wall
 * recovery phase (recoveryMs). Headless `goto` runs a recovery pipeline Engine R
 * never does, so the loop scores latency on navMs to keep the cross-engine comparison
 * fair (the audit-bias fix). navMs falls back to the full latency when no recovery
 * ran. All values clamp to >= 0 against clock skew. Pure.
 */
export function splitLatency(marks: LatencyMarks): { latencyMs: number; navMs: number; recoveryMs: number } {
  const latencyMs = Math.max(0, marks.endedAt - marks.startedAt);
  const recoveryMs =
    marks.recoveryStartedAt != null && marks.recoveryEndedAt != null
      ? Math.max(0, marks.recoveryEndedAt - marks.recoveryStartedAt)
      : 0;
  return { latencyMs, navMs: Math.max(0, latencyMs - recoveryMs), recoveryMs };
}

/** Runtime signals the server measures around a command and hands to the bridge. */
export interface OutcomeRuntime {
  marks?: LatencyMarks;   // for the navMs/recoveryMs split
  windowPopped?: boolean; // a headed/visible window was shown (focus-theft)
  tabDelta?: number;      // tabs created by this command
  bannerEmitted?: boolean;// the engine-guidance banner printed
  cpuPct?: number;        // daemon CPU% over this command
  rssMb?: number;         // daemon RSS (MB) at command end
}

/**
 * Track A->B bridge core: derive the metric-vector fields for a journal record from
 * the response text + the measured runtime signals. verifyOk and policyViolated come
 * from the unified policy predicates (the same vocabulary the benchmark uses), latency
 * is split into nav vs recovery, and the measured signals pass through. A signal that
 * was not measured stays undefined (N/A by design, never 0). Pure — the server adds
 * `profile` (liveProfile) at the call-site and merges this in.
 */
export function buildOutcomeMetrics(text: string, rt: OutcomeRuntime = {}): Partial<EngineDecisionRecord> {
  const lat = rt.marks ? splitLatency(rt.marks) : undefined;
  const verifyOk = isVerifyOk(text) ? true : text.includes('VERIFY_FAILED') ? false : undefined;
  const policyViolated = rt.windowPopped || isHeadedPopViolation(text) ? true : undefined;
  return {
    navMs: lat?.navMs,
    recoveryMs: lat?.recoveryMs,
    verifyOk,
    policyViolated,
    windowPopped: rt.windowPopped,
    tabDelta: rt.tabDelta,
    bannerEmitted: rt.bannerEmitted,
    cpuPct: rt.cpuPct,
    rssMb: rt.rssMb,
  };
}

function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/** Fraction of records (where the selector is defined) for which it is truthy. */
function definedRate(
  rs: EngineDecisionRecord[],
  sel: (r: EngineDecisionRecord) => boolean | undefined,
): number | undefined {
  const defined = rs.filter((r) => sel(r) !== undefined);
  if (defined.length === 0) return undefined;
  return defined.filter((r) => sel(r)).length / defined.length;
}

/**
 * Build the budget-scorable metric vector for one engine's records. Each axis is
 * undefined when its signal has not been recorded yet (the Track B sources light it
 * up later); a missing axis is N/A by design, never a 0. Latency scores the
 * navigation phase (navMs), not the headless-only login-wall recovery, so the
 * cross-engine comparison is like-for-like. Pure.
 */
function metricsFor(rs: EngineDecisionRecord[]): MetricVector {
  const oks = rs.filter((r) => r.ok);
  const lat = (oks.length ? oks : rs).map((r) => r.navMs ?? r.latencyMs);
  const nums = (sel: (r: EngineDecisionRecord) => number | undefined) =>
    rs.map(sel).filter((x): x is number => typeof x === 'number');
  const cpu = nums((r) => r.cpuPct);
  const rss = nums((r) => r.rssMb);
  const policy = rs.filter((r) => r.policyViolated !== undefined);
  return {
    successRate: rs.length ? oks.length / rs.length : 0,
    latencyP95Ms: lat.length ? percentile(lat, 95) : undefined,
    cpuPctMean: cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : undefined,
    rssMbPeak: rss.length ? Math.max(...rss) : undefined,
    verifyOkRate: definedRate(rs, (r) => r.verifyOk),
    focusStolenRate: definedRate(rs, (r) => r.windowPopped),
    tabLeakRate: definedRate(rs, (r) => (r.tabDelta === undefined ? undefined : r.tabDelta > 0)),
    bannerNoiseRate: definedRate(rs, (r) => r.bannerEmitted),
    completionUnderPolicy: policy.length === 0 ? undefined : policy.some((r) => r.policyViolated) ? 0 : 1,
  };
}

/** Group records by engine into success/latency/timeout stats + a metric vector. Pure. */
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
      metrics: metricsFor(rs),
    });
  }
  return stats;
}

/** Tie-break: prefer the less invasive engine (headless) when scores are level. */
function tieBreak(a: EngineStats, b: EngineStats): number {
  return a.engine === 'headless' ? -1 : b.engine === 'headless' ? 1 : 0;
}

/**
 * Derive a recommendation from per-engine stats. Pure, deterministic. Ranks by the
 * multi-dimensional BUDGET SCORE (speed, CPU, memory, focus-theft, tab-leak,
 * correctness, completion-under-policy), not raw success rate — a twin that loads 5%
 * more often but steals the user's browser is a worse twin. A violated hard gate
 * disqualifies an engine (-Infinity). A tie within SCORE_EPSILON falls to the
 * non-intrusive default (headless). Returns null on no history (the caller falls back
 * to a cold-start prior). Confidence is "learned" once the winner has enough samples.
 */
export function recommendFromStats(stats: EngineStats[]): LearnedRecommendation | null {
  const candidates = stats.filter((s) => s.attempts > 0);
  if (candidates.length === 0) return null;

  const scored = candidates.map((s) => ({ s, v: score(s.metrics) }));
  scored.sort((a, b) => {
    if (a.v === b.v) return tieBreak(a.s, b.s);
    if (!Number.isFinite(a.v - b.v)) return b.v - a.v; // a disqualified (-Infinity) engine sinks
    if (Math.abs(b.v - a.v) <= SCORE_EPSILON) return tieBreak(a.s, b.s);
    return b.v - a.v;
  });
  const best = scored[0].s;

  const summary = (s: EngineStats) => {
    const sc = score(s.metrics);
    const scoreStr = Number.isFinite(sc) ? `[score ${sc.toFixed(2)}]` : '[disqualified: policy]';
    return `${s.engine} ${s.oks}/${s.attempts} ok ~${(s.medianLatencyMs / 1000).toFixed(1)}s` +
      (s.timeouts ? `, ${s.timeouts} timeouts` : '') + ` ${scoreStr}`;
  };

  // Exploration (gap #6): an argmax over only the engines that already have history
  // can never discover that an UNTRIED engine is better. Surface the engine with zero
  // records so the agent can choose to compare it. Advisory only — we never silently
  // route the live (real) browser to "experiment".
  const tried = new Set(candidates.map((c) => c.engine));
  const untried = ENGINES.find((e) => !tried.has(e));

  return {
    engine: best.engine,
    evidence: scored.map(({ s }) => summary(s)).join(' · '),
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
