/**
 * [INPUT]: Depends on cookie-import-browser.listDomains/pickDefaultBrowser and
 *          handoff-consent.eTldPlusOne. Deps are injectable for testing.
 * [OUTPUT]: Exports hasRealBrowserSession(url, deps?) and the SessionDeps type.
 * [POS]: Phase-2 advisor signal — "does the user's real browser hold live state
 *        for this domain?" This is the gate between automatic engines
 *        (headless/real) and a handoff: if the real browser has non-expired
 *        cookies for the domain, we make it work ourselves and NEVER hand the
 *        user a login; if it has none, a one-time handoff is legitimate.
 *
 * Keychain-safe by construction: it reads cookie COUNTS via listDomains, which
 * queries the SQLite store WITHOUT decrypting any value — so it can never
 * trigger the macOS Keychain dialog (decryption is what prompts).
 */

import { eTldPlusOne } from './handoff-consent';
import { listDomains as realListDomains } from './cookie-import-browser';
import { pickDefaultBrowser as realPickDefaultBrowser } from './handoff-cookie-import';

export interface SessionDeps {
  pickDefaultBrowser: () => string | null;
  listDomains: (browser: string) => { domains: Array<{ domain: string; count: number }>; browser: string };
}

const DEFAULT_DEPS: SessionDeps = {
  pickDefaultBrowser: realPickDefaultBrowser,
  listDomains: realListDomains,
};

/**
 * True if the user's default browser holds at least one non-expired cookie whose
 * host belongs to the same registrable domain (eTLD+1) as `url`. listDomains
 * already filters expired cookies, so any returned entry is live state.
 *
 * Matching: strip a leading dot from each stored host_key, then accept it when it
 * equals the target eTLD+1 or is a subdomain of it (`*.uw.edu` satisfies uw.edu).
 * A registrable-domain check, NOT a substring check — notexample.com must never
 * satisfy example.com. Fails safe to false on any error (DB locked, unparseable).
 */
export function hasRealBrowserSession(
  url: string,
  deps: SessionDeps = DEFAULT_DEPS,
): boolean {
  try {
    const domain = eTldPlusOne(url);
    if (!domain) return false;
    const browser = deps.pickDefaultBrowser();
    if (!browser) return false;
    const { domains } = deps.listDomains(browser);
    const suffix = '.' + domain;
    return domains.some(({ domain: host }) => {
      const h = host.replace(/^\./, '');
      return h === domain || h.endsWith(suffix);
    });
  } catch {
    return false;
  }
}
