/**
 * [INPUT]: Playwright Page object
 * [OUTPUT]: cleanup() removes ads, banners, overlays; returns metrics
 * [POS]: page noise removal engine within stealth/browser
 *
 * Runs entirely inside page.evaluate() for speed (<100ms typical).
 * Categories: cookie banners, ads, newsletters, app banners,
 * push notifications, paywalls, modals, large fixed overlays.
 */

import type { Page } from 'playwright';

// ─── Types ─────────────────────────────────────────────────────

export interface CleanupResult {
  cookieBanners: number;
  adContainers: number;
  newsletterPopups: number;
  appBanners: number;
  pushPrompts: number;
  paywallOverlays: number;
  modals: number;
  largeFixedOverlays: number;
  totalRemoved: number;
  estimatedTokenSavings: number;
}

// ─── Selector Lists ────────────────────────────────────────────
// Each category is a list of CSS selectors. Kept as plain arrays
// so the entire cleanup logic serializes into page.evaluate().

const COOKIE_SELECTORS = [
  // OneTrust
  '#onetrust-banner-sdk', '#onetrust-consent-sdk', '.onetrust-banner',
  '#ot-sdk-btn-floating',
  // Cookiebot
  '#CybotCookiebotDialog', '#CybotCookiebotDialogOverlay',
  '#CybotCookiebotDialogBodyUnderlay',
  // TrustArc / TRUSTe
  '#truste-consent-track', '#truste-consent-required', '.truste_box_overlay',
  '#consent_blackbar',
  // Quantcast
  '.qc-cmp-ui-container', '#qc-cmp2-container', '.qc-cmp2-container',
  // CookieYes
  '#cookie-law-info-bar', '.cky-consent-container', '#cky-consent',
  // Osano
  '.osano-cm-window', '.osano-cm-dialog',
  // Generic cookie consent patterns
  '.cc-banner', '.cc-window', '.cc-revoke', '#cookie-banner', '#cookie-notice',
  '#cookie-consent', '.cookie-banner', '.cookie-notice', '.cookie-consent',
  '.cookie-popup', '.cookie-modal', '.cookie-overlay', '.cookie-bar',
  '.cookie-alert', '.cookie-message', '.cookie-disclaimer',
  '#cookies-banner', '#gdpr-banner', '.gdpr-banner', '.gdpr-popup',
  '.gdpr-consent', '#gdpr-consent', '#gdpr-cookie-notice',
  // CMP (Consent Management Platform) generics
  '.cmp-container', '#cmp-container', '.consent-banner', '#consent-banner',
  '.consent-popup', '.consent-modal', '.consent-overlay',
  // Complianz
  '#cmplz-cookiebanner-container',
  // Iubenda
  '#iubenda-cs-banner',
  // Didomi
  '#didomi-host', '#didomi-notice',
  // Klaro
  '.klaro .cookie-notice',
  // Funding Choices (Google)
  '.fc-consent-root', '.fc-dialog-overlay', '.fc-dialog-container',
];

const AD_SELECTORS = [
  // Google AdSense / GPT
  'ins.adsbygoogle', '.adsbygoogle', '[id^="div-gpt-ad"]',
  '[id^="google_ads"]', '.google-auto-placed',
  // Taboola
  '.taboola-container', '[id^="taboola-"]', '.tbl-feed-container',
  // Outbrain
  '.OUTBRAIN', '.ob-widget', '[data-widget-id^="AR_"]',
  // Criteo
  '[id^="criteo-"]', '.criteo-format',
  // Amazon
  '[id^="amzn-assoc-ad"]',
  // Generic ad patterns
  '.ad-container', '.ad-wrapper', '.ad-banner', '.ad-slot', '.ad-unit',
  '.advertisement', '.ad-placeholder', '.sponsored-content',
  '[class*="ad-container"]', '[class*="ad-wrapper"]',
  '[id*="ad-container"]', '[id*="ad-wrapper"]',
  // Sidebar ads
  '.sidebar-ad', '.widget-ad',
];

const NEWSLETTER_SELECTORS = [
  '.newsletter-popup', '.newsletter-modal', '.newsletter-overlay',
  '.email-signup-popup', '.email-popup', '.subscribe-popup',
  '.signup-modal', '.email-capture',
];

const APP_BANNER_SELECTORS = [
  '.smart-banner', '.app-banner', '.app-download-banner',
  '#smart-app-banner', '.smartbanner', '[class*="app-banner"]',
  '[class*="download-app"]',
];

