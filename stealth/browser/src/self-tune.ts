/**
 * [INPUT]: Depends on engine-journal (readDecisions, filterRecent, aggregateByEngine,
 *          recommendFromStats, EngineStats, LearnedRecommendation, EngineDecisionRecord)
 *          + site-profile (profileFromSignals, profileKey, SiteProfile) +
 *          fingerprint-pinned.pinnedVendor + handoff-consent.eTldPlusOne.
 * [OUTPUT]: Exports ResolveSource, ResolveResult, ResolveDeps, resolveFrom, resolve,
 *           TuneAdvice, selfTune.
 * [POS]: A5 learned routing — the generalization + self-tuning layer. resolveFrom
 *        falls back domain -> site-TYPE -> cold-start so a domain with no history of
 *        its own inherits the experience of look-alike domains. selfTune turns the
 *        winning engine's measured behaviour into clamped knob values (timeout from
 *        learned p95, smaller viewport only for static unpinned text sites). Knobs
 *        auto-apply inside their clamp because they cannot pop a window or switch the
 *        engine; the engine decision itself stays conservative (engine-routing).
 */

import {
  readDecisions,
  filterRecent,
  aggregateByEngine,
  recommendFromStats,
  type EngineStats,
  type LearnedRecommendation,
  type EngineDecisionRecord,
} from './engine-journal';
import { profileFromSignals, profileKey, type SiteProfile } from './site-profile';
import { pinnedVendor, type PinVendor } from './fingerprint-pinned';
import { eTldPlusOne } from './handoff-consent';

export type ResolveSource = 'domain' | 'site-type' | 'cold-start';

export interface ResolveResult {
  recommendation: LearnedRecommendation | null; // engine advice (may be thin/null at cold-start)
  source: ResolveSource;
  profile: SiteProfile;
  winner: EngineStats | null; // the recommended engine's stats — the substrate for knob tuning
}

export interface ResolveDeps {
  records: EngineDecisionRecord[]; // recency-filtered, ALL domains
  vendorOf: (url: string) => PinVendor | null;
}

// A site-type recommendation is only trusted once enough DISTINCT domains agree, so a
// single odd domain can't define a whole type, AND there are enough total samples.
const MIN_TYPE_DOMAINS = 3;
const MIN_TYPE_SAMPLES = 8;

// ─── Resolve (pure) ────────────────────────────────────────

function winnerOf(stats: EngineStats[], rec: LearnedRecommendation | null): EngineStats | null {
  return rec ? stats.find((s) => s.engine === rec.engine) ?? null : null;
}

/**
 * Resolve the engine recommendation for a URL across three levels. Pure — all I/O is
 * in `deps`. L1: the domain's own learned history. L2: the site TYPE, aggregated
 * across all OTHER domains that share the profileKey (the generalization). L3:
 * cold-start (the domain's thin history or null). Never throws.
 */
export function resolveFrom(url: string, deps: ResolveDeps): ResolveResult {
  const domain = url.includes('://') ? eTldPlusOne(url) : url;
  const domainRecs = deps.records.filter((r) => r.domain === domain);
  const profile = profileFromSignals(url, {
    vendor: deps.vendorOf(url),
    reloginSeen: domainRecs.some((r) => r.reloginRequired),
    axTimedOut: domainRecs.some((r) => r.axTimedOut),
  });

  // L1 — the domain's own history, once it is learned (not thin).
  const domainStats = aggregateByEngine(domainRecs);
  const domRec = recommendFromStats(domainStats);
  if (domRec && domRec.confidence === 'learned') {
    return { recommendation: domRec, source: 'domain', profile, winner: winnerOf(domainStats, domRec) };
  }

  // L2 — the site TYPE: pool every OTHER domain that looks the same.
  const key = profileKey(profile);
  const typeRecs = deps.records.filter(
    (r) => r.domain !== domain && r.profile && profileKey(r.profile) === key,
  );
  const distinctDomains = new Set(typeRecs.map((r) => r.domain)).size;
  if (distinctDomains >= MIN_TYPE_DOMAINS && typeRecs.length >= MIN_TYPE_SAMPLES) {
    const typeStats = aggregateByEngine(typeRecs);
    const typeRec = recommendFromStats(typeStats);
    if (typeRec) {
      return {
        recommendation: { ...typeRec, confidence: 'learned' },
        source: 'site-type',
        profile,
        winner: winnerOf(typeStats, typeRec),
      };
    }
  }

  // L3 — cold start. Surface whatever thin domain history exists (may be null).
  return { recommendation: domRec, source: 'cold-start', profile, winner: winnerOf(domainStats, domRec) };
}

/** I/O wrapper: gather the recency-filtered journal + vendor, then resolveFrom. */
export function resolve(
  url: string,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): ResolveResult {
  return resolveFrom(url, {
    records: filterRecent(readDecisions(undefined, env), now),
    vendorOf: pinnedVendor,
  });
}

// ─── Self-tuning knobs (clamped) ───────────────────────────

export interface TuneAdvice {
  timeoutBudgetMs: number;
  viewport: { width: number; height: number };
  idleShutdownMs: number;
  recipeId: string | null; // advisory hint only — never auto-executes
  source: ResolveSource;
  evidence: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 90_000;
const DEFAULT_IDLE_MS = 30 * 60_000;
const MIN_IDLE_MS = 5 * 60_000;
const MAX_IDLE_MS = 60 * 60_000;
const FULL_VIEWPORT = { width: 1920, height: 1080 };
const TEXT_VIEWPORT = { width: 1280, height: 720 };

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Turn the resolved winner + profile into clamped knob values. The timeout follows
 * the learned p95 (×1.5 headroom) so a heavy site gets the time it actually needs and
 * a fast site fails fast. The smaller viewport is offered ONLY for a static, unpinned
 * site — never on a pinned site (viewport is a fingerprint surface) or a heavy SPA
 * (needs the room to render). Pure.
 */
export function selfTune(res: ResolveResult): TuneAdvice {
  const p95 = res.winner?.metrics.latencyP95Ms;
  const timeoutBudgetMs = clamp(
    typeof p95 === 'number' ? Math.round(p95 * 1.5) : DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const viewport =
    res.profile.dynamism === 'static' && res.profile.vendor === 'none' ? TEXT_VIEWPORT : FULL_VIEWPORT;
  return {
    timeoutBudgetMs,
    viewport,
    idleShutdownMs: clamp(DEFAULT_IDLE_MS, MIN_IDLE_MS, MAX_IDLE_MS),
    recipeId: null,
    source: res.source,
    evidence: res.recommendation?.evidence ?? 'cold-start (no history)',
  };
}
