/**
 * [INPUT]: Depends on network-capture-deep.DeepNetEntry, skill-journal types,
 *          integrity-gate.classifyShapeIntegrity, site-profile.profileKey, goal.GoalType,
 *          metric-budget.MetricVector. Pure.
 * [OUTPUT]: Exports DiscoveryInput, correlate, extractShape, discoverSkill.
 * [POS]: Skill-library discovery brain — turns a verified success into a reusable
 *        backend-shortcut SHAPE. correlate finds the API call that produced the success;
 *        extractShape parameterizes it into a de-identified, replayable shape (no raw
 *        ids, no values — only key names + types). discoverSkill classifies integrity
 *        and builds a SkillRecord (does NOT persist — the caller does, so the gate can
 *        veto first). This is what makes a saved skill replayable with new inputs, not a
 *        frozen one-off.
 */

import type { DeepNetEntry } from './network-capture-deep';
import type { SkillRecord, BackendShape } from './skill-journal';
import type { MetricVector } from './metric-budget';
import type { SiteProfile } from './site-profile';
import type { GoalType } from './goal';
import { profileKey } from './site-profile';
import { classifyShapeIntegrity } from './integrity-gate';

export interface DiscoveryInput {
  entries: DeepNetEntry[];
  verifiedAt: number;
  goalType: GoalType;
  profile: SiteProfile;
  domain: string;
}

const CORRELATION_MS = 30_000;
const TELEMETRY_HOST =
  /google-analytics|googletagmanager|segment\.(io|com)|sentry|datadog|amplitude|mixpanel|doubleclick|hotjar|gator\.volces|facebook\.com\/tr|stats\.g\./i;
const READ_GOALS = new Set<GoalType>(['extract-data', 'export-data', 'fetch-article']);
const MUTATING = /^(POST|PUT|PATCH|DELETE)$/i;

/**
 * Correlate a verified success to the API call(s) that produced it. Window back from
 * verifiedAt, drop third-party telemetry, prefer a mutating 2xx call (for read goals,
 * a GET is fine), rank by mutating-first then closest-to-verify then has-body. Pure.
 */
export function correlate(input: DiscoveryInput): DeepNetEntry[] {
  const inWindow = input.entries.filter(
    (e) => e.timestamp <= input.verifiedAt && input.verifiedAt - e.timestamp <= CORRELATION_MS,
  );
  const clean = inWindow.filter((e) => !TELEMETRY_HOST.test(e.url) && (e.status === undefined || e.status < 400));
  const readGoal = READ_GOALS.has(input.goalType);
  const usable = clean.filter((e) => MUTATING.test(e.method) || (readGoal && /^GET$/i.test(e.method)));
  return [...usable].sort((a, b) => {
    const am = MUTATING.test(a.method) ? 0 : 1;
    const bm = MUTATING.test(b.method) ? 0 : 1;
    if (am !== bm) return am - bm;                                  // mutating first
    const ad = input.verifiedAt - a.timestamp;
    const bd = input.verifiedAt - b.timestamp;
    if (ad !== bd) return ad - bd;                                  // closest to verify
    return (b.reqBody ? 1 : 0) - (a.reqBody ? 1 : 0);              // has-body first
  });
}

function paramSegment(seg: string): string {
  if (/^\d+$/.test(seg)) return '{{id}}';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return '{{id}}';     // uuid
  if (/^[0-9a-f]{16,}$/i.test(seg)) return '{{id}}';              // long hex
  if (/^[A-Za-z0-9_-]{20,}$/.test(seg)) return '{{id}}';         // long opaque token
  return seg;
}

/** Parameterize a concrete call into a de-identified, replayable shape. Pure. */
export function extractShape(entry: DeepNetEntry): BackendShape {
  let pathname = entry.url;
  try { pathname = new URL(entry.url).pathname; } catch {}
  const urlPattern = pathname.split('/').map(paramSegment).join('/');
  const shape: BackendShape = { verb: entry.method.toUpperCase(), urlPattern };
  if (entry.respContentType) shape.contentType = entry.respContentType;
  if (entry.reqBody) {
    try {
      const parsed = JSON.parse(entry.reqBody);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const schema: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          schema[k] = v === null ? 'json' : Array.isArray(v) || typeof v === 'object' ? 'json' : (typeof v as string);
        }
        shape.bodySchema = schema;
      }
    } catch {}
  }
  return shape;
}

/**
 * Discover a reusable skill from a verified success. Returns a SkillRecord (NOT
 * persisted — the caller persists so the integrity gate can veto first), or null if no
 * API call correlated. Pure.
 */
export function discoverSkill(input: DiscoveryInput, metrics: MetricVector): { record: SkillRecord } | null {
  const candidates = correlate(input);
  if (candidates.length === 0) return null;
  const shape = extractShape(candidates[0]);
  const integritySensitive = classifyShapeIntegrity(shape, input.goalType);
  return {
    record: {
      ts: input.verifiedAt,
      goalType: input.goalType,
      siteType: profileKey(input.profile),
      domain: input.domain,
      profile: input.profile,
      method: 'backend-api',
      shape,
      integritySensitive,
      metrics,
      ok: true,
    },
  };
}
