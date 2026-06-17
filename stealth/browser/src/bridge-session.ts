/**
 * [INPUT]: None (pure tab-identity resolution).
 * [OUTPUT]: Exports TabIdentity, ChromeTab, resolveBoundTab.
 * [POS]: Phase-3B bridge — robust session ownership. Kimi bound to a raw tabId
 *        and lost the tab on every reconnect/restart; we store a tuple and
 *        re-bind by url(+window/title) so a renumbered or reopened tab is
 *        recovered, and surface SESSION_LOST rather than driving the wrong tab.
 */

export interface TabIdentity {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  openedAt: number;
}

export interface ChromeTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
}

/**
 * Resolve which live Chrome tab is our bound session.
 *   1. If our tabId is still open, it's ours — even if the user navigated it
 *      (Chrome doesn't recycle tabIds within a session).
 *   2. Otherwise re-bind by url (mandatory key), preferring the same window and
 *      then the same title. url is the strongest stable signal; window/title
 *      only break ties so a navigated/renamed tab is still recovered.
 *   3. No url match → null (SESSION_LOST): never act on a tab we can't identify.
 */
export function resolveBoundTab(
  stored: TabIdentity,
  tabs: ChromeTab[],
): { tabId: number; rebound: boolean } | null {
  const byId = tabs.find((t) => t.id === stored.tabId);
  if (byId) return { tabId: byId.id, rebound: false };

  const urlMatches = tabs.filter((t) => t.url === stored.url);
  if (urlMatches.length === 0) return null;

  const score = (t: ChromeTab) =>
    (t.windowId === stored.windowId ? 2 : 0) + (t.title === stored.title ? 1 : 0);
  urlMatches.sort((a, b) => score(b) - score(a));
  return { tabId: urlMatches[0].id, rebound: true };
}
