/**
 * [INPUT]: Depends on skill-journal (read/aggregate/recommend), site-profile
 *          (profileKey/liveProfile), recipe-registry (matchRecipe/formatRecipe), goal
 *          (GoalType), handoff-consent (eTldPlusOne).
 * [OUTPUT]: Exports SkillResolveSource, SkillResolveResult, SkillResolveDeps,
 *           resolveSkillFrom, resolveSkill, surfaceSkill, methodAdviceForNav.
 * [POS]: Skill-library HEART — generalizes the engine loop's domain→site-type→cold-start
 *        resolve to METHODS. Tiers: L1 own learned (exact domain) → L2 own learned
 *        (site-TYPE, 3 domains/8 samples) → L4 curated recipe (recipe-registry) → L5
 *        cold-start. (L3 community is Phase 2.) ADVISORY only: surfaceSkill renders a
 *        runnable shortcut the agent CAN run; an integrity-sensitive method is
 *        CONFIRM_REQUIRED with the runnable line withheld. Never auto-executes.
 */

import {
  filterRecentSkills,
  readSkills,
  aggregateSkills,
  recommendSkill,
  type SkillRecord,
  type SkillRecommendation,
  type SkillShape,
} from './skill-journal';
import { profileKey, liveProfile, type SiteProfile } from './site-profile';
import { matchRecipe, formatRecipe, type Recipe } from './recipe-registry';
import { eTldPlusOne } from './handoff-consent';
import { inferNavGoal, type GoalType } from './goal';

export type SkillResolveSource = 'domain' | 'site-type' | 'curated' | 'cold-start';

export interface SkillResolveResult {
  recommendation: SkillRecommendation | null; // learned method (L1/L2), may be thin at cold-start
  curated: Recipe | null;                      // L4 fallback recipe (recipe-registry)
  source: SkillResolveSource;
  shape: SkillShape | null;                    // the learned method's shape, if any
  integritySensitive: boolean;
  profile: SiteProfile;
}

export interface SkillResolveDeps {
  records: SkillRecord[]; // recency-filtered, ALL
  matchRecipe: (sig: { profile: SiteProfile; url: string; content?: string }) => Recipe | null;
  profileOf: (url: string) => SiteProfile;
}

const MIN_TYPE_DOMAINS = 3;
const MIN_TYPE_SAMPLES = 8;
// A pooled site-type method must actually WORK to be surfaced as a confident learned
// shortcut. Sample counts alone let a method that succeeds ~40% of the time masquerade
// as trustworthy; a below-floor method falls through to a curated recipe or cold-start.
const MIN_TYPE_SUCCESS_RATE = 0.6;

function fromRec(rec: SkillRecommendation | null) {
  return { shape: rec?.record.shape ?? null, integritySensitive: rec?.record.integritySensitive ?? false };
}

/**
 * Resolve the best method for (goalType, url) across tiers. Pure — all I/O in `deps`.
 * L1 the domain's own LEARNED skill; L2 the site-TYPE pooled across other domains; L4 a
 * curated recipe; L5 cold-start. Never throws.
 */
