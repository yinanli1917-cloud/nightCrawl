/**
 * [INPUT]: Depends on metric-budget.score (+ MetricVector), site-profile.SiteProfile,
 *          goal.GoalType, config.resolveConfig (stateDir), handoff-consent.eTldPlusOne.
 * [OUTPUT]: Exports SkillMethod, BackendShape, DomShape, SkillShape, SkillRecord,
 *           SkillStats, SkillRecommendation, recordSkill, readSkills, pruneSkillJournal,
 *           filterRecentSkills, aggregateSkills, recommendSkill, skillJournalPath,
 *           SKILL_RECENCY_MS.
 * [POS]: Skill-library LEARNED tier — an append-only journal of which METHOD reached a
 *        (task, site) outcome, plus pure aggregation that DERIVES the best method by
 *        budget score. Mirrors engine-journal.ts: the engine loop learns which engine,
 *        this learns which method. The router layers this on the curated recipe-registry
 *        exactly as engine-journal layers on strategy-advisor.
 */

import * as fs from 'fs';
import * as path from 'path';
import { score, type MetricVector } from './metric-budget';
import type { SiteProfile } from './site-profile';
import type { GoalType } from './goal';
import { resolveConfig } from './config';

export type SkillMethod = 'backend-api' | 'dom' | 'keyboard' | 'mixed';

/** A replayable backend shortcut: parameterized, secret-stripped (see skill-discovery). */
export interface BackendShape {
  verb: string;
  urlPattern: string;
  bodySchema?: Record<string, string>;
  contentType?: string;
}
/** A UI procedure: pipe-able chain segments. */
export interface DomShape { steps: string[]; }
export type SkillShape = BackendShape | DomShape;

export interface SkillRecord {
  ts: number;
  goalType: GoalType;
  siteType: string;            // profileKey — the L2 generalization dimension
  domain: string;              // eTLD+1 — the L1 dimension
  profile: SiteProfile;        // full profile (for re-keying)
  method: SkillMethod;
  shape: SkillShape;
  integritySensitive: boolean; // classified at discovery (integrity-gate)
  metrics: MetricVector;       // budget-scorable per-outcome vector + verifyOk
  ok: boolean;
  error?: string;
}

export interface SkillStats {
  key: string;                 // goalType|siteType
  method: SkillMethod;
  shape: SkillShape;
  attempts: number;
  oks: number;
  metrics: MetricVector;       // aggregated → score()-able
  integritySensitive: boolean;
  lastTs: number;
}

export interface SkillRecommendation {
  record: SkillStats;
  evidence: string;
  confidence: 'thin' | 'learned';
}

const MIN_LEARN_SAMPLES = 3;
const MAX_JOURNAL_LINES = 5000;
export const SKILL_RECENCY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── Paths + persistence (mirrors engine-journal) ──────────

export function skillJournalPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(resolveConfig(env).stateDir, 'skill-decisions.jsonl');
}

/** Append one skill outcome. Never throws — telemetry must not break a command. */
export function recordSkill(r: SkillRecord, env: Record<string, string | undefined> = process.env): void {
  try {
    const dest = skillJournalPath(env);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.appendFileSync(dest, JSON.stringify(r) + '\n', { mode: 0o600 });
  } catch {}
}

export function readSkills(
  filter: { goalType?: GoalType; siteType?: string; domain?: string } = {},
  env: Record<string, string | undefined> = process.env,
): SkillRecord[] {
  let raw = '';
  try { raw = fs.readFileSync(skillJournalPath(env), 'utf-8'); } catch { return []; }
  const out: SkillRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!r || typeof r.method !== 'string' || typeof r.domain !== 'string') continue;
      if (filter.goalType && r.goalType !== filter.goalType) continue;
      if (filter.siteType && r.siteType !== filter.siteType) continue;
      if (filter.domain && r.domain !== filter.domain) continue;
      out.push(r);
    } catch {}
  }
  return out;
}

export function pruneSkillJournal(env: Record<string, string | undefined> = process.env): void {
  try {
    const dest = skillJournalPath(env);
    const lines = fs.readFileSync(dest, 'utf-8').split('\n').filter((l) => l.trim());
    if (lines.length <= MAX_JOURNAL_LINES) return;
    const kept = lines.slice(lines.length - MAX_JOURNAL_LINES).join('\n') + '\n';
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, kept, { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch {}
}

// ─── Aggregation (pure) ────────────────────────────────────

export function filterRecentSkills(
  records: SkillRecord[],
  now: number,
  windowMs: number = SKILL_RECENCY_MS,
): SkillRecord[] {
  return records.filter((r) => typeof r.ts !== 'number' || now - r.ts <= windowMs);
}

/** Stable group key for a shape — identical shapes aggregate together. */
function shapeKey(shape: SkillShape): string {
  if ('steps' in shape) return `dom:${shape.steps.join('>')}`;
  const keys = Object.keys(shape.bodySchema ?? {}).sort().join(',');
  return `api:${shape.verb} ${shape.urlPattern} {${keys}}`;
}

/** Aggregate a per-outcome metric vector across records (mean of present axes). */
function aggMetrics(rs: SkillRecord[]): MetricVector {
  const oks = rs.filter((r) => r.ok).length;
  const out: MetricVector = { successRate: rs.length ? oks / rs.length : 0 };
  const keys = new Set<string>();
  for (const r of rs) for (const k of Object.keys(r.metrics)) if (k !== 'successRate') keys.add(k);
  for (const k of keys) {
    const vals = rs.map((r) => r.metrics[k]).filter((x): x is number => typeof x === 'number');
    if (vals.length) out[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return out;
}

/** Group records by (goal|site-type, method, shape) into scorable stats. Pure. */
export function aggregateSkills(records: SkillRecord[]): SkillStats[] {
  const groups = new Map<string, SkillRecord[]>();
  for (const r of records) {
    const k = `${r.goalType}|${r.siteType}::${r.method}::${shapeKey(r.shape)}`;
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  const stats: SkillStats[] = [];
  for (const rs of groups.values()) {
    const first = rs[0];
    stats.push({
      key: `${first.goalType}|${first.siteType}`,
      method: first.method,
      shape: first.shape,
      attempts: rs.length,
      oks: rs.filter((r) => r.ok).length,
      metrics: aggMetrics(rs),
      integritySensitive: rs.some((r) => r.integritySensitive),
      lastTs: Math.max(...rs.map((r) => (typeof r.ts === 'number' ? r.ts : 0))),
    });
  }
  return stats;
}

/**
 * Recommend the best-scoring method from per-method stats. Ranks by budget score, then
 * more samples, then recency. Returns null on no history. Pure. Advisory — the router
 * never auto-runs the result.
 */
export function recommendSkill(stats: SkillStats[]): SkillRecommendation | null {
  const candidates = stats.filter((s) => s.attempts > 0);
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort((a, b) => {
    const d = score(b.metrics) - score(a.metrics);
    if (Number.isFinite(d) && Math.abs(d) > 1e-9) return d;
    return b.attempts - a.attempts || b.lastTs - a.lastTs;
  });
  const best = ranked[0];
  const sc = score(best.metrics);
  const scoreStr = Number.isFinite(sc) ? `[score ${sc.toFixed(2)}]` : '[disqualified: policy]';
  return {
    record: best,
    evidence: `${best.method} ${best.oks}/${best.attempts} ok ${scoreStr}`,
    confidence: best.attempts >= MIN_LEARN_SAMPLES ? 'learned' : 'thin',
  };
}
