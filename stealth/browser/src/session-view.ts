/**
 * [INPUT]: Type-only on browser-manager.ts (BrowserManager, BrowserState) +
 *          tab-store.ts (RefEntry) + playwright page/frame/context types.
 * [OUTPUT]: Exports the TabView interface and the SessionView facade class.
 * [POS]: Per-session command facade. handleCommand resolves ONE SessionView per
 *        command (bm.forSession(sessionId)) and hands it to every handler, so the
 *        ~100 `bm.getPage()`-style call sites stay untouched while gaining session
 *        scope. Stage 3 (here) is a pure passthrough: every method delegates to the
 *        underlying BrowserManager's single global active tab — zero behavior change.
 *        Stage 4 rewrites only the PER-TAB methods to resolve the session's OWN tab;
 *        the MANAGER-LEVEL methods (handoff/resume/watch/recreate/UA/headers/context)
 *        delegate forever because they act on the one shared browser, not a tab.
 */

import type { Page, Frame, Locator, BrowserContext } from 'playwright';
import type { BrowserManager, BrowserState } from './browser-manager';
import type { RefEntry } from './tab-store';

// ─── TabView: the full handler-facing surface ───────────────────
// Implemented by BOTH BrowserManager (the "default" passthrough) and SessionView.
// Handlers depend on this interface, not the concrete BrowserManager, so a command
// can be scoped to a session without changing any handler body.
export interface TabView {
  readonly sessionId: string;

  // ── Per-tab page / frame access (stage 4: session-scoped) ──
  getPage(): Page;
  getCurrentUrl(): string;
  getActiveFrameOrPage(): Page | Frame;
  getFrame(): Frame | null;
  setFrame(frame: Frame | null): void;

  // ── Per-tab refs / snapshot baseline (stage 4: session-scoped) ──
  resolveRef(selector: string): Promise<{ locator: Locator } | { selector: string }>;
  setRefMap(refs: Map<string, RefEntry>): void;
  clearRefs(): void;
  getRefRole(selector: string): string | null;
  getLastSnapshot(): string | null;
  setLastSnapshot(text: string | null): void;

  // ── Tabs (stage 4: session-scoped) ──
  newTab(url?: string): Promise<number>;
  closeTab(id?: number): Promise<void>;
  switchTab(id: number): void;
  getTabCount(): number;
  getTabListWithTitles(): Promise<Array<{ id: number; url: string; title: string; active: boolean }>>;
  setViewport(width: number, height: number): Promise<void>;

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

  // ── Per-tab page / frame access ──
  getPage(): Page { return this.bm.getPage(); }
  getCurrentUrl(): string { return this.bm.getCurrentUrl(); }
  getActiveFrameOrPage(): Page | Frame { return this.bm.getActiveFrameOrPage(); }
  getFrame(): Frame | null { return this.bm.getFrame(); }
  setFrame(frame: Frame | null): void { this.bm.setFrame(frame); }

  // ── Per-tab refs / snapshot baseline ──
  resolveRef(selector: string) { return this.bm.resolveRef(selector); }
  setRefMap(refs: Map<string, RefEntry>): void { this.bm.setRefMap(refs); }
  clearRefs(): void { this.bm.clearRefs(); }
  getRefRole(selector: string): string | null { return this.bm.getRefRole(selector); }
  getLastSnapshot(): string | null { return this.bm.getLastSnapshot(); }
  setLastSnapshot(text: string | null): void { this.bm.setLastSnapshot(text); }

  // ── Tabs ──
  newTab(url?: string): Promise<number> { return this.bm.newTab(url); }
  closeTab(id?: number): Promise<void> { return this.bm.closeTab(id); }
  switchTab(id: number): void { this.bm.switchTab(id); }
  getTabCount(): number { return this.bm.getTabCount(); }
  getTabListWithTitles() { return this.bm.getTabListWithTitles(); }
  setViewport(width: number, height: number): Promise<void> { return this.bm.setViewport(width, height); }

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
