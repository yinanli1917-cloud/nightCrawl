/**
 * [INPUT]: Playwright Page/Frame/Locator types; DEFAULT_SESSION_ID from session-id.
 * [OUTPUT]: Exports RefEntry, TabState, TabStore.
 * [POS]: Per-tab state store for BrowserManager. Each tab owns its page plus the
 *        accessibility ref map, active frame, and snapshot baseline — so a
 *        snapshot/navigation on one tab never clobbers another's refs. This is
 *        the storage foundation for per-session tab isolation: in stage 2 there
 *        is a single global active tab; stage 4 makes "active" per-session.
 */

import type { Page, Frame, Locator } from 'playwright';
import { DEFAULT_SESSION_ID } from './session-id';

// ─── Types ──────────────────────────────────────────────────────

export interface RefEntry {
  locator: Locator;
  role: string;
  name: string;
}

export interface TabState {
  page: Page;
  /** Session id that owns this tab. Stage 2-3: always DEFAULT_SESSION_ID. */
  owner: string;
  activeFrame: Frame | null;
  refMap: Map<string, RefEntry>;
  /** Text baseline for snapshot diffing — NOT cleared on navigation. */
  lastSnapshot: string | null;
}

// ─── Store ──────────────────────────────────────────────────────

export class TabStore {
  private tabs = new Map<number, TabState>();
  private _activeId = 0;
  private nextId = 1;

  /** Create a tab for `page`, owned by `owner`, and make it active. Returns id. */
  add(page: Page, owner: string = DEFAULT_SESSION_ID): number {
    const id = this.nextId++;
    this.tabs.set(id, { page, owner, activeFrame: null, refMap: new Map(), lastSnapshot: null });
    this._activeId = id;
    return id;
  }

  drop(id: number): void {
    this.tabs.delete(id);
  }

  clear(): void {
    this.tabs.clear();
  }

  /** Clear all tabs AND reset id counters — fresh start (e.g. handoff). */
  reset(): void {
    this.tabs.clear();
    this._activeId = 0;
    this.nextId = 1;
  }

  has(id: number): boolean {
    return this.tabs.has(id);
  }

  get(id: number): TabState | undefined {
    return this.tabs.get(id);
  }

  size(): number {
    return this.tabs.size;
  }

  ids(): number[] {
    return [...this.tabs.keys()];
  }

  entries(): IterableIterator<[number, TabState]> {
    return this.tabs.entries();
  }

  // ─── Active tab ───────────────────────────────────────────────

  get activeId(): number {
    return this._activeId;
  }

  setActive(id: number): void {
    if (!this.tabs.has(id)) throw new Error(`Tab ${id} not found`);
    this._activeId = id;
  }

  active(): TabState | undefined {
    return this.tabs.get(this._activeId);
  }

  /** The active tab's page, or throw the familiar "no active page" error. */
  activePage(): Page {
    const t = this.tabs.get(this._activeId);
    if (!t) throw new Error('No active page. Use "browse goto <url>" first.');
    return t.page;
  }

  /** {id -> page} projection for callers that only need pages. */
  pages(): Map<number, Page> {
    const m = new Map<number, Page>();
    for (const [id, t] of this.tabs) m.set(id, t.page);
    return m;
  }
}
