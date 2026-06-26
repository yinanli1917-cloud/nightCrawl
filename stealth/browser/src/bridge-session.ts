/**
 * [INPUT]: None (pure tab-identity resolution + per-session bind planning).
 * [OUTPUT]: Exports TabIdentity, ChromeTab, BoundStore, resolveBoundTab,
 *           planBoundTab, clearBoundByTabId.
 * [POS]: Phase-3B bridge — robust session ownership. Kimi bound to a raw tabId
 *        and lost the tab on every reconnect/restart; we store a tuple and
 *        re-bind by url(+window/title) so a renumbered or reopened tab is
 *        recovered, and surface SESSION_LOST rather than driving the wrong tab.
 *        Stage 7: one bound tab PER SESSION (BoundStore) so concurrent agents on
 *        Engine R never share or steal each other's real-browser tab. This is the
 *        testable mirror of the extension's boundBySession logic (kept in sync).
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

// ─── Per-session bind store ───────────────────────────────────────
/** sessionId → the real-browser tab that session drives. One tab per session. */
export type BoundStore = Map<string, TabIdentity>;

export type BindPlan =
  | { action: 'create' }
  | { action: 'use'; tabId: number; rebound: boolean }
  | { action: 'lost' };

/**
 * Decide what ensureBoundTab should do for `sessionId`, reading ONLY that
 * session's entry (sessions are independent — A's plan never touches B):
 *   - 'create': a goto with no live bound tab for this session → open a fresh one.
 *   - 'use':    drive the resolved (possibly re-bound) tab.
 *   - 'lost':   a non-goto command with no resolvable tab → SESSION_LOST.
 */
export function planBoundTab(
  store: BoundStore,
  sessionId: string,
  command: string,
  tabs: ChromeTab[],
): BindPlan {
  const entry = store.get(sessionId);
  const resolved = entry ? resolveBoundTab(entry, tabs) : null;
  if (command === 'goto' && (!entry || resolved == null)) return { action: 'create' };
  if (!entry || resolved == null) return { action: 'lost' };
  return { action: 'use', tabId: resolved.tabId, rebound: resolved.rebound };
}

/** onRemoved: drop every session whose bound tab was the closed `tabId`. */
export function clearBoundByTabId(store: BoundStore, tabId: number): void {
  for (const [sid, id] of store) {
    if (id.tabId === tabId) store.delete(sid);
  }
}
