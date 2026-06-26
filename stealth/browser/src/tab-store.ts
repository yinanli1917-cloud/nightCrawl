/**
 * [INPUT]: Playwright Page/Frame/Locator types; DEFAULT_SESSION_ID from session-id.
 * [OUTPUT]: Exports RefEntry, TabState, TabStore.
 * [POS]: Per-tab state store for BrowserManager. Each tab owns its page plus the
 *        accessibility ref map, active frame, and snapshot baseline — so a
 *        snapshot/navigation on one tab never clobbers another's refs. Active tab
 *        is tracked PER SESSION (sessionActive map), not globally: each session
 *        points at its OWN tab, so concurrent sessions never steal each other's
 *        view. The "default" session is the back-compat key for untagged callers.
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
  // Per-SESSION active tab. There is NO single global active tab: each session
  // points at its OWN tab so concurrent sessions never steal each other's view.
  // The "default" session is the back-compat key for untagged callers.
  private sessionActive = new Map<string, number>();
  private nextId = 1;

  /** Create a tab for `page`, owned by `owner`, and make it that session's active. */
  add(page: Page, owner: string = DEFAULT_SESSION_ID): number {
    const id = this.nextId++;
    this.tabs.set(id, { page, owner, activeFrame: null, refMap: new Map(), lastSnapshot: null });
    this.sessionActive.set(owner, id);
    return id;
  }

  /** Remove a tab; if it was its owner's active tab, that session goes tab-less. */
  drop(id: number): void {
    const owner = this.tabs.get(id)?.owner;
    this.tabs.delete(id);
    if (owner !== undefined && this.sessionActive.get(owner) === id) {
      this.sessionActive.delete(owner); // no jump-to-another-tab — owner re-gotos
    }
  }

  clear(): void {
    this.tabs.clear();
    this.sessionActive.clear();
  }

  /** Clear all tabs AND reset id counters — fresh start (e.g. handoff). */
  reset(): void {
    this.tabs.clear();
    this.sessionActive.clear();
    this.nextId = 1;
  }

  has(id: number): boolean {
    return this.tabs.has(id);
  }

  get(id: number): TabState | undefined {
    return this.tabs.get(id);
  }

  ownerOf(id: number): string | undefined {
    return this.tabs.get(id)?.owner;
  }

  size(): number {
    return this.tabs.size;
  }

  ids(): number[] {
    return [...this.tabs.keys()];
  }

  /** Tab ids owned by `sessionId`. */
  idsFor(sessionId: string): number[] {
    const out: number[] = [];
    for (const [id, t] of this.tabs) if (t.owner === sessionId) out.push(id);
    return out;
  }

  entries(): IterableIterator<[number, TabState]> {
    return this.tabs.entries();
  }

  // ─── Per-session active tab ───────────────────────────────────

  activeIdFor(sessionId: string): number {
    return this.sessionActive.get(sessionId) ?? 0;
  }

  activeFor(sessionId: string): TabState | undefined {
    return this.tabs.get(this.activeIdFor(sessionId));
  }

  /** `sessionId`'s active page, or throw — NEVER falls back to another session. */
  activePageFor(sessionId: string): Page {
    const t = this.activeFor(sessionId);
    if (!t) throw new Error('No active page. Use "browse goto <url>" first.');
    return t.page;
  }

  /** Point `sessionId` at one of ITS OWN tabs (own-only — no cross-session switch). */
  setActiveFor(sessionId: string, id: number): void {
    const t = this.tabs.get(id);
    if (!t) throw new Error(`Tab ${id} not found`);
    if (t.owner !== sessionId) throw new Error(`Tab ${id} is owned by another session`);
    this.sessionActive.set(sessionId, id);
  }

  // ─── Default-session aliases (back-compat + manager internals) ─

  get activeId(): number { return this.activeIdFor(DEFAULT_SESSION_ID); }
  setActive(id: number): void { this.setActiveFor(DEFAULT_SESSION_ID, id); }
  active(): TabState | undefined { return this.activeFor(DEFAULT_SESSION_ID); }
  activePage(): Page { return this.activePageFor(DEFAULT_SESSION_ID); }

  /** {id -> page} projection for callers that only need pages. */
  pages(): Map<number, Page> {
    const m = new Map<number, Page>();
    for (const [id, t] of this.tabs) m.set(id, t.page);
    return m;
  }
}
