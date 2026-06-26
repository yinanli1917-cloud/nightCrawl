/**
 * [INPUT]: Depends on stealth.ts for anti-bot patches, buffers.ts for event capture,
 *          engine-config.ts + cloakbrowser-engine.ts for engine selection
 * [OUTPUT]: Exports BrowserManager class, BrowserState/RefEntry types
 * [POS]: Core browser lifecycle manager within browser engine
 *
 * Chromium crash handling:
 *   browser.on('disconnected') -> log error -> process.exit(1)
 *   CLI detects dead server -> auto-restarts on next command
 *   We do NOT try to self-heal -- don't hide failure.
 *
 * Dialog handling:
 *   page.on('dialog') -> auto-accept by default -> store in dialog buffer
 *   Prevents browser lockup from alert/confirm/prompt
 *
 * Context recreation (useragent):
 *   recreateContext() saves cookies/storage/URLs, creates new context,
 *   restores state. Falls back to clean slate on any failure.
 */

import type { Browser, BrowserContext, BrowserContextOptions, Page, Locator, Cookie } from 'playwright';

// Lazy import: playwright must NOT be loaded until AFTER CDP patches are applied.
// Static imports resolve before any function body runs, so patches would miss.
let _chromium: typeof import('playwright').chromium;
export async function getChromium() {
  if (!_chromium) {
    const pw = await import('playwright');
    _chromium = pw.chromium;
  }
  return _chromium;
}
import { addConsoleEntry, addNetworkEntry, addDialogEntry, networkBuffer, type DialogEntry } from './buffers';
import { validateNavigationUrl } from './url-validation';
import { assertSafeNavigation, filterHostileCookies } from './hostile-domains';
import { replaceCookiesFor } from './handoff-cookie-import';
import { checkpointSession, flushNativeProfile } from './session-store';
import { applyLocale, buildAcceptLanguage, resolveLocale } from './locale';
import { parseEngineConfig } from './engine-config';
import { launchCloakBrowser, type CloakBrowserLaunchOptions } from './cloakbrowser-engine';
import { loadDeviceAnchor, applyAnchor } from './fingerprint-clone';
import { DEFAULT_USER_AGENT } from './stealth';
import { markPinnedFromHeaders } from './fingerprint-pinned';
import { TabStore, type RefEntry } from './tab-store';
import { SessionView, type TabView, type TabInfo } from './session-view';
import { DEFAULT_SESSION_ID } from './session-id';

export type { RefEntry };
export { DEFAULT_USER_AGENT } from './stealth';
export { isPatchCurrent } from './stealth';
export { generateLaunchAgentPlist } from './launch-agent';

function exitOnUnexpectedDisconnect(code: number): void {
  if (process.env.NIGHTCRAWL_NO_EXIT_ON_DISCONNECT === '1') return;
  process.exit(code);
}

function noExitOnUnexpectedDisconnect(): boolean {
  return process.env.NIGHTCRAWL_NO_EXIT_ON_DISCONNECT === '1';
}

export interface BrowserState {
  cookies: Cookie[];
  pages: Array<{
    url: string;
    isActive: boolean;
    storage: { localStorage: Record<string, string>; sessionStorage: Record<string, string> } | null;
  }>;
}

// ─── BrowserManager ─────────────────────────────────────────
export class BrowserManager implements TabView {
  /** @internal */ browser: Browser | null = null;
  /** @internal */ context: BrowserContext | null = null;
  /** TabView identity: the manager itself IS the "default" session passthrough. */
  readonly sessionId: string = DEFAULT_SESSION_ID;
  /** @internal — owns tabs + per-tab state (page, refMap, frame, snapshot baseline). */
  tabs = new TabStore();
  /** @internal — cached per-session views (one facade per session id). */
  private sessionViews = new Map<string, SessionView>();
  /** @internal */ extraHeaders: Record<string, string> = {};
  /** @internal */ customUserAgent: string | null = null;

  /** Server port -- set after server starts, used by cookie-import-browser command */
  public serverPort: number = 0;