export function resolveSkillFrom(
  goalType: GoalType,
  url: string,
  content: string | undefined,
  deps: SkillResolveDeps,
): SkillResolveResult {
  const domain = url.includes('://') ? eTldPlusOne(url) : url;
  const profile = deps.profileOf(url);
  const siteType = profileKey(profile);
  const recipe = deps.matchRecipe({ profile, url, content });

  // L1 — own learned, exact domain + goal.
  const domainRecs = deps.records.filter((r) => r.domain === domain && r.goalType === goalType);
  const domRec = recommendSkill(aggregateSkills(domainRecs));
  if (domRec && domRec.confidence === 'learned') {
    return { recommendation: domRec, curated: recipe, source: 'domain', profile, ...fromRec(domRec) };
  }

  // L2 — own learned, site-TYPE (pool every OTHER domain of the same type + goal).
  const typeRecs = deps.records.filter(
    (r) => r.goalType === goalType && r.siteType === siteType && r.domain !== domain,
  );
  const distinct = new Set(typeRecs.map((r) => r.domain)).size;
  if (distinct >= MIN_TYPE_DOMAINS && typeRecs.length >= MIN_TYPE_SAMPLES) {
    const typeRec = recommendSkill(aggregateSkills(typeRecs));
    const { attempts, oks } = typeRec?.record ?? { attempts: 0, oks: 0 };
    if (typeRec && attempts > 0 && oks / attempts >= MIN_TYPE_SUCCESS_RATE) {
      const promoted = { ...typeRec, confidence: 'learned' as const };
      return { recommendation: promoted, curated: recipe, source: 'site-type', profile, ...fromRec(promoted) };
    }
  }

  // L4 — curated recipe (recipe-registry).
  if (recipe) {
    return { recommendation: domRec, curated: recipe, source: 'curated', shape: null, integritySensitive: false, profile };
  }

  // L5 — cold-start.
  return { recommendation: domRec, curated: null, source: 'cold-start', shape: null, integritySensitive: false, profile };
}

/** I/O wrapper: gather the recency-filtered skill journal + live profile + curated recipe. */
export function resolveSkill(
  goalType: GoalType,
  url: string,
  content?: string,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): SkillResolveResult {
  return resolveSkillFrom(goalType, url, content, {
    records: filterRecentSkills(readSkills({}, env), now),
    matchRecipe,
    profileOf: (u) => liveProfile(u, env, now),
  });
}

// ─── Advisory surfacing ────────────────────────────────────

function runnableLine(shape: SkillShape): string | null {
  if ('steps' in shape) return `browse chain '${shape.steps.join(' | ')}'`;
  return `browse js 'await fetch("${shape.urlPattern}", {method:"${shape.verb}"}).then(r=>r.text())'`;
}

/**
 * Render the advisory skill block, or '' when there is nothing to advise (cold-start).
 * A safe learned method shows a runnable line; an integrity-sensitive one is
 * CONFIRM_REQUIRED with the runnable line WITHHELD until confirmed. A curated recipe
 * renders via recipe-registry. Never executes anything.
 */
export function surfaceSkill(res: SkillResolveResult, goalType: GoalType): string {
  const head = `goal: ${goalType} · site-type: ${profileKey(res.profile)} · source: ${res.source}`;

  if (res.recommendation && (res.source === 'domain' || res.source === 'site-type')) {
    const r = res.recommendation;
    const lines = [`SKILL_ADVICE (advisory — you run it):`, `  ${head} (${r.confidence})`, `  method: ${r.record.method} · ${r.evidence}`];
    if (res.integritySensitive) {
      lines.push(`  CONFIRM_REQUIRED: this method asserts a fact to a third party — describe it and get explicit confirmation; nightcrawl will gate the action. Runnable shortcut withheld until confirmed.`);
    } else if (res.shape) {
      const line = runnableLine(res.shape);
      if (line) lines.push(`  shortcut: ${line}`);
    }
    return lines.join('\n');
  }

  if (res.source === 'curated' && res.curated) {
    return formatRecipe(res.curated);
  }
  return '';
}

/**
 * Auto nav-time method advice for a weak/stateless driver: infer the goal from the URL,
 * resolve the best learned method or curated recipe, and render it — WITHOUT the agent
 * having to run `nc skills`. Quiet by default (surfaceSkill returns '' at cold-start with
 * no matching recipe). BROWSE_DISABLE_SKILLS=1 turns it off, symmetric to
 * BROWSE_DISABLE_RECIPES. This is what makes the (already-built) method flywheel reach a
 * model that would never call `nc skills` itself.
 */
export function methodAdviceForNav(
  url: string,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): string {
  if (env.BROWSE_DISABLE_SKILLS === '1') return '';
  const goal = inferNavGoal(url);
  return surfaceSkill(resolveSkill(goal, url, undefined, env, now), goal);
}
