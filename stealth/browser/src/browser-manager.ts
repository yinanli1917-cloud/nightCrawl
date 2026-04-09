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
import { parseEngineConfig } from './engine-config';
import { launchCloakBrowser, shouldSkipCdpPatches } from './cloakbrowser-engine';
import { DEFAULT_USER_AGENT, findChromiumExecutable, applyStealthPatches } from './stealth';

export { DEFAULT_USER_AGENT } from './stealth';
export { isPatchCurrent } from './stealth';
export { generateLaunchAgentPlist } from './launch-agent';

export interface RefEntry {
  locator: Locator;
  role: string;
  name: string;
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
export class BrowserManager {
  /** @internal */ browser: Browser | null = null;
  /** @internal */ context: BrowserContext | null = null;
  /** @internal */ pages: Map<number, Page> = new Map();
  /** @internal */ activeTabId: number = 0;
  /** @internal */ nextTabId: number = 1;
  /** @internal */ extraHeaders: Record<string, string> = {};
  /** @internal */ customUserAgent: string | null = null;

  /** Server port -- set after server starts, used by cookie-import-browser command */
  public serverPort: number = 0;

  /** @internal */ refMap: Map<string, RefEntry> = new Map();
  /** @internal -- NOT cleared on navigation, it's a text baseline for diffing */
  lastSnapshot: string | null = null;

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
    const candidates = [
      path.resolve(__dirname, '..', '..', 'extension'),
      path.join(process.env.HOME || '', '.claude', 'skills', 'nightcrawl', 'extension'),
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
    for (const [ref, entry] of this.refMap) {
      refs.push({ ref, role: entry.role, name: entry.name });
    }
    return refs;
  }

  async launch() {
    const engineConfig = parseEngineConfig(process.env);

    // CDP stealth patches -- skip when CloakBrowser handles it internally
    if (!shouldSkipCdpPatches(engineConfig.engine)) {
      await applyStealthPatches();
      process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding';
    }

    const extensionMode = process.env.BROWSE_EXTENSIONS || 'all';
    const extensionsDir = extensionMode !== 'none' ? process.env.BROWSE_EXTENSIONS_DIR : undefined;
    const ua = this.customUserAgent || DEFAULT_USER_AGENT;

    // ─── CloakBrowser Engine ─────────────────────────────────
    if (engineConfig.engine === 'cloakbrowser') {
      const result = await launchCloakBrowser({
        fingerprintSeed: engineConfig.fingerprintSeed,
        extensionsDir,
        headless: true,
        humanize: engineConfig.humanize,
        humanPreset: engineConfig.humanize ? 'default' : undefined,
        viewport: { width: 1920, height: 1080 },
      });
      this.browser = result.browser;
      this.context = result.context;
      console.log(`[nightcrawl] Engine: CloakBrowser (seed: ${engineConfig.fingerprintSeed ?? 'random'})`);
    } else {
      // ─── Stock Playwright Engine ─────────────────────────────
      const launchArgs: string[] = [
        '--disable-blink-features=AutomationControlled',
      ];

      if (process.env.CI || process.env.CONTAINER) {
        launchArgs.push('--no-sandbox');
      }

      const contextOptions: BrowserContextOptions = {
        viewport: { width: 1920, height: 1080 },
        userAgent: ua,
      };

      if (extensionsDir) {
        launchArgs.push(
          `--disable-extensions-except=${extensionsDir}`,
          `--load-extension=${extensionsDir}`,
          '--headless=new',
        );
        const ignoreArgs = [
          '--disable-extensions',
          '--enable-automation',
          '--disable-component-extensions-with-background-pages',
        ];

        const userDataDir = await import('fs').then(fs =>
          fs.promises.mkdtemp(require('path').join(require('os').tmpdir(), 'browse-ext-'))
        );

        const chromiumPath = findChromiumExecutable();
        this.context = await (await getChromium()).launchPersistentContext(userDataDir, {
          headless: false,
          ...(chromiumPath ? { executablePath: chromiumPath } : {}),
          chromiumSandbox: process.platform !== 'win32',
          args: launchArgs,
          ignoreDefaultArgs: ignoreArgs,
          ...contextOptions,
        });
        this.browser = this.context.browser()!;
        console.log(`[nightcrawl] Extensions loaded from: ${extensionsDir}`);
      } else {
        this.browser = await (await getChromium()).launch({
          headless: true,
          chromiumSandbox: process.platform !== 'win32',
          args: launchArgs,
        });
        this.context = await this.browser.newContext(contextOptions);
      }
    }

    // Chromium crash -> exit with clear message
    this.browser!.on('disconnected', () => {
      console.error('[nightcrawl] FATAL: Chromium process crashed or was killed. Server exiting.');
      console.error('[nightcrawl] Console/network logs flushed to .nightcrawl/browse-*.log');
      process.exit(1);
    });

    // Stealth: sync UA at HTTP header level
    await this.context!.setExtraHTTPHeaders({
      ...this.extraHeaders,
      'User-Agent': ua,
    });

    // Create first tab
    await this.newTab();
  }

  async close() {
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
  }

