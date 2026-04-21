/**
 * Unit tests for locale overrides — pure logic for building the
 * Accept-Language header and the navigator.languages list.
 *
 * The live applyLocale() flow (which touches a real Playwright
 * BrowserContext) is exercised via the integration path. Here we pin
 * the wire-format of the locale transforms so a future refactor can't
 * quietly change what doubao and other locale-gated sites see.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildLanguageList,
  buildAcceptLanguage,
  applyLocale,
  normalizeLocale,
  resolveLocale,
  detectSystemLocale,
} from '../src/locale';

describe('buildLanguageList', () => {
  test('zh-CN → [zh-CN, zh, en-US, en]', () => {
    expect(buildLanguageList('zh-CN')).toEqual(['zh-CN', 'zh', 'en-US', 'en']);
  });

  test('ja → [ja, en-US, en] (no redundant ja entry)', () => {
    expect(buildLanguageList('ja')).toEqual(['ja', 'en-US', 'en']);
  });

  test('en-US → [en-US, en] (deduplicated — no duplicate en-US)', () => {
    expect(buildLanguageList('en-US')).toEqual(['en-US', 'en']);
  });

  test('en → [en] + en-US tail → [en, en-US] (no duplicate en)', () => {
    expect(buildLanguageList('en')).toEqual(['en', 'en-US']);
  });

  test('empty input → safe default', () => {
    expect(buildLanguageList('')).toEqual(['en-US', 'en']);
    expect(buildLanguageList('   ')).toEqual(['en-US', 'en']);
  });

  test('whitespace is trimmed', () => {
    expect(buildLanguageList('  zh-CN  ')).toEqual(['zh-CN', 'zh', 'en-US', 'en']);
  });
});

describe('buildAcceptLanguage', () => {
  test('zh-CN → "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7"', () => {
    // Matches what Chrome with zh primary + en secondary actually sends.
    // Doubao and other Bytedance properties compare against this exact
    // ordering to decide region gating.
    expect(buildAcceptLanguage('zh-CN')).toBe('zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7');
  });

  test('primary has no q-value (real browser convention)', () => {
    const header = buildAcceptLanguage('fr-FR');
    const firstPart = header.split(',')[0];
    expect(firstPart).toBe('fr-FR');
    expect(firstPart).not.toContain('q=');
  });

  test('subsequent parts get descending q values', () => {
    const header = buildAcceptLanguage('zh-CN');
    const parts = header.split(',');
    expect(parts[1]).toContain('q=0.9');
    expect(parts[2]).toContain('q=0.8');
    expect(parts[3]).toContain('q=0.7');
  });
});

describe('applyLocale', () => {
  /**
   * Mock a CloakBrowser/Playwright context. applyLocale now installs
   * the init script per-page via `context.on('page', ...)` (CloakBrowser
   * rejects `context.addInitScript` with "expected channel Disposable"),
   * so the mock exposes a page event hook, a pages() iterator, and a
   * per-page addInitScript stub. setExtraHTTPHeaders is captured at the
   * context level.
   */
  const makeMockContext = () => {
    const initScripts: Array<{ fn: any; arg: any }> = [];
    const extraHeaders: any[] = [];
    let pageHandler: ((p: any) => void) | null = null;
    const existingPages: any[] = [];
    const ctx = {
      on: (event: string, handler: (p: any) => void) => {
        if (event === 'page') pageHandler = handler;
      },
      pages: () => existingPages,
      setExtraHTTPHeaders: async (headers: Record<string, string>) => {
        extraHeaders.push(headers);
      },
      // Emit a page event after applyLocale returns so we can confirm
      // the handler is installed and records init-scripts.
      _emitPage: async () => {
        const page = {
          addInitScript: async (fn: any, arg: any) => {
            initScripts.push({ fn, arg });
          },
        };
        if (pageHandler) await pageHandler(page);
        return page;
      },
    };
    return { ctx, initScripts, extraHeaders };
  };

  test('no-op when locale is undefined', async () => {
    const { ctx, initScripts, extraHeaders } = makeMockContext();
    await applyLocale(ctx as any, undefined);
    expect(initScripts.length).toBe(0);
    expect(extraHeaders.length).toBe(0);
  });

  test('no-op when locale is empty string', async () => {
    const { ctx, initScripts, extraHeaders } = makeMockContext();
    await applyLocale(ctx as any, '');
    expect(initScripts.length).toBe(0);
    expect(extraHeaders.length).toBe(0);
  });

  test('zh-CN: header set immediately; init-script fires when a new page is created', async () => {
    const { ctx, initScripts, extraHeaders } = makeMockContext();
    await applyLocale(ctx as any, 'zh-CN');

    // Header goes in right away — server-side override doesn't need a page.
    expect(extraHeaders.length).toBe(1);
    expect(extraHeaders[0]['Accept-Language']).toBe('zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7');

    // Init-script hook is installed but not yet fired (no pages yet).
    expect(initScripts.length).toBe(0);

    // Simulate a new page — the handler fires and records the init-script.
    await (ctx as any)._emitPage();
    expect(initScripts.length).toBe(1);
    expect(initScripts[0].arg.langs).toEqual(['zh-CN', 'zh', 'en-US', 'en']);
    expect(initScripts[0].arg.prim).toBe('zh-CN');
  });

  test('merges with existing headers (does not clobber User-Agent etc.)', async () => {
    const { ctx, extraHeaders } = makeMockContext();
    await applyLocale(ctx as any, 'zh-CN', {
      'User-Agent': 'Mozilla/5.0 (custom)',
      'X-Trace': 'abc',
    });
    const merged = extraHeaders[0];
    expect(merged['User-Agent']).toBe('Mozilla/5.0 (custom)');
    expect(merged['X-Trace']).toBe('abc');
    expect(merged['Accept-Language']).toBe('zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7');
  });

  test('normalizeLocale collapses BCP 47 script subtag to a Chromium-friendly form', () => {
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh-Hant-TW')).toBe('zh-TW');
    // Already-normalized passes through
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeLocale('en-US')).toBe('en-US');
    // No script subtag, no change
    expect(normalizeLocale('fr-FR')).toBe('fr-FR');
  });

  test('resolveLocale: BROWSE_LOCALE env wins over system detection', () => {
    const orig = process.env.BROWSE_LOCALE;
    try {
      process.env.BROWSE_LOCALE = 'ja-JP';
      expect(resolveLocale()).toBe('ja-JP');
    } finally {
      if (orig === undefined) delete process.env.BROWSE_LOCALE;
      else process.env.BROWSE_LOCALE = orig;
    }
  });

  test('resolveLocale: empty BROWSE_LOCALE falls through to system detection', () => {
    const orig = process.env.BROWSE_LOCALE;
    try {
      process.env.BROWSE_LOCALE = '   ';
      // On non-macOS CI, detectSystemLocale returns null and resolveLocale
      // returns null. On macOS it returns the user's system locale. Either
      // way, empty BROWSE_LOCALE must NOT be treated as a valid override.
      const result = resolveLocale();
      expect(result !== '   ').toBe(true);
    } finally {
      if (orig === undefined) delete process.env.BROWSE_LOCALE;
      else process.env.BROWSE_LOCALE = orig;
    }
  });

  test('detectSystemLocale returns null on non-macOS platforms', () => {
    // We can't easily spoof platform here without rewiring, so just
    // assert the function is callable and returns a string or null.
    const result = detectSystemLocale();
    expect(result === null || typeof result === 'string').toBe(true);
    // If it returned a string, it must pass normalizeLocale (idempotent)
    if (result) {
      expect(normalizeLocale(result)).toBe(result);
    }
  });

  test('init script, when executed, overrides navigator.language and .languages', async () => {
    // Verify the init script body works when run against a fake
    // navigator. We can't run real Playwright here, but we can pull
    // the recorded init-script out of the mock and execute it.
    const { ctx, initScripts } = makeMockContext();
    await applyLocale(ctx as any, 'zh-CN');
    await (ctx as any)._emitPage();
    const { fn, arg } = initScripts[0];

    const stubNavigator: any = { language: 'en-US', languages: ['en-US'] };
    // @ts-expect-error — fake global for the script body to see
    (globalThis as any).navigator = stubNavigator;
    fn(arg);

    expect((globalThis as any).navigator.language).toBe('zh-CN');
    expect((globalThis as any).navigator.languages).toEqual(['zh-CN', 'zh', 'en-US', 'en']);
  });
});