  // ─── Dialog Handling ──────────────────────────────────────
  /** @internal */ dialogAutoAccept: boolean = true;
  /** @internal */ dialogPromptText: string | null = null;

  // ─── Handoff State ─────────────────────────────────────────
  /** @internal */ isHeaded: boolean = false;
  /** @internal */ consecutiveFailures: number = 0;

  // ─── Watch Mode ─────────────────────────────────────────
  private watching = false;
  public watchInterval: ReturnType<typeof setInterval> | null = null;
  private watchSnapshots: string[] = [];
  private watchStartTime: number = 0;

  // ─── Headed State ────────────────────────────────────────
  /** @internal */ connectionMode: 'launched' | 'headed' = 'launched';
  /** @internal */ intentionalDisconnect = false;
  // ─── Headed-Chromium tracking (orphan kill on shutdown) ───
  // ┌────────────────────────────────────────────────────────┐
  // │ When handoff() spawns a headed Chromium, the user-data │
  // │ dir is uniquely named (nightcrawl-handoff-XXXXXX) so   │
  // │ we can pkill -f against it as a belt-and-suspenders    │
  // │ cleanup if context.close() hangs or shutdown is        │
  // │ abrupt. Without this the headed window outlives the    │
  // │ daemon (P1 bug, HANDOFF.md).                            │
  // └────────────────────────────────────────────────────────┘
  /** @internal */ headedUserDataDir: string | null = null;

  getConnectionMode(): 'launched' | 'headed' { return this.connectionMode; }

  // ─── Watch Mode Methods ─────────────────────────────────
  isWatching(): boolean { return this.watching; }

  startWatch(): void {
    this.watching = true;
    this.watchSnapshots = [];
    this.watchStartTime = Date.now();
  }

  stopWatch(): { snapshots: string[]; duration: number } {
    this.watching = false;
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
    const snapshots = this.watchSnapshots;
    const duration = Date.now() - this.watchStartTime;
    this.watchSnapshots = [];
    this.watchStartTime = 0;
    return { snapshots, duration };
  }

  addWatchSnapshot(snapshot: string): void {
    this.watchSnapshots.push(snapshot);
  }

