/**
 * [INPUT]: Depends on Playwright BrowserContext type
 * [OUTPUT]: Exports applyLocale, buildLanguageList, buildAcceptLanguage
 * [POS]: Locale customization layer — applied at context creation so
 *        navigator.language / navigator.languages / Accept-Language
 *        match what the user's real browser sends.
 *
 * Why this exists: some sites (notably ByteDance properties like
 * doubao.com) gate features on `navigator.languages` — if `zh` isn't
 * present they redirect to a "region ban" page even when the user's
 * IP, cookies, and fingerprint are all valid. The redirect is purely
 * client-side, so the fix has to happen in-browser before page JS
 * runs. `context.addInitScript` is the only layer that runs early
 * enough to influence the first script.
 *
 * Activation: `BROWSE_LOCALE=zh-CN` env var at daemon start. Absent
 * means keep the engine default (CloakBrowser sets en-US). Present
 * means override every surface so the site sees a consistent locale.
 */

import type { BrowserContext } from 'playwright';

/**
 * Build a descending-q-value Accept-Language header from a locale.
 *
 *   zh-CN → "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7"
 *
 * The English tail is appended so servers that don't serve zh content
 * still have a fallback — that matches what real Chrome sends when the
 * user has zh primary + en secondary in OS preferences.
 */
export function buildAcceptLanguage(locale: string): string {
  const parts = buildLanguageList(locale);
  return parts
    .map((lang, i) => (i === 0 ? lang : `${lang};q=${(1 - i * 0.1).toFixed(1)}`))
    .join(',');
}

/**
 * Build an ordered `navigator.languages` array from a locale code.
 *
 *   zh-CN → ['zh-CN', 'zh', 'en-US', 'en']
 *   ja    → ['ja', 'en-US', 'en']
 *   en-US → ['en-US', 'en']
 *
 * Always ends with en-US + en so the array is plausible for a real
 * bilingual user. Deduplicated in order.
 */
export function buildLanguageList(locale: string): string[] {
  const primary = locale.trim();
  if (!primary) return ['en-US', 'en'];
  const base = primary.split('-')[0];
  const ordered = [primary];
  if (base !== primary) ordered.push(base);
  ordered.push('en-US', 'en');
  // Dedup preserving order
  return [...new Set(ordered)];
}

/**
 * Apply locale overrides to a freshly created BrowserContext.
 *
 *   - Installs an init script that redefines `navigator.language` and
 *     `navigator.languages` BEFORE any page script runs. Uses
 *     `Object.defineProperty` with `configurable: true` so the override
 *     doesn't trip fingerprinters looking for frozen descriptors.
 *   - Sets `Accept-Language` via `setExtraHTTPHeaders`. Merged with
 *     any headers already on the context (the caller's existing
 *     extraHeaders map passed in via `existingHeaders`).
 *
 * No-op when locale is empty/undefined — that's the opt-in gate.
 */
export async function applyLocale(
  context: BrowserContext,
  locale: string | undefined,
  existingHeaders: Record<string, string> = {},
): Promise<void> {
  if (!locale) return;
  const normalized = locale.trim();
  if (!normalized) return;

  const languages = buildLanguageList(normalized);
  const primary = languages[0];

  // Client-side override — runs as the VERY FIRST script on every page
  // and every frame. Must be synchronous and side-effect-free except
  // for the two defineProperty calls.
  //
  // Wrapped in try/catch because CloakBrowser's context wrapper may
  // reject addInitScript during a narrow startup window — we still
  // want the server-side header to land and the daemon to stay alive.
  // Client-side override. CloakBrowser's context wrapper rejects
  // `context.addInitScript` with "expected channel Disposable", so we
  // hook page creation and install the init script per-page instead.
  // Fires on every new page + existing pages. Same effect, different
  // mounting point.
  const installPerPage = async (page: any) => {
    try {
      await page.addInitScript(
        ({ langs, prim }: { langs: string[]; prim: string }) => {
          try {
            Object.defineProperty(navigator, 'language', {
              get: () => prim,
              configurable: true,
            });
            Object.defineProperty(navigator, 'languages', {
              get: () => langs,
              configurable: true,
            });
          } catch {
            // Frozen navigator — header-only fallback still works.
          }
        },
        { langs: languages, prim: primary },
      );
    } catch {
      // Per-page install failed — header-only fallback still works.
    }
  };
  try {
    (context as any).on?.('page', installPerPage);
    for (const p of (context as any).pages?.() ?? []) {
      await installPerPage(p);
    }
  } catch (err: any) {
    console.warn(`[nightcrawl] Locale init-script hook failed: ${err?.message ?? err}. Header-only fallback.`);
  }

  // Server-side header — merged so we don't clobber the caller's
  // existing headers (User-Agent is set elsewhere, etc.).
  try {
    await context.setExtraHTTPHeaders({
      ...existingHeaders,
      'Accept-Language': buildAcceptLanguage(normalized),
    });
  } catch (err: any) {
    console.warn(`[nightcrawl] Locale header failed: ${err?.message ?? err}.`);
  }
}