const PUSH_NOTIFICATION_SELECTORS = [
  '.notification-prompt', '.push-notification', '.web-push-prompt',
  '[class*="notification-prompt"]', '[class*="push-prompt"]',
];

const PAYWALL_SELECTORS = [
  '.paywall-overlay', '.paywall', '#paywall',
  // Piano / TinyPass
  '.tp-modal', '.tp-backdrop', '#piano-inline-content-wrapper',
  '.tp-container-inner',
  // Misc publisher paywalls
  '.subscribe-overlay', '.subscription-wall', '.subscription-overlay',
  '.premium-wall', '.regwall', '#regwall',
  '.meter-wall', '.metering-modal', '.met-flyout',
  // USA Today / Gannett
  '[class^="sp_veil"]', '[class^="sp_message_container"]',
  // Generic
  '.redacted-overlay', '.subscriber-only-overlay',
];

// ─── Core Engine ───────────────────────────────────────────────

/**
 * Run cleanup on a Playwright page. Removes ads, banners, overlays.
 * All DOM work happens inside a single page.evaluate() call.
 */
export async function cleanup(page: Page): Promise<CleanupResult> {
  const result = await page.evaluate(
    (config) => {
      const { cookie, ad, newsletter, app, push, paywall } = config;
      const counts = {
        cookieBanners: 0,
        adContainers: 0,
        newsletterPopups: 0,
        appBanners: 0,
        pushPrompts: 0,
        paywallOverlays: 0,
        modals: 0,
        largeFixedOverlays: 0,
        totalRemoved: 0,
        estimatedTokenSavings: 0,
      };
      let totalCharsRemoved = 0;

      // ── Helpers ──────────────────────────────────────────────

      function hideElement(el: Element): number {
        const text = el.textContent || '';
        const chars = text.length;
        (el as HTMLElement).style.display = 'none';
        return chars;
      }

      function removeBySelectors(
        selectors: string[],
        countKey: keyof typeof counts,
      ): void {
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if ((el as HTMLElement).style.display === 'none') continue;
            totalCharsRemoved += hideElement(el);
            (counts[countKey] as number)++;
          }
        }
      }

      // ── Category removal ─────────────────────────────────────

      removeBySelectors(cookie, 'cookieBanners');
      removeBySelectors(ad, 'adContainers');
      removeBySelectors(newsletter, 'newsletterPopups');
      removeBySelectors(app, 'appBanners');
      removeBySelectors(push, 'pushPrompts');
      removeBySelectors(paywall, 'paywallOverlays');

      // ── aria-modal dialogs ───────────────────────────────────

      const modals = document.querySelectorAll('[aria-modal="true"]');
      for (const el of modals) {
        if ((el as HTMLElement).style.display === 'none') continue;
        totalCharsRemoved += hideElement(el);
        counts.modals++;
      }

      // ── Large fixed/sticky overlays (>30% viewport) ─────────

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const viewportArea = vw * vh;
      const allElements = document.querySelectorAll('*');

      for (const el of allElements) {
        const htmlEl = el as HTMLElement;
        if (htmlEl.style.display === 'none') continue;

        const computed = getComputedStyle(htmlEl);
        const pos = computed.position;
        if (pos !== 'fixed' && pos !== 'sticky') continue;

        // Skip elements already caught by selector-based removal
        if (htmlEl.closest('[style*="display: none"]')) continue;

        const rect = htmlEl.getBoundingClientRect();
        const elArea = rect.width * rect.height;

        if (elArea / viewportArea > 0.3) {
          // Protect main content: skip <main>, <article>, <nav>
          const tag = htmlEl.tagName.toLowerCase();
          if (tag === 'main' || tag === 'article' || tag === 'nav') continue;
          if (htmlEl.querySelector('main, article')) continue;

          totalCharsRemoved += hideElement(htmlEl);
          counts.largeFixedOverlays++;
        }
      }

      // ── High z-index overlays with blocking text patterns ────

      const blockingPatterns = [
        /accept\s*(all\s*)?cookies/i,
        /subscribe/i,
        /allow\s*notifications/i,
        /sign\s*up/i,
        /download\s*(our|the)?\s*app/i,
        /we\s*use\s*cookies/i,
        /cookie\s*policy/i,
        /privacy\s*settings/i,
      ];

      for (const el of allElements) {
        const htmlEl = el as HTMLElement;
        if (htmlEl.style.display === 'none') continue;

        const computed = getComputedStyle(htmlEl);
        if (computed.position !== 'fixed') continue;

        const zIndex = parseInt(computed.zIndex, 10);
        if (isNaN(zIndex) || zIndex <= 1000) continue;

        const text = htmlEl.textContent || '';
        const matchesPattern = blockingPatterns.some((p) => p.test(text));
        if (!matchesPattern) continue;

        // Protect main content
        const tag = htmlEl.tagName.toLowerCase();
        if (tag === 'main' || tag === 'article') continue;

        totalCharsRemoved += hideElement(htmlEl);
        // Count in the most appropriate bucket based on text
        if (/cookie/i.test(text)) counts.cookieBanners++;
        else if (/subscribe|sign\s*up/i.test(text)) counts.newsletterPopups++;
        else if (/notification/i.test(text)) counts.pushPrompts++;
        else if (/app/i.test(text)) counts.appBanners++;
        else counts.paywallOverlays++;
      }

      // ── Shadow DOM overlays ──────────────────────────────────

      const shadowHosts = document.querySelectorAll('*');
      for (const host of shadowHosts) {
        const shadow = host.shadowRoot;
        if (!shadow) continue;

        const fixedEls = shadow.querySelectorAll('*');
        for (const el of fixedEls) {
          const htmlEl = el as HTMLElement;
          const computed = getComputedStyle(htmlEl);
          if (computed.position !== 'fixed') continue;

          const rect = htmlEl.getBoundingClientRect();
          const elArea = rect.width * rect.height;
          if (elArea / viewportArea > 0.3) {
            totalCharsRemoved += hideElement(htmlEl);
            counts.largeFixedOverlays++;
          }
        }
      }

      // ── Restore body scroll ──────────────────────────────────

      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';

      // ── Tallies ──────────────────────────────────────────────

      counts.totalRemoved =
        counts.cookieBanners +
        counts.adContainers +
        counts.newsletterPopups +
        counts.appBanners +
        counts.pushPrompts +
        counts.paywallOverlays +
        counts.modals +
        counts.largeFixedOverlays;

      // Rough estimate: 1 token ~ 4 chars for English text
      counts.estimatedTokenSavings = Math.round(totalCharsRemoved / 4);

      return counts;
    },
    {
      cookie: COOKIE_SELECTORS,
      ad: AD_SELECTORS,
      newsletter: NEWSLETTER_SELECTORS,
      app: APP_BANNER_SELECTORS,
      push: PUSH_NOTIFICATION_SELECTORS,
      paywall: PAYWALL_SELECTORS,
    },
  );

  return result;
}

