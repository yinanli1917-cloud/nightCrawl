/**
 * [INPUT]: Depends on fingerprint-pinned.PinVendor (type only) + readDecisions/
 *          filterRecent (engine-journal) + pinnedVendor (fingerprint-pinned) for the
 *          I/O wrapper. Pure core has no I/O.
 * [OUTPUT]: Exports Vendor, AuthKind, Dynamism, SiteProfile, ProfileSignals,
 *           profileFromSignals, profileKey, liveProfile.
 * [POS]: A5 learned routing. The site-TYPE signature — the "not only the domain"
 *        key. Two different domains that LOOK the same (same bot vendor, same auth
 *        gate, same JS heaviness) share a profileKey, so the loop can pool their
 *        experience and route a domain it has never seen. Derived entirely from
 *        classifiers that already run (zero new sniffing).
 *
 * Why only vendor|authKind|dynamism and not posture/sensitivity: those are SAFETY
 * dimensions, enforced directly (hostile -> headless in engine-routing; sensitive
 * pages gated by sensitive-page.ts). Folding them into the key would fragment the
 * type space without predicting the engine, and sensitivity cannot be derived from a
 * sync store anyway. The key stays the routing-predictive subset.
 */

import type { PinVendor } from './fingerprint-pinned';
import { pinnedVendor } from './fingerprint-pinned';
import { readDecisions, filterRecent, type EngineDecisionRecord } from './engine-journal';
import { eTldPlusOne } from './handoff-consent';

export type Vendor = PinVendor | 'none';
export type AuthKind = 'sso' | 'login-wall' | 'open';
export type Dynamism = 'static' | 'heavy-spa';

export interface SiteProfile {
  vendor: Vendor;     // bot-management vendor pinning this domain (or 'none')
  authKind: AuthKind; // how the site gates identity
  dynamism: Dynamism; // JS heaviness (heavy-spa when the a11y snapshot has fallen back)
}

/** The signals profileFromSignals reads. All optional — absent means "not seen". */
export interface ProfileSignals {
  vendor?: PinVendor | null; // pinnedVendor(url)
  reloginSeen?: boolean;     // a login wall was observed on this domain (journal reloginRequired)
  axTimedOut?: boolean;      // the a11y snapshot fell back here (heavy-JS signal)
}

// An identity-provider / SSO surface: we are AT the login authority, not just behind
// a wall. Mirrors server.ts LOGIN_WALL_HOST_RE/HREF_RE so the classification matches
// the wall detector. SSO sites almost always need the real browser for the handoff.
const SSO_RE =
  /(^|[/.])(idp|sso|accounts|adfs)\.|shibboleth|saml2?|[/.]oauth\b|openid|okta\.com|auth0|microsoftonline|duosecurity/i;

// ─── Pure core ─────────────────────────────────────────────

/** Derive the site type from already-gathered signals. Pure, total — never throws. */
export function profileFromSignals(url: string, sig: ProfileSignals): SiteProfile {
  const authKind: AuthKind = SSO_RE.test(url) ? 'sso' : sig.reloginSeen ? 'login-wall' : 'open';
  return {
    vendor: sig.vendor ?? 'none',
    authKind,
    dynamism: sig.axTimedOut ? 'heavy-spa' : 'static',
  };
}

/** Stable, order-independent join key for site-type aggregation. */
export function profileKey(p: SiteProfile): string {
  return `${p.vendor}|${p.authKind}|${p.dynamism}`;
}

// ─── I/O wrapper ───────────────────────────────────────────

/**
 * Build the live profile for a URL at routing time. Gathers the vendor from the
 * fingerprint-pinned store and the auth/dynamism signals from the domain's recent
 * journal. Sync (no page handle needed). `records`/`now` are injectable for tests.
 */
export function liveProfile(
  url: string,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
  records?: EngineDecisionRecord[],
): SiteProfile {
  const domain = url.includes('://') ? eTldPlusOne(url) : url;
  const recent = filterRecent(records ?? readDecisions(domain, env), now).filter((r) => r.domain === domain);
  return profileFromSignals(url, {
    vendor: pinnedVendor(url),
    reloginSeen: recent.some((r) => r.reloginRequired),
    axTimedOut: recent.some((r) => r.axTimedOut),
  });
}
