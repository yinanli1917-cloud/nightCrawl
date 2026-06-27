/**
 * [INPUT]: Pure module — no imports. The daemon's reaper loop reads the live tab list
 *          (tab-store) into ReapableTab[] and passes it in; the selection is pure.
 * [OUTPUT]: Exports ReapableTab, ReapPolicy, selectTabsToReap.
 * [POS]: Track B P0-3 (+ P2-1 cap). The real session leaked 9 Engine-R tabs because
 *        nothing closed idle session tabs. This decides WHICH tabs to close: any idle
 *        past the threshold, plus the oldest beyond the cap, never a protected
 *        (active/locked) tab. The actual close (background.js chrome.tabs.remove +
 *        browser-manager closeTab + SessionView eviction) is wired at integration.
 */

export interface ReapableTab {
  id: string;
  sessionId: string;
  lastUsed: number;       // ms timestamp of the last activity on this tab
  protectedTab?: boolean; // active / locked / mid-command — never reaped
}

export interface ReapPolicy {
  idleMs: number;  // reap a tab idle longer than this
  maxTabs: number; // hard cap on non-protected tabs; reap oldest-idle beyond it
}

/**
 * Select the tabs to close. Idle reaping closes anything untouched past idleMs; the
 * cap then closes the oldest survivors until at most maxTabs non-protected tabs
 * remain. Protected tabs are never touched and do not count against the cap. Pure.
 */
export function selectTabsToReap(
  tabs: ReapableTab[],
  now: number,
  policy: ReapPolicy,
): ReapableTab[] {
  const candidates = tabs.filter((t) => !t.protectedTab);
  const reap = new Set<ReapableTab>(candidates.filter((t) => now - t.lastUsed > policy.idleMs));

  const surviving = candidates.filter((t) => !reap.has(t));
  if (surviving.length > policy.maxTabs) {
    const oldestFirst = [...surviving].sort((a, b) => a.lastUsed - b.lastUsed);
    for (let i = 0; i < surviving.length - policy.maxTabs; i++) reap.add(oldestFirst[i]);
  }
  return [...reap];
}