// ─── Formatting ────────────────────────────────────────────────

/** Format cleanup result as a human-readable summary line. */
export function formatCleanupResult(r: CleanupResult): string {
  if (r.totalRemoved === 0) {
    return 'Cleaned: 0 elements removed (page was already clean)';
  }

  const parts: string[] = [];
  if (r.cookieBanners > 0) parts.push(`${r.cookieBanners} cookie banner${r.cookieBanners > 1 ? 's' : ''}`);
  if (r.adContainers > 0) parts.push(`${r.adContainers} ad container${r.adContainers > 1 ? 's' : ''}`);
  if (r.newsletterPopups > 0) parts.push(`${r.newsletterPopups} newsletter popup${r.newsletterPopups > 1 ? 's' : ''}`);
  if (r.appBanners > 0) parts.push(`${r.appBanners} app banner${r.appBanners > 1 ? 's' : ''}`);
  if (r.pushPrompts > 0) parts.push(`${r.pushPrompts} push prompt${r.pushPrompts > 1 ? 's' : ''}`);
  if (r.paywallOverlays > 0) parts.push(`${r.paywallOverlays} paywall overlay${r.paywallOverlays > 1 ? 's' : ''}`);
  if (r.modals > 0) parts.push(`${r.modals} modal${r.modals > 1 ? 's' : ''}`);
  if (r.largeFixedOverlays > 0) parts.push(`${r.largeFixedOverlays} large overlay${r.largeFixedOverlays > 1 ? 's' : ''}`);

  return `Cleaned: ${parts.join(', ')}\nEstimated token savings: ~${r.estimatedTokenSavings.toLocaleString()} tokens`;
}
