/**
 * [INPUT]: cookie-import-browser, handoff-consent, eTldPlusOne
 * [OUTPUT]: Exports tryAutoImportForWall, defaultBrowserPriority, SSO_HELPER_DOMAINS
 * [POS]: Auto-import bridge for handoff flow within browser module
 *
 * Why this exists: nightCrawl is supposed to be the user's digital twin
 * — when it hits a login wall on a domain the user has approved
 * (~/.nightcrawl/state/handoff-consent.json), it should silently pull
 * fresh cookies from the user's default browser (which the user keeps
 * alive through normal browsing) instead of popping a window.
 *
 * Commit 520a253 added a hard "never run cookie-import-browser" rule
 * (skill + docs) to prevent surprise Keychain dialogs on unknown
 * domains. That over-corrected: it disabled the auto-import path
 * entirely, forcing every Canvas/Zhihu/etc. login through the headed
 * window flow even when the user already has a valid session in Arc.
 *
 * The right gate is per-domain consent (already present), not a blanket
 * never-import rule. This module wires that gate to the auto-import
 * action: approved domain + login wall = auto-import + retry, no window.
 *
 * One Keychain dialog the first time per browser, "Always Allow" it,
 * silent forever after. That matches the user's expectation: import
 * once, persistent thereafter.
 */

import type { BrowserContext, Page } from 'playwright';
import {
  importCookies,
  listDomains,
  findInstalledBrowsers,
  type BrowserInfo,
  type PlaywrightCookie,
} from './cookie-import-browser';
import { eTldPlusOne } from './handoff-consent';

// ─── SSO helper domains ─────────────────────────────────────

/**
 * Common SSO/identity providers that institutional logins redirect through.
 * When the user navigates to a consent-approved domain (e.g. uw.edu) and
 * gets bounced to one of these, we transitively trust the chain because
 * the bounce was triggered by the approved navigation.
 *
 * Conservative list — only widely-recognized identity providers, not
 * arbitrary third-party sites. Grow as new federated-auth ecosystems
 * surface.
 */
export const SSO_HELPER_DOMAINS = [
  'canvaslms.com',         // Canvas SSO router
  'instructure.com',       // Canvas central auth (iad.login.instructure.com etc.)
  'okta.com',              // Okta IdP
  'auth0.com',             // Auth0 IdP
  'microsoftonline.com',   // Azure AD / Entra
  'login.microsoft.com',   // MS login surface
  'login.live.com',        // MS personal accounts
  'duosecurity.com',       // Duo 2FA
  'accounts.google.com',   // Google OAuth
  'google.com',            // catches accounts.google.com too via eTLD+1
  'github.com',            // GitHub OAuth
];

// ─── Browser priority ───────────────────────────────────────

/**
 * Default browser priority for cookie source. Tries Arc first (popular
 * with power users), then Chrome, Brave, Edge. Whichever is installed
 * AND has cookies for the requested domain wins.
 *
 * Skips Firefox/Safari for now — Chromium-family browsers use the same
 * cookie format and Keychain entry, so prompting once for a Chromium
 * browser unlocks all of them in one dialog.
 */
export const DEFAULT_BROWSER_PRIORITY = ['arc', 'chrome', 'brave', 'edge'] as const;

/**
 * Pick the first installed browser from the priority list.
 * Returns null if none are installed.
 */
export function pickDefaultBrowser(): string | null {
  const installed = findInstalledBrowsers();
  const installedNames = new Set(installed.map(b => b.name.toLowerCase()));
  for (const name of DEFAULT_BROWSER_PRIORITY) {
    if (installedNames.has(name)) return name;
  }
  // Fall back to whichever was found first
  return installed[0]?.name?.toLowerCase() ?? null;
}

// ─── Domain candidate list builder ──────────────────────────

/**
 * Given the original navigation target + the wall URL we landed on,
 * compute the set of host_keys we should try to import from the user's
 * default browser. Includes:
 *   1. eTLD+1 of the target (e.g. uw.edu)
 *   2. eTLD+1 of the wall URL (e.g. washington.edu — the IdP)
 *   3. SSO helper domains (canvaslms.com, instructure.com, okta.com, etc.)
 *
 * Returned domains are eTLD+1's. The actual host_key matching against
 * the browser's cookie DB is done by `discoverHostKeys`.
 */
export function buildCandidateDomains(targetUrl: string, wallUrl: string): string[] {
  const set = new Set<string>();
  try { set.add(eTldPlusOne(targetUrl)); } catch {}
  try { set.add(eTldPlusOne(wallUrl)); } catch {}
  for (const sso of SSO_HELPER_DOMAINS) set.add(sso);
  return [...set];
}

/**
 * For a list of candidate eTLD+1 domains, query the browser's cookie DB
 * (via listDomains) to find ALL exact host_keys whose eTLD+1 matches any
 * candidate. This is how we cover dynamic subdomains like
 * `7f032619-fbd5-41ee-ac6c-e629af79ebcd.iad.login.instructure.com`.
 */
export function discoverHostKeys(
  browser: string,
  candidates: string[],
): string[] {
  let domains: { domain: string; count: number }[];
  try {
    domains = listDomains(browser).domains;
  } catch {
    return [];
  }
  const candSet = new Set(candidates);
  const matches: string[] = [];
  for (const { domain } of domains) {
    let etld: string;
    try { etld = eTldPlusOne(domain); } catch { continue; }
    if (candSet.has(etld)) matches.push(domain);
  }
  return matches;
}

// ─── The main entry point ───────────────────────────────────

export interface AutoImportResult {
  attempted: boolean;
  importedCount: number;
  hostKeys: string[];
  browser: string | null;
  error?: string;
}

/**
 * Try to silently import cookies from the user's default browser for
 * the eTLD+1 of the wall URL + SSO helper domains. Adds them to the
 * given Playwright BrowserContext.
 *
 * NEVER prompts (besides the one-time Keychain "Always Allow").
 * Returns a structured result so the caller can log + decide whether to
 * retry the navigation or fall through to the headed-window flow.
 */
export async function tryAutoImportForWall(
  targetUrl: string,
  wallUrl: string,
  context: BrowserContext,
  browser: string | null = pickDefaultBrowser(),
): Promise<AutoImportResult> {
  if (!browser) {
    return { attempted: false, importedCount: 0, hostKeys: [], browser: null, error: 'no installed browser found' };
  }

  const candidates = buildCandidateDomains(targetUrl, wallUrl);
  const hostKeys = discoverHostKeys(browser, candidates);
  if (hostKeys.length === 0) {
    return { attempted: true, importedCount: 0, hostKeys: [], browser };
  }

  try {
    const result = await importCookies(browser, hostKeys);
    if (result.cookies.length > 0) {
      await context.addCookies(result.cookies);
    }
    return {
      attempted: true,
      importedCount: result.cookies.length,
      hostKeys,
      browser,
    };
  } catch (err: any) {
    return {
      attempted: true,
      importedCount: 0,
      hostKeys,
      browser,
      error: err?.message ?? String(err),
    };
  }
}
