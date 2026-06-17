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

import { advise, formatGuidance, type AdvisorSignals, type Engine } from './strategy-advisor';
import { isHostile } from './hostile-domains';
import { isPinned, pinnedVendor } from './fingerprint-pinned';
import { hasRealBrowserSession } from './has-real-session';
import { rememberedEngine } from './domain-strategy';

/** Navigation verbs whose responses carry the engine-guidance block. */
export const NAV_COMMANDS = new Set(['goto', 'back', 'forward', 'reload']);

export interface SignalDeps {
  isHostile: (url: string) => boolean;
  isPinned: (url: string) => boolean;
  pinnedVendor: (url: string) => string | null;
  hasRealBrowserSession: (url: string) => boolean;
  rememberedEngine: (url: string) => Engine | null;
}

const DEFAULT_DEPS: SignalDeps = {
  isHostile,
  isPinned,
  pinnedVendor,
  hasRealBrowserSession,
  rememberedEngine,
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
 */
export function buildNavGuidance(
  url: string,
  chosenEngine: Engine,
  deps: SignalDeps = DEFAULT_DEPS,
): string | null {
  if (!url || url === 'about:blank') return null;
  const signals = gatherSignals(url, deps);
  return formatGuidance(chosenEngine, advise(signals), signals);
}