  /** Health check -- verifies Chromium is connected AND responsive */
  async isHealthy(): Promise<boolean> {
    if (!this.browser || !this.browser.isConnected()) return false;
    try {
      const page = this.pages.get(this.activeTabId);
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

  // ─── Tab Management ────────────────────────────────────────
  async newTab(url?: string): Promise<number> {
    if (!this.context) throw new Error('Browser not launched');
    if (url) await validateNavigationUrl(url);

    const page = await this.context.newPage();
    const id = this.nextTabId++;
    this.pages.set(id, page);
    this.activeTabId = id;
    this.wirePageEvents(page);

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    return id;
  }

  async closeTab(id?: number): Promise<void> {
    const tabId = id ?? this.activeTabId;
    const page = this.pages.get(tabId);
    if (!page) throw new Error(`Tab ${tabId} not found`);

    await page.close();
    this.pages.delete(tabId);

    if (tabId === this.activeTabId) {
      const remaining = [...this.pages.keys()];
      if (remaining.length > 0) {
        this.activeTabId = remaining[remaining.length - 1];
      } else {
        await this.newTab();
      }
    }
  }

  switchTab(id: number): void {
    if (!this.pages.has(id)) throw new Error(`Tab ${id} not found`);
    this.activeTabId = id;
    this.activeFrame = null;
  }

  getTabCount(): number {
    return this.pages.size;
  }

  async getTabListWithTitles(): Promise<Array<{ id: number; url: string; title: string; active: boolean }>> {
    const tabs: Array<{ id: number; url: string; title: string; active: boolean }> = [];
    for (const [id, page] of this.pages) {
      tabs.push({
        id,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: id === this.activeTabId,
      });
    }
    return tabs;
  }

  // ─── Page Access ───────────────────────────────────────────
  getPage(): Page {
    const page = this.pages.get(this.activeTabId);
    if (!page) throw new Error('No active page. Use "browse goto <url>" first.');
    return page;
  }

  getCurrentUrl(): string {
    try {
      return this.getPage().url();
    } catch {
      return 'about:blank';
    }
  }

  // ─── Ref Map ──────────────────────────────────────────────
  setRefMap(refs: Map<string, RefEntry>) {
    this.refMap = refs;
  }

  clearRefs() {
    this.refMap.clear();
  }

  async resolveRef(selector: string): Promise<{ locator: Locator } | { selector: string }> {
    if (selector.startsWith('@e') || selector.startsWith('@c')) {
      const ref = selector.slice(1);
      const entry = this.refMap.get(ref);
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

  getRefRole(selector: string): string | null {
    if (selector.startsWith('@e') || selector.startsWith('@c')) {
      const entry = this.refMap.get(selector.slice(1));
      return entry?.role ?? null;
    }
    return null;
  }

  getRefCount(): number {
    return this.refMap.size;
  }

  // ─── Snapshot Diffing ─────────────────────────────────────
  setLastSnapshot(text: string | null) { this.lastSnapshot = text; }
  getLastSnapshot(): string | null { return this.lastSnapshot; }

  // ─── Dialog Control ───────────────────────────────────────
  setDialogAutoAccept(accept: boolean) { this.dialogAutoAccept = accept; }
  getDialogAutoAccept(): boolean { return this.dialogAutoAccept; }
  setDialogPromptText(text: string | null) { this.dialogPromptText = text; }
  getDialogPromptText(): string | null { return this.dialogPromptText; }

  // ─── Viewport ──────────────────────────────────────────────
  async setViewport(width: number, height: number) {
    await this.getPage().setViewportSize({ width, height });
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
    for (const page of this.pages.values()) {
      await page.close().catch(() => {});
    }
    this.pages.clear();
    this.clearRefs();
  }

  // ─── Frame context ─────────────────────────────────
  /** @internal */ activeFrame: import('playwright').Frame | null = null;

  setFrame(frame: import('playwright').Frame | null): void {
    this.activeFrame = frame;
  }

  getFrame(): import('playwright').Frame | null {
    return this.activeFrame;
  }

  getActiveFrameOrPage(): import('playwright').Page | import('playwright').Frame {
    if (this.activeFrame?.isDetached()) {
      this.activeFrame = null;
    }
    return this.activeFrame ?? this.getPage();
  }

  // ─── State Save/Restore ───────────────────────────────────
  async saveState(): Promise<BrowserState> {
    if (!this.context) throw new Error('Browser not launched');

    const cookies = await this.context.cookies();
    const pages: BrowserState['pages'] = [];

    for (const [id, page] of this.pages) {
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
        isActive: id === this.activeTabId,
        storage,
      });
    }

    return { cookies, pages };
  }

  async restoreCookies(cookies: Cookie[]): Promise<void> {
    if (!this.context) throw new Error('Browser not launched');
    if (cookies.length > 0) {
      await this.context.addCookies(cookies);
    }
  }

  async restoreState(state: BrowserState): Promise<void> {
    if (!this.context) throw new Error('Browser not launched');

    if (state.cookies.length > 0) {
      await this.context.addCookies(state.cookies);
    }

    let activeId: number | null = null;
    for (const saved of state.pages) {
      const page = await this.context.newPage();
      const id = this.nextTabId++;
      this.pages.set(id, page);
      this.wirePageEvents(page);

      if (saved.url) {
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

    if (this.pages.size === 0) {
      await this.newTab();
    } else {
      this.activeTabId = activeId ?? [...this.pages.keys()][0];
    }

    this.clearRefs();
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

      for (const page of this.pages.values()) {
        await page.close().catch(() => {});
      }
      this.pages.clear();
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
        this.pages.clear();
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
        this.clearRefs();
      } catch {}
      return `Context recreation failed: ${err instanceof Error ? err.message : String(err)}. Browser reset to blank tab.`;
    }
  }

  // ─── Console/Network/Dialog/Ref Wiring ────────────────────
  wirePageEvents(page: Page) {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.clearRefs();
        this.activeFrame = null;
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
  declare detectLoginWall: () => Promise<{ detected: boolean; reason: string } | null>;
  declare getIsHeaded: () => boolean;
  declare incrementFailures: () => void;
  declare resetFailures: () => void;
  declare getFailureHint: () => string | null;
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
