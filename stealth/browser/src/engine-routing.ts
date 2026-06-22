/**
 * [INPUT]: Composes strategy-advisor (pure) with the live signal sources —
 *          hostile-domains, fingerprint-pinned, has-real-session, domain-strategy.
 *          All sources are injectable for testing.
 * [OUTPUT]: Exports NAV_COMMANDS, gatherSignals, buildNavGuidance, SignalDeps.
 * [POS]: Server-side glue between the request boundary (server.ts /command route)
 *        and the pure advisor. Keeps engine logic OUT of the fragile
 *        handleCommand post-command flow — the route calls this after a nav
 *        command and appends the guidance block to the response.
 *
 * Phase 2 wires the SOFT tier (guidance injected on every navigation response —
 * the "enforced reminder" the agent can't skip). The medium (--force) and the
 * real-engine execution path activate in Phase 3 when Engine R exists.
 */

import { advise, formatGuidance, type Advice, type AdvisorSignals, type Engine } from './strategy-advisor';
import { isHostile } from './hostile-domains';
import { isPinned, pinnedVendor } from './fingerprint-pinned';
import { hasRealBrowserSession } from './has-real-session';
import { rememberedEngine } from './domain-strategy';
import { recommendForDomain, type LearnedRecommendation } from './engine-journal';

/** Navigation verbs whose responses carry the engine-guidance block. */
export const NAV_COMMANDS = new Set(['goto', 'back', 'forward', 'reload']);

export interface SignalDeps {
  isHostile: (url: string) => boolean;
  isPinned: (url: string) => boolean;
  pinnedVendor: (url: string) => string | null;
  hasRealBrowserSession: (url: string) => boolean;
  rememberedEngine: (url: string) => Engine | null;
  /** What the engine journal LEARNED for this domain (null = cold start). */
  learnedRecommendation: (url: string) => LearnedRecommendation | null;
}

const DEFAULT_DEPS: SignalDeps = {
  isHostile,
  isPinned,
  pinnedVendor,
  hasRealBrowserSession,
  rememberedEngine,
  learnedRecommendation: (url) => recommendForDomain(url),
};

/**
 * Collect the live signals for a URL into the advisor's input shape. loginWall
 * and cookieImportFailed are left false here — they are dynamic, post-navigation
 * signals owned by the existing login-wall flow; the route-level guidance focuses
 * on the static engine signals (pinned / logged-in / hostile / memory). fileUpload
 * is task semantics nightCrawl doesn't parse yet (the agent passes --engine).
 */
export function gatherSignals(url: string, deps: SignalDeps = DEFAULT_DEPS): AdvisorSignals {
  return {
    hostile: deps.isHostile(url),
    pinned: deps.isPinned(url),
    vendor: deps.pinnedVendor(url),
    realBrowserSession: deps.hasRealBrowserSession(url),
    rememberedEngine: deps.rememberedEngine(url),
    fileUploadTask: false,
    loginWall: false,
    cookieImportFailed: false,
  };
}

/**
 * The guidance block to append to a navigation response, or null for blank URLs
 * (no page yet → nothing useful to advise, and we don't want to add noise).
 *
 * Layering: safety/strong advisor signals (hostile, file-upload, pinned+session…)
 * always win. Only the WEAK cold-start prior is superseded by what the journal
 * has LEARNED for this domain — so routing keeps improving from real outcomes
 * instead of being frozen at preset guesses. Never silently switches engines;
 * this only changes the recommendation the agent sees.
 */
export function buildNavGuidance(
  url: string,
  chosenEngine: Engine,
  deps: SignalDeps = DEFAULT_DEPS,
): string | null {
  if (!url || url === 'about:blank') return null;
  const signals = gatherSignals(url, deps);
  const base = advise(signals);

  if (base.strength === 'weak') {
    const learned = deps.learnedRecommendation(url);
    if (learned) {
      // Confidence-aware prose: a single lucky sample must NOT read as settled
      // knowledge. Only a fully-'learned' recommendation claims it overrides the
      // default; a 'thin' one is flagged as tentative and may still change.
      const reason = learned.confidence === 'learned'
        ? 'Learned from past outcomes on this domain (overrides the cold-start default).'
        : `Tentative — only ${learned.samples ?? 'a few'} sample(s) so far on this domain; the recommendation may change as outcomes accrue.`;
      // Exploration nudge (gap #6): if the OTHER engine has never run here, say so
      // — the agent can choose to compare it. Advisory; auto never silently probes
      // the live browser.
      const untriedNote = learned.untried
        ? ` · untried: ${learned.untried} has no history here — consider comparing it.`
        : '';
      const advice: Advice = {
        recommendation: learned.engine,
        strength: 'weak',
        reason: reason + untriedNote,
      };
      return formatGuidance(chosenEngine, advice, signals, {
        evidence: learned.evidence,
        label: learned.confidence,
      });
    }
    // Weak prior with nothing learned yet — label it honestly so the agent knows
    // the recommendation will sharpen as outcomes accrue.
    return formatGuidance(chosenEngine, base, signals, { evidence: '', label: 'prior — no history yet' });
  }

  return formatGuidance(chosenEngine, base, signals);
}

/**
 * Resolve which engine an `auto` command should ACTUALLY run on — i.e. let the
 * learned advice TAKE EFFECT instead of only being printed. Conservative by design:
 *  - hostile domains NEVER auto-route to the real (logged-in) browser — safety wins;
 *  - we switch to `real` only when the journal has LEARNED (>=3 samples, confidence
 *    'learned') that real wins for this domain;
 *  - everything else stays headless (the safe background default).
 * The agent can still force either engine explicitly (--engine=...). This never
 * routes a hostile/unknown domain to the real browser, so it can't leak the live
 * session somewhere it shouldn't go.
 */
export function resolveAutoEngine(
  url: string,
  deps: SignalDeps = DEFAULT_DEPS,
): { engine: Engine; reason: string } {
  if (!url || url === 'about:blank') return { engine: 'headless', reason: 'no url' };
  if (deps.isHostile(url)) return { engine: 'headless', reason: 'hostile domain (safety)' };
  const learned = deps.learnedRecommendation(url);
  if (learned && learned.engine === 'real' && learned.confidence === 'learned') {
    return { engine: 'real', reason: `learned real wins (${learned.evidence})` };
  }
  return { engine: 'headless', reason: 'default (advisory only until learned)' };
}