  /**
   * Find the nightCrawl Chrome extension directory.
   * Checks: repo root /extension, global install, dev install.
   */
  findExtensionPath(): string | null {
    const fs = require('fs');
    const path = require('path');
    const home = process.env.HOME || '';
    const candidates = [
      path.resolve(__dirname, '..', '..', 'extensions', 'bypass-paywalls-chrome'),
      path.resolve(__dirname, '..', '..', 'extension'),
      path.join(home, '.claude', 'skills', 'nightcrawl', 'extension'),
      path.join(home, '.codex', 'skills', 'nightcrawl', 'extension'),
      path.join(home, 'Downloads', 'bypass-paywalls-chrome-clean-master'),
      (() => {
        const stateFile = process.env.BROWSE_STATE_FILE || '';
        if (stateFile) {
          const repoRoot = path.resolve(path.dirname(stateFile), '..');
          return path.join(repoRoot, '.claude', 'skills', 'nightcrawl', 'extension');
        }
        return '';
      })(),
    ].filter(Boolean);

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(path.join(candidate, 'manifest.json'))) {
          return candidate;
        }
      } catch {}
    }
    return null;
  }

  /**
   * Get the ref map for external consumers (e.g., /refs endpoint).
   */
  getRefMap(): Array<{ ref: string; role: string; name: string }> {
    const refs: Array<{ ref: string; role: string; name: string }> = [];
    const map = this.tabs.active()?.refMap;
    if (map) for (const [ref, entry] of map) refs.push({ ref, role: entry.role, name: entry.name });
    return refs;
  }

  async launch() {
    const engineConfig = parseEngineConfig(process.env);

    const extensionMode = process.env.BROWSE_EXTENSIONS || 'all';
    const extensionsDir = extensionMode !== 'none'
      ? (process.env.BROWSE_EXTENSIONS_DIR || this.findExtensionPath() || undefined)
      : undefined;
    if (extensionsDir) {
      console.log(`[nightcrawl] Extensions: ${extensionsDir}`);
    } else if (extensionMode !== 'none') {
      console.log('[nightcrawl] Extensions: enabled, but no extension directory found');
    }
    const ua = this.customUserAgent || DEFAULT_USER_AGENT;

    // Resolve locale once at launch: BROWSE_LOCALE env var takes precedence,
    // otherwise read macOS AppleLanguages so the browser matches the user's
    // real system preference. Sites that region-gate on navigator.language
    // (doubao.com, many CN/regional properties) then see the user's real
    // locale without any manual env-var wrangling.
    const resolvedLocale = resolveLocale();
    if (resolvedLocale) {
      console.log(
        `[nightcrawl] Locale: ${resolvedLocale}` +
        (process.env.BROWSE_LOCALE ? ' (BROWSE_LOCALE)' : ' (macOS system)'),
      );
    }

    // Tier-1 fingerprint anchor: if we've captured the user's real device
    // signals, align the headless twin's UA/screen/timezone/locale to them so
    // cookies/anti-bot checks keyed on those soft signals don't re-challenge.
    // The persistent seed is KEPT (continuity); a missing anchor is a no-op.
    let launchOpts: CloakBrowserLaunchOptions = applyAnchor({
      fingerprintSeed: engineConfig.fingerprintSeed,
      extensionsDir,
      userDataDir: engineConfig.profileDir,
      headless: true,
      humanize: engineConfig.humanize,
      humanPreset: engineConfig.humanize ? 'default' : undefined,
      locale: resolvedLocale ?? undefined,
    }, loadDeviceAnchor());
    if (!launchOpts.viewport) launchOpts.viewport = { width: 1920, height: 1080 };
    const result = await launchCloakBrowser(launchOpts);
    this.browser = result.browser;
    this.context = result.context;
    console.log(`[nightcrawl] Engine: CloakBrowser (seed: ${engineConfig.fingerprintSeed ?? 'random'})`);

    // Locale override (BROWSE_LOCALE env) — patches navigator.language,
    // navigator.languages, and Accept-Language header. Applied to both
    // engines after context creation so sites that region-gate on client
    // locale (e.g. doubao.com's region-ban redirect) can be unlocked by
    // telling the site the user's real locale instead of engine default.
    // Chromium crash -> exit with clear message
    this.browser!.on('disconnected', () => {
      if (noExitOnUnexpectedDisconnect()) {
        console.error('[nightcrawl] Browser disconnected; process exit suppressed by NIGHTCRAWL_NO_EXIT_ON_DISCONNECT.');
      } else {
        console.error('[nightcrawl] FATAL: Chromium process crashed or was killed. Server exiting.');
        console.error('[nightcrawl] Console/network logs flushed to .nightcrawl/browse-*.log');
      }
      exitOnUnexpectedDisconnect(1);
    });

    // Stealth: sync UA at HTTP header level
    await this.context!.setExtraHTTPHeaders({
      ...this.extraHeaders,
      'User-Agent': ua,
    });

    // Apply the same locale at the Playwright-side layers (Accept-Language
    // header + per-page navigator override belt-and-suspenders). The
    // --lang flag is already set at CloakBrowser process launch above;
    // this handles the stock Playwright engine path and any frames
    // CloakBrowser's C++ patches haven't reached yet.
    if (resolvedLocale) {
      await applyLocale(this.context!, resolvedLocale, {
        ...this.extraHeaders,
        'User-Agent': ua,
      });
    }

    // Create first tab
    await this.newTab();
  }

  async close() {
    // Checkpoint discipline: snapshot live cookies + nudge the SQLite WAL flush
    // BEFORE tearing the context down, so no graceful-close path can silently
    // drop state. Idempotent and guarded — safe even if the context is already
    // half-dead (checkpointSession races a timeout, both calls swallow errors).
    if (this.context && process.env.BROWSE_INCOGNITO !== '1') {
      try {
        await checkpointSession(this.context);
        await flushNativeProfile(this.context);
      } catch {}
    }
    if (this.browser || (this.connectionMode === 'headed' && this.context)) {
      if (this.connectionMode === 'headed') {
        this.intentionalDisconnect = true;
        if (this.browser) this.browser.removeAllListeners('disconnected');
        await Promise.race([
          this.context ? this.context.close() : Promise.resolve(),
          new Promise(resolve => setTimeout(resolve, 5000)),
        ]).catch(() => {});
      } else {
        this.browser!.removeAllListeners('disconnected');
        await Promise.race([
          this.browser!.close(),
          new Promise(resolve => setTimeout(resolve, 5000)),
        ]).catch(() => {});
      }
      this.browser = null;
    }
    // Belt-and-suspenders: kill any orphan Chromium spawned by handoff().
    // context.close() can hang (open dialogs, slow shutdown) and the 5s
    // timeout above leaves a live window. The handoff userDataDir is unique
    // per spawn, so pkill -f against it is safe — only matches OUR process.
    killHeadedOrphans(this.headedUserDataDir);
    this.headedUserDataDir = null;
  }

  /** Health check -- verifies Chromium is connected AND responsive */
  async isHealthy(): Promise<boolean> {
    if (!this.browser || !this.browser.isConnected()) return false;
    try {
      const page = this.tabs.active()?.page;
      if (!page) return true;
      await Promise.race([
        page.evaluate('1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Tab Management (per session) ──────────────────────────
  async newTab(url?: string, sessionId: string = DEFAULT_SESSION_ID): Promise<number> {
    if (!this.context) throw new Error('Browser not launched');
    if (url) {
      await validateNavigationUrl(url);
      assertSafeNavigation(url, process.env);
    }

    const page = await this.context.newPage();
    const id = this.tabs.add(page, sessionId);
    this.wirePageEvents(page, id);

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    return id;
  }

  /**
   * Lazy-create the session's first tab (called by handleCommand before `goto`),
   * so a new session navigates its OWN tab instead of hijacking an existing one.
   * No-op when the session already owns an active tab.
   */
  async ensureActiveTab(sessionId: string = DEFAULT_SESSION_ID): Promise<void> {
    if (this.tabs.activeIdFor(sessionId) === 0) await this.newTab(undefined, sessionId);
  }

  async closeTab(
    id?: number,
    opts: { sessionId?: string; admin?: boolean } = {},
  ): Promise<void> {
    const sessionId = opts.sessionId ?? DEFAULT_SESSION_ID;
    const tabId = id ?? this.tabs.activeIdFor(sessionId);
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} not found`);
    // Isolation: only the owner closes its own tab. Admin scope crosses sessions.
    if (tab.owner !== sessionId && !opts.admin) {
      throw new Error(`Tab ${tabId} is owned by another session`);
    }

    await tab.page.close();
    this.tabs.drop(tabId); // no jump-to-last-tab: the owner re-gotos to get a tab

    // Daemon invariant: never leave the browser with zero tabs.
    if (this.tabs.size() === 0) await this.newTab();
  }

  switchTab(id: number, sessionId: string = DEFAULT_SESSION_ID): void {
    // Own-only: throws `Tab ${id} not found` OR `... owned by another session`.
    this.tabs.setActiveFor(sessionId, id);
    const t = this.tabs.get(id);
    if (t) t.activeFrame = null;
  }

  /** Total tabs across all sessions — daemon introspection (status/health). */
  getTabCount(): number {
    return this.tabs.size();
  }

  /** Tabs owned by `sessionId`. */
  async getTabListWithTitles(sessionId: string = DEFAULT_SESSION_ID): Promise<TabInfo[]> {
    return this.buildTabList(this.tabs.idsFor(sessionId), sessionId);
  }

  /** Admin: every tab across all sessions (used by `tabs --all`). */
  async getAllTabsWithTitles(): Promise<TabInfo[]> {
    return this.buildTabList(this.tabs.ids(), null);
  }

  private async buildTabList(ids: number[], sessionId: string | null): Promise<TabInfo[]> {
    const out: TabInfo[] = [];
    for (const id of ids) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      out.push({
        id,
        url: tab.page.url(),
        title: await tab.page.title().catch(() => ''),
        // "active" = the active tab of the relevant session (its owner for --all).
        active: id === this.tabs.activeIdFor(sessionId ?? tab.owner),
        owner: tab.owner,
      });
    }
    return out;
  }

  // ─── Per-session views ─────────────────────────────────────
  /**
   * The per-session command facade. Cached so a session's view is a stable
   * instance across commands. The view injects its sessionId into this manager's
   * per-tab methods, so each session resolves its OWN active tab and never
   * touches another session's.
   */
  forSession(sessionId: string): SessionView {
    let view = this.sessionViews.get(sessionId);
    if (!view) {
      view = new SessionView(this, sessionId);
      this.sessionViews.set(sessionId, view);
    }
    return view;
  }

  // ─── Per-tab command lock ───────────────────────────────────
  /**
   * Serialize `fn` on a single tab via a promise chain stored in TabState.lock.
   * Same tab → ops run one after another; different tabs → fully concurrent. A
   * missing tab (no id) bypasses the lock so server-control commands never block.
   */
  private lockTab<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const tab = this.tabs.get(tabId);
    if (!tab) return fn();
    const result = tab.lock.then(() => fn());
    // Advance the chain; swallow result+error so one failure can't poison the lock.
    tab.lock = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Run `fn` serialized on the SESSION's active tab (keyed by tab, not session). */
  runOnTab<T>(fn: () => Promise<T>, sessionId: string = DEFAULT_SESSION_ID): Promise<T> {
    return this.lockTab(this.tabs.activeIdFor(sessionId), fn);
  }

  // ─── Page Access (per session) ─────────────────────────────
  getPage(sessionId: string = DEFAULT_SESSION_ID): Page {
    return this.tabs.activePageFor(sessionId);
  }

  getCurrentUrl(sessionId: string = DEFAULT_SESSION_ID): string {
    try {
      return this.getPage(sessionId).url();
    } catch {
      return 'about:blank';
    }
  }

  // ─── Ref Map (per session's active tab) ───────────────────
  setRefMap(refs: Map<string, RefEntry>, sessionId: string = DEFAULT_SESSION_ID) {
    const t = this.tabs.activeFor(sessionId);
    if (t) t.refMap = refs;
  }

  clearRefs(sessionId: string = DEFAULT_SESSION_ID) {
    this.tabs.activeFor(sessionId)?.refMap.clear();
  }

  async resolveRef(selector: string, sessionId: string = DEFAULT_SESSION_ID): Promise<{ locator: Locator } | { selector: string }> {
    if (selector.startsWith('@e') || selector.startsWith('@c')) {
      const ref = selector.slice(1);
      const entry = this.tabs.activeFor(sessionId)?.refMap.get(ref);
      if (!entry) {
        throw new Error(`Ref ${selector} not found. Run 'snapshot' to get fresh refs.`);
      }
      const count = await entry.locator.count();
      if (count === 0) {
        throw new Error(
          `Ref ${selector} (${entry.role} "${entry.name}") is stale — element no longer exists. ` +
          `Run 'snapshot' for fresh refs.`
        );
      }
      return { locator: entry.locator };
    }
    return { selector };
  }

  getRefRole(selector: string, sessionId: string = DEFAULT_SESSION_ID): string | null {
    if (selector.startsWith('@e') || selector.startsWith('@c')) {
      const entry = this.tabs.activeFor(sessionId)?.refMap.get(selector.slice(1));
      return entry?.role ?? null;
    }
    return null;
  }

  getRefCount(sessionId: string = DEFAULT_SESSION_ID): number {
    return this.tabs.activeFor(sessionId)?.refMap.size ?? 0;
  }

  // ─── Snapshot Diffing (per session's active tab) ──────────
  setLastSnapshot(text: string | null, sessionId: string = DEFAULT_SESSION_ID) { const t = this.tabs.activeFor(sessionId); if (t) t.lastSnapshot = text; }
  getLastSnapshot(sessionId: string = DEFAULT_SESSION_ID): string | null { return this.tabs.activeFor(sessionId)?.lastSnapshot ?? null; }

  // ─── Dialog Control ───────────────────────────────────────
  setDialogAutoAccept(accept: boolean) { this.dialogAutoAccept = accept; }
  getDialogAutoAccept(): boolean { return this.dialogAutoAccept; }
  setDialogPromptText(text: string | null) { this.dialogPromptText = text; }
  getDialogPromptText(): string | null { return this.dialogPromptText; }

  // ─── Viewport ──────────────────────────────────────────────
  async setViewport(width: number, height: number, sessionId: string = DEFAULT_SESSION_ID) {
    await this.getPage(sessionId).setViewportSize({ width, height });
  }

  // ─── Extra Headers ─────────────────────────────────────────
  async setExtraHeader(name: string, value: string) {
    this.extraHeaders[name] = value;
    if (this.context) {
      await this.context.setExtraHTTPHeaders(this.extraHeaders);
    }
  }

  // ─── User Agent ────────────────────────────────────────────
  setUserAgent(ua: string) {
    this.customUserAgent = ua;
    if (this.context) {
      this.context.setExtraHTTPHeaders({
        ...this.extraHeaders,
        'User-Agent': ua,
      }).catch(() => {});
    }
  }

  getUserAgent(): string | null {
    return this.customUserAgent;
  }

  // ─── Lifecycle helpers ───────────────────────────────
  async closeAllPages(): Promise<void> {
    for (const [, tab] of this.tabs.entries()) {
      await tab.page.close().catch(() => {});
    }
    this.tabs.clear();
  }

  // ─── Frame context (per session's active tab) ──────
  setFrame(frame: import('playwright').Frame | null, sessionId: string = DEFAULT_SESSION_ID): void {
    const t = this.tabs.activeFor(sessionId);
    if (t) t.activeFrame = frame;
  }

  getFrame(sessionId: string = DEFAULT_SESSION_ID): import('playwright').Frame | null {
    return this.tabs.activeFor(sessionId)?.activeFrame ?? null;
  }

  getActiveFrameOrPage(sessionId: string = DEFAULT_SESSION_ID): import('playwright').Page | import('playwright').Frame {
    const t = this.tabs.activeFor(sessionId);
    if (t?.activeFrame?.isDetached()) t.activeFrame = null;
    return t?.activeFrame ?? this.getPage(sessionId);
  }

  // ─── State Save/Restore ───────────────────────────────────
  async saveState(): Promise<BrowserState> {
    if (!this.context) throw new Error('Browser not launched');

    const cookies = await this.context.cookies();
    const pages: BrowserState['pages'] = [];

    for (const [id, tab] of this.tabs.entries()) {
      const page = tab.page;
      const url = page.url();
      let storage = null;
      try {
        storage = await page.evaluate(() => ({
          localStorage: { ...localStorage },
          sessionStorage: { ...sessionStorage },
        }));
      } catch {}
      pages.push({
        url: url === 'about:blank' ? '' : url,
        isActive: id === this.tabs.activeId,
        storage,
      });
    }

    return { cookies, pages };
  }

  async restoreCookies(cookies: Cookie[]): Promise<void> {
    if (!this.context) throw new Error('Browser not launched');
    // SAFETY: unconditionally drop cookies for hostile platforms.
    // See hostile-domains.ts and project_xhs_account_ban_2026_04_09 memory.
    const safeCookies = filterHostileCookies(cookies);
    if (safeCookies.length > 0) {
      // Atomic swap chokepoint (safe no-op on fresh contexts; load-bearing
      // when restoring after handoff where transient cookies may exist).
      await replaceCookiesFor(this.context, safeCookies);
    }
  }

  async restoreState(
    state: BrowserState,
    opts: { restoreCookies?: boolean; cookieMode?: 'replace' | 'add' } = {},
  ): Promise<void> {
    if (!this.context) throw new Error('Browser not launched');

    // SAFETY: filter hostile cookies before any restore (see hostile-domains.ts).
    if (opts.restoreCookies !== false) {
      const safeCookies = filterHostileCookies(state.cookies);
      if (safeCookies.length > 0) {
        if (opts.cookieMode === 'add') {
          await this.context.addCookies(safeCookies);
        } else {
          await replaceCookiesFor(this.context, safeCookies);
        }
      }
    }

    let activeId: number | null = null;
    for (const saved of state.pages) {
      const page = await this.context.newPage();
      const id = this.tabs.add(page);
      this.wirePageEvents(page, id);

      if (saved.url) {
        // SAFETY: refuse to re-navigate to hostile domains during state restore.
        // If the saved page is hostile and we're not in incognito, skip it.
        try {
          assertSafeNavigation(saved.url, process.env);
        } catch {
          continue;
        }
        await page.goto(saved.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }

      if (saved.storage) {
        try {
          await page.evaluate((s: { localStorage: Record<string, string>; sessionStorage: Record<string, string> }) => {
            if (s.localStorage) {
              for (const [k, v] of Object.entries(s.localStorage)) localStorage.setItem(k, v);
            }
            if (s.sessionStorage) {
              for (const [k, v] of Object.entries(s.sessionStorage)) sessionStorage.setItem(k, v);
            }
          }, saved.storage);
        } catch {}
      }

      if (saved.isActive) activeId = id;
    }

    if (this.tabs.size() === 0) {
      await this.newTab();
    } else {
      this.tabs.setActive(activeId ?? this.tabs.ids()[0]);
    }
  }

  async recreateContext(): Promise<string | null> {
    if (this.connectionMode === 'headed') {
      throw new Error('Cannot recreate context in headed mode. Use disconnect first.');
    }
    if (!this.browser || !this.context) {
      throw new Error('Browser not launched');
    }

    try {
      const state = await this.saveState();

      for (const [, tab] of this.tabs.entries()) {
        await tab.page.close().catch(() => {});
      }
      this.tabs.clear();
      await this.context.close().catch(() => {});

      const ua = this.customUserAgent || DEFAULT_USER_AGENT;
      const contextOptions: BrowserContextOptions = {
        viewport: { width: 1280, height: 720 },
        userAgent: ua,
      };
      this.context = await this.browser.newContext(contextOptions);

      await this.context.setExtraHTTPHeaders({
        ...this.extraHeaders,
        'User-Agent': ua,
      });

      await this.restoreState(state);
      return null;
    } catch (err: unknown) {
      try {
        this.tabs.clear();
        if (this.context) await this.context.close().catch(() => {});

        const fallbackUa = this.customUserAgent || DEFAULT_USER_AGENT;
        const contextOptions: BrowserContextOptions = {
          viewport: { width: 1280, height: 720 },
          userAgent: fallbackUa,
        };
        this.context = await this.browser!.newContext(contextOptions);
        await this.context.setExtraHTTPHeaders({
          ...this.extraHeaders,
          'User-Agent': fallbackUa,
        });
        await this.newTab();
      } catch {}
      return `Context recreation failed: ${err instanceof Error ? err.message : String(err)}. Browser reset to blank tab.`;
    }
  }

  // ─── Console/Network/Dialog/Ref Wiring ────────────────────
  wirePageEvents(page: Page, tabId: number) {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        // Per-tab: navigating THIS tab clears only ITS refs/frame, never
        // another tab's (or another session's) — that is the isolation core.
        const tab = this.tabs.get(tabId);
        if (tab) { tab.refMap.clear(); tab.activeFrame = null; }
      }
    });

    page.on('dialog', async (dialog) => {
      const entry: DialogEntry = {
        timestamp: Date.now(),
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue() || undefined,
        action: this.dialogAutoAccept ? 'accepted' : 'dismissed',
        response: this.dialogAutoAccept ? (this.dialogPromptText ?? undefined) : undefined,
      };
      addDialogEntry(entry);

      try {
        if (this.dialogAutoAccept) {
          await dialog.accept(this.dialogPromptText ?? undefined);
        } else {
          await dialog.dismiss();
        }
      } catch {}
    });

    page.on('console', (msg) => {
      addConsoleEntry({
        timestamp: Date.now(),
        level: msg.type(),
        text: msg.text(),
      });
    });

    page.on('request', (req) => {
      addNetworkEntry({
        timestamp: Date.now(),
        method: req.method(),
        url: req.url(),
      });
    });

    page.on('response', (res) => {
      const url = res.url();
      const status = res.status();
      for (let i = networkBuffer.length - 1; i >= 0; i--) {
        const entry = networkBuffer.get(i);
        if (entry && entry.url === url && !entry.status) {
          networkBuffer.set(i, { ...entry, status, duration: Date.now() - entry.timestamp });
          break;
        }
      }
      // Vendor-sniff for fingerprint-pinned hosts (Cloudflare/Akamai/etc).
      // Only look at top-level document + navigation responses — subresources
      // from a CDN don't tell us the origin is pinned.
      try {
        const rtype = (res.request().resourceType?.() ?? '');
        if (rtype === 'document') {
          markPinnedFromHeaders(url, res.headers());
        }
      } catch {}
    });

    page.on('requestfinished', async (req) => {
      try {
        const res = await req.response();
        if (res) {
          const url = req.url();
          const body = await res.body().catch(() => null);
          const size = body ? body.length : 0;
          for (let i = networkBuffer.length - 1; i >= 0; i--) {
            const entry = networkBuffer.get(i);
            if (entry && entry.url === url && !entry.size) {
              networkBuffer.set(i, { ...entry, size });
              break;
            }
          }
        }
      } catch {}
    });
  }

  // ─── Handoff methods (implemented in browser-handoff.ts) ──
  // Assigned to prototype below to keep this file under 800 lines.
  // `declare` emits no runtime code, so these don't shadow the prototype.
  declare launchHeaded: (authToken?: string) => Promise<void>;
  declare handoff: (message: string) => Promise<string>;
  declare resume: () => Promise<string>;
  declare autoHandover: () => Promise<string | null>;
  declare detectLoginWall: () => Promise<{ detected: boolean; reason: string; domain: string; approved: boolean } | null>;
  declare getIsHeaded: () => boolean;
  declare incrementFailures: () => void;
  declare resetFailures: () => void;
  declare getFailureHint: () => string | null;
}

// ─── Headed-Chromium orphan killer ──────────────────────────
// Used by close() AND by the server's emergencyCleanup() so that
// crash paths (uncaughtException, OOM, SIGKILL) don't leave a
// headed Chromium window on the user's screen. pkill -f targets
// the unique userDataDir path that only our handoff spawns use.
export function killHeadedOrphans(userDataDir: string | null): void {
  try {
    const { spawnSync } = require('child_process');
    // Always sweep the prefix — covers any leftover from prior runs too.
    spawnSync('pkill', ['-f', 'nightcrawl-handoff-'], { timeout: 2000 });
    if (userDataDir) {
      spawnSync('pkill', ['-f', userDataDir], { timeout: 2000 });
    }
  } catch {
    // Non-fatal — best-effort cleanup
  }
}

// ─── Wire handoff methods onto prototype ────────────────────
// Imported as plain functions, no circular dependency.
import * as handoffImpl from './browser-handoff';
handoffImpl._setupHandoff(getChromium);

BrowserManager.prototype.launchHeaded = handoffImpl.launchHeaded;
BrowserManager.prototype.handoff = handoffImpl.handoff;
BrowserManager.prototype.resume = handoffImpl.resume;
BrowserManager.prototype.autoHandover = handoffImpl.autoHandover;
BrowserManager.prototype.detectLoginWall = handoffImpl.detectLoginWall;
BrowserManager.prototype.getIsHeaded = handoffImpl.getIsHeaded;
BrowserManager.prototype.incrementFailures = handoffImpl.incrementFailures;
BrowserManager.prototype.resetFailures = handoffImpl.resetFailures;
BrowserManager.prototype.getFailureHint = handoffImpl.getFailureHint;
