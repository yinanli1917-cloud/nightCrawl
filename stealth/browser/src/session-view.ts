/**
 * [INPUT]: Type-only on browser-manager.ts (BrowserManager, BrowserState) +
 *          tab-store.ts (RefEntry) + playwright page/frame/context types.
 * [OUTPUT]: Exports the TabView interface, TabInfo type, and the SessionView class.
 * [POS]: Per-session command facade. handleCommand resolves ONE SessionView per
 *        command (bm.forSession(sessionId)) and hands it to every handler, so the
 *        ~100 `bm.getPage()`-style call sites stay untouched while gaining session
 *        scope. The PER-TAB methods resolve the session's OWN active tab (never
 *        another session's); the MANAGER-LEVEL methods (handoff/resume/watch/
 *        recreate/UA/headers/context) delegate to the one shared browser. A
 *        SessionView is a thin sessionId-injecting wrapper — the real per-tab
 *        logic lives once in BrowserManager, keyed by the sessionId passed in.
 */

import type { Page, Frame, Locator, BrowserContext } from 'playwright';
import type { BrowserManager, BrowserState } from './browser-manager';
import type { RefEntry } from './tab-store';

/** One row in a tab listing. `owner` is the session id that owns the tab. */
export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  owner: string;
}

// ─── TabView: the full handler-facing surface ───────────────────
// Implemented by BOTH BrowserManager (the "default" session passthrough) and
// SessionView. Handlers depend on this interface, not the concrete manager, so a
// command is scoped to a session without changing any handler body.
export interface TabView {
  readonly sessionId: string;

  // ── Per-tab page / frame access (resolves THIS session's active tab) ──
  getPage(): Page;
  getCurrentUrl(): string;
  getActiveFrameOrPage(): Page | Frame;
  getFrame(): Frame | null;
  setFrame(frame: Frame | null): void;

  // ── Per-tab refs / snapshot baseline ──
  resolveRef(selector: string): Promise<{ locator: Locator } | { selector: string }>;
  setRefMap(refs: Map<string, RefEntry>): void;
  clearRefs(): void;
  getRefRole(selector: string): string | null;
  getLastSnapshot(): string | null;
  setLastSnapshot(text: string | null): void;

  // ── Tabs (scoped to THIS session) ──
  newTab(url?: string): Promise<number>;
  /** Lazy-create this session's first tab on goto so it never hijacks another's. */
  ensureActiveTab(): Promise<void>;
  closeTab(id?: number, opts?: { admin?: boolean }): Promise<void>;
  switchTab(id: number): void;
  getTabCount(): number;
  getTabListWithTitles(): Promise<TabInfo[]>;
  /** Admin: every tab across all sessions (`tabs --all`). */
  getAllTabsWithTitles(): Promise<TabInfo[]>;
  setViewport(width: number, height: number): Promise<void>;
  /** Run `fn` serialized on this session's active tab (concurrent across sessions). */
  runOnTab<T>(fn: () => Promise<T>): Promise<T>;

  // ── Manager-level (whole shared browser — always delegate) ──
  getConnectionMode(): 'launched' | 'headed';
  handoff(message: string): Promise<string>;
  resume(): Promise<string>;
  saveState(): Promise<BrowserState>;
  restoreState(
    state: BrowserState,
    opts?: { restoreCookies?: boolean; cookieMode?: 'replace' | 'add' },
  ): Promise<void>;
  recreateContext(): Promise<string | null>;
  setUserAgent(ua: string): void;
  setExtraHeader(name: string, value: string): Promise<void>;
  setDialogAutoAccept(accept: boolean): void;
  setDialogPromptText(text: string | null): void;
  isWatching(): boolean;
  startWatch(): void;
  stopWatch(): { snapshots: string[]; duration: number };
  closeAllPages(): Promise<void>;
  readonly context: BrowserContext | null;
  readonly serverPort: number;
}

// ─── SessionView ────────────────────────────────────────────────
export class SessionView implements TabView {
  constructor(private readonly bm: BrowserManager, readonly sessionId: string) {}

  // ── Per-tab page / frame access (inject this session's id) ──
  getPage(): Page { return this.bm.getPage(this.sessionId); }
  getCurrentUrl(): string { return this.bm.getCurrentUrl(this.sessionId); }
  getActiveFrameOrPage(): Page | Frame { return this.bm.getActiveFrameOrPage(this.sessionId); }
  getFrame(): Frame | null { return this.bm.getFrame(this.sessionId); }
  setFrame(frame: Frame | null): void { this.bm.setFrame(frame, this.sessionId); }

  // ── Per-tab refs / snapshot baseline ──
  resolveRef(selector: string) { return this.bm.resolveRef(selector, this.sessionId); }
  setRefMap(refs: Map<string, RefEntry>): void { this.bm.setRefMap(refs, this.sessionId); }
  clearRefs(): void { this.bm.clearRefs(this.sessionId); }
  getRefRole(selector: string): string | null { return this.bm.getRefRole(selector, this.sessionId); }
  getLastSnapshot(): string | null { return this.bm.getLastSnapshot(this.sessionId); }
  setLastSnapshot(text: string | null): void { this.bm.setLastSnapshot(text, this.sessionId); }

  // ── Tabs ──
  newTab(url?: string): Promise<number> { return this.bm.newTab(url, this.sessionId); }
  ensureActiveTab(): Promise<void> { return this.bm.ensureActiveTab(this.sessionId); }
  closeTab(id?: number, opts?: { admin?: boolean }): Promise<void> {
    return this.bm.closeTab(id, { ...opts, sessionId: this.sessionId });
  }
  switchTab(id: number): void { this.bm.switchTab(id, this.sessionId); }
  getTabCount(): number { return this.bm.getTabCount(); }
  getTabListWithTitles(): Promise<TabInfo[]> { return this.bm.getTabListWithTitles(this.sessionId); }
  getAllTabsWithTitles(): Promise<TabInfo[]> { return this.bm.getAllTabsWithTitles(); }
  setViewport(width: number, height: number): Promise<void> { return this.bm.setViewport(width, height, this.sessionId); }
  runOnTab<T>(fn: () => Promise<T>): Promise<T> { return this.bm.runOnTab(fn, this.sessionId); }

  // ── Manager-level passthrough ──
  getConnectionMode() { return this.bm.getConnectionMode(); }
  handoff(message: string): Promise<string> { return this.bm.handoff(message); }
  resume(): Promise<string> { return this.bm.resume(); }
  saveState(): Promise<BrowserState> { return this.bm.saveState(); }
  restoreState(state: BrowserState, opts?: { restoreCookies?: boolean; cookieMode?: 'replace' | 'add' }): Promise<void> {
    return this.bm.restoreState(state, opts);
  }
  recreateContext(): Promise<string | null> { return this.bm.recreateContext(); }
  setUserAgent(ua: string): void { this.bm.setUserAgent(ua); }
  setExtraHeader(name: string, value: string): Promise<void> { return this.bm.setExtraHeader(name, value); }
  setDialogAutoAccept(accept: boolean): void { this.bm.setDialogAutoAccept(accept); }
  setDialogPromptText(text: string | null): void { this.bm.setDialogPromptText(text); }
  isWatching(): boolean { return this.bm.isWatching(); }
  startWatch(): void { this.bm.startWatch(); }
  stopWatch(): { snapshots: string[]; duration: number } { return this.bm.stopWatch(); }
  closeAllPages(): Promise<void> { return this.bm.closeAllPages(); }
  get context(): BrowserContext | null { return this.bm.context; }
  get serverPort(): number { return this.bm.serverPort; }
}
