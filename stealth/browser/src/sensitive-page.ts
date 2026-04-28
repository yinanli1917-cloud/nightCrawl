/**
 * [INPUT]: Playwright page for DOM evaluation
 * [OUTPUT]: detectSensitivePage() — categorized sensitive content detection
 * [POS]: Post-navigation safety gate within browser engine
 */

import { eTldPlusOne } from './handoff-consent';

// ─── Types ──────────────────────────────────────────────

export type SensitiveCategory =
  | 'payment'
  | 'personal_info'
  | 'account_security'
  | 'destructive';

export interface SensitivePageResult {
  detected: boolean;
  category: SensitiveCategory;
  reason: string;
  domain: string;
  signals: string[];
}

// ─── Labels & Notifications ─────────────────────────────

const CATEGORY_LABELS: Record<SensitiveCategory, string> = {
  payment: 'Payment/checkout page',
  personal_info: 'Personal information form',
  account_security: 'Account security settings',
  destructive: 'Destructive account action',
};

export const CATEGORY_NOTIFICATIONS: Record<SensitiveCategory, string> = {
  payment: 'Payment page detected — ready for you to take over',
  personal_info: 'Personal info form — needs your input',
  account_security: 'Security settings — needs your attention',
  destructive: 'Destructive action — needs your confirmation',
};

// ─── Thresholds ─────────────────────────────────────────
// Payment/personal need 2+ signals to avoid false positives
// (a lone "order summary" text on a dashboard isn't a checkout).
// Security/destructive need only 1 (always worth flagging).

const MIN_SIGNALS: Record<SensitiveCategory, number> = {
  payment: 2,
  personal_info: 2,
  account_security: 1,
  destructive: 1,
};

// ─── Prefixes for category grouping ─────────────────────

const CATEGORY_PREFIX: Record<SensitiveCategory, string> = {
  payment: 'payment:',
  personal_info: 'personal:',
  account_security: 'account:',
  destructive: 'destructive:',
};

// Priority order for categorization when multiple categories match
const CATEGORY_PRIORITY: SensitiveCategory[] = [
  'payment',
  'destructive',
  'account_security',
  'personal_info',
];

// ─── Core Detector ──────────────────────────────────────

export async function detectSensitivePage(
  page: any,
): Promise<SensitivePageResult | null> {
  if (!page) return null;

  let url = '';
  try { url = page.url(); } catch { return null; }

  // Skip non-HTTP pages (about:blank, chrome://, extensions)
  if (!url.startsWith('http')) return null;

  const signals: string[] = await page.evaluate(() => {
    const s: string[] = [];
    const text = document.body?.innerText?.slice(0, 8000) || '';
    const path = window.location.pathname.toLowerCase();

    // ── URL patterns ──────────────────────────────────
    if (/\/(checkout|payment|billing|pay|purchase|order\/confirm)/i.test(path))
      s.push('payment:url');
    if (/\/(account\/settings|profile\/edit|security\/settings|privacy\/settings)/i.test(path))
      s.push('account:url');
    if (/\/(delete-account|deactivate|close-account|cancel-subscription)/i.test(path))
      s.push('destructive:url');

    // ── Payment form fields ──────────────────────────
    const ccAuto = [
      'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-name',
    ];
    for (const ac of ccAuto) {
      if (document.querySelector(`input[autocomplete="${ac}"], input[autocomplete*="${ac}"]`)) {
        s.push('payment:field:cc');
        break;
      }
    }

    // Payment provider iframes (Stripe, Braintree, Adyen, PayPal)
    if (document.querySelector([
      'iframe[src*="js.stripe.com"]',
      'iframe[src*="braintreegateway"]',
      'iframe[src*="adyen"]',
      'iframe[src*="paypal.com/sdk"]',
      'iframe[name*="__privateStripeFrame"]',
    ].join(', '))) {
      s.push('payment:iframe');
    }

    // Payment provider data attributes / elements
    if (document.querySelector([
      '[data-braintree-id]', '[data-stripe]', '[data-adyen]',
      '#card-element', '.StripeElement', '#payment-element',
    ].join(', '))) {
      s.push('payment:provider');
    }

    // Payment text
    if (/credit\s*card|debit\s*card|card\s*number|信用卡|借记卡|银行卡/i.test(text))
      s.push('payment:text:card');
    if (/place\s*order|complete\s*purchase|submit\s*payment|pay\s*now|confirm\s*payment|确认付款|提交订单|立即支付/i.test(text))
      s.push('payment:text:action');
    if (/order\s*summary|order\s*total|subtotal|购物车|订单总额/i.test(text))
      s.push('payment:text:summary');
    if (/billing\s*address|shipping\s*address|付款地址|账单地址|收货地址/i.test(text))
      s.push('payment:text:address');

    // ── Personal info form fields ────────────────────
    const personalAuto = ['address-line1', 'postal-code', 'street-address'];
    for (const ac of personalAuto) {
      if (document.querySelector(`input[autocomplete="${ac}"]`)) {
        s.push('personal:field:address');
        break;
      }
    }

    const inputs = Array.from(document.querySelectorAll('input'));
    for (const input of inputs) {
      const hint = [
        input.name, input.id, input.placeholder,
        input.getAttribute('aria-label') || '',
      ].join(' ').toLowerCase();
      if (/ssn|social.?security|tax.?id|身份证|护照号|national.?id/.test(hint)) {
        s.push('personal:field:government_id');
        break;
      }
    }

    // ── Account security ─────────────────────────────
    const pwFields = document.querySelectorAll('input[type="password"]');
    if (pwFields.length >= 2) s.push('account:password_change');
    if (/two.?factor|2fa|authenticator\s*app|recovery\s*codes?|backup\s*codes?|双重认证|两步验证/i.test(text))
      s.push('account:2fa');

    // ── Destructive actions ──────────────────────────
    if (/delete\s*(my\s*)?account|close\s*(my\s*)?account|cancel\s*(my\s*)?subscription|permanently\s*(delete|remove)|注销账号|永久删除/i.test(text))
      s.push('destructive:text');
    if (document.querySelector([
      'button.danger', 'button.btn-danger',
      'button[class*="destructive"]', 'button[class*="delete"]',
    ].join(', ')))
      s.push('destructive:button');

    return s;
  }).catch(() => [] as string[]);

  if (signals.length === 0) return null;

  // Categorize by priority, enforcing minimum signal thresholds
  let category: SensitiveCategory | null = null;
  for (const cat of CATEGORY_PRIORITY) {
    const prefix = CATEGORY_PREFIX[cat];
    const count = signals.filter(sig => sig.startsWith(prefix)).length;
    if (count >= MIN_SIGNALS[cat]) {
      category = cat;
      break;
    }
  }

  if (!category) return null;

  const domain = eTldPlusOne(url);

  return {
    detected: true,
    category,
    reason: `${CATEGORY_LABELS[category]} detected at ${url}`,
    domain,
    signals,
  };
}
