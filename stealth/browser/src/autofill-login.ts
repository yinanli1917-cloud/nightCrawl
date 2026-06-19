/**
 * [INPUT]: An injected LoginAutofillCtx (bridge dispatch, consent, notify) — no
 *          direct browser/state coupling, so the flow is fully unit-testable.
 * [OUTPUT]: Exports LOGIN_DETECT_EXPR, classifyOutcome, handleAutofillLogin.
 * [POS]: C1 — log in as the user via the BROWSER's own saved password (Engine R).
 *
 * Principle: nightCrawl never reads or stores the password. The real browser
 * already native-autofills the saved credential on page load; nightCrawl only
 * (1) detects the login form, (2) gets per-domain consent (SSH-style, reuses the
 * handoff-consent grant), and (3) submits with a TRUSTED gesture (A2) so the
 * browser releases its own autofilled password. 2FA still needs the user — we
 * detect it and hand back. Works only on Engine R (headless has no saved logins).
 */

import { eTldPlusOne } from './handoff-consent';

// Runs in the page via the bridge `js` command. Tags the password + submit
// elements with data attributes so we can target them with stable selectors,
// and reports the native-autofilled username (JS-readable; the password is not).
export const LOGIN_DETECT_EXPR =
  `(() => {
    const pw = document.querySelector('input[type=password]');
    if (!pw) return JSON.stringify({ hasPassword: false });
    pw.setAttribute('data-nc-login-pw', '1');
    const form = pw.closest('form');
    const scope = form || document;
    const user = scope.querySelector('input[autocomplete="username"], input[type=email], input[type=text], input[type=tel]');
    const submit = scope.querySelector('button[type=submit], input[type=submit]') || (form && form.querySelector('button'));
    if (submit) submit.setAttribute('data-nc-login-submit', '1');
    return JSON.stringify({
      hasPassword: true,
      username: user ? (user.value || '') : '',
      passwordSelector: '[data-nc-login-pw="1"]',
      submitSelector: submit ? '[data-nc-login-submit="1"]' : null,
    });
  })()`;

interface LoginDetect {
  hasPassword: boolean;
  username?: string;
  passwordSelector?: string;
  submitSelector?: string | null;
}

function parseDetect(raw: any): LoginDetect {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (v && typeof v.hasPassword === 'boolean') return v;
  } catch {}
  return { hasPassword: false };
}

// ─── Outcome classification (pure) ──────────────────────────

const TWOFA_RE = /\b(duo|two[- ]?factor|2fa|verification code|authenticator|one[- ]?time (?:code|passcode|password)|enter (?:the )?code|security code)\b/i;
const LOGIN_URL_RE = /login|sign[-_ ]?in|signin|\bauth\b|sso|passport/i;

export interface OutcomeInput {
  beforeUrl: string;
  afterUrl: string;
  afterText: string;
  stillHasPassword: boolean;
}

/**
 * Decide what happened after a trusted submit. 2FA is checked first (a 2FA page
 * has no password field but is NOT a success). Then: password gone, or the URL
 * moved away from the login page, means we're in.
 */
export function classifyOutcome(o: OutcomeInput): { status: 'success' | 'twofa' | 'failed' } {
  if (TWOFA_RE.test(o.afterText || '')) return { status: 'twofa' };
  if (!o.stillHasPassword) return { status: 'success' };
  if (o.afterUrl && o.afterUrl !== o.beforeUrl && !LOGIN_URL_RE.test(o.afterUrl)) return { status: 'success' };
  return { status: 'failed' };
}

// ─── Orchestration ──────────────────────────────────────────

export interface LoginAutofillCtx {
  /** Run a bridge command against the real browser (Engine R). */
  dispatch: (command: string, args: string[]) => Promise<any>;
  /** Is a real-browser bridge connected? */
  isConnected: () => boolean;
  /** Has the user approved acting-as-them on this domain (handoff consent)? */
  isConsented: (domain: string) => boolean;
  /** Fire a native consent prompt. */
  notify: (title: string, body: string) => void;
  /** Host-side delay (injectable so tests run fast). */
  sleep?: (ms: number) => Promise<void>;
}

// CDP throws this while the inspected page is committing a navigation; the reads
// just need to be retried once the new page settles.
const NAV_TRANSIENT_RE = /navigated or closed|-32000|Inspected target/i;

export async function handleAutofillLogin(args: string[], ctx: LoginAutofillCtx): Promise<string> {
  if (!ctx.isConnected()) {
    return 'AUTOFILL_LOGIN_UNAVAILABLE: needs the real-browser bridge (Engine R). ' +
      'Open the page in Arc/Chrome with the nightcrawl-bridge extension connected, then run with --engine=real.';
  }

  try {
    const beforeUrl = String((await ctx.dispatch('js', ['location.href'])) ?? '');
    const detect = parseDetect(await ctx.dispatch('js', [LOGIN_DETECT_EXPR]));
    if (!detect.hasPassword) {
      return 'NO_LOGIN_FORM: no password field on the current page — nothing to submit.';
    }

    const domain = eTldPlusOne(beforeUrl) || beforeUrl;
    const who = detect.username || 'your saved account';

    if (!ctx.isConsented(domain)) {
      ctx.notify(
        'nightCrawl — log in as you?',
        `Submit ${domain} as ${who} using the browser's saved password? Approve once: grant-handoff ${domain}`,
      );
      return `CONSENT_REQUIRED: ${domain} — nightCrawl can submit the browser's saved login as you, but needs your approval once. ` +
        `Run \`grant-handoff ${domain}\` (or click Approve in the notification), then retry. No password is ever read or stored.`;
    }

    // Trusted submit (A2). The browser releases its native-autofilled password on a
    // real gesture; CDP Input events are isTrusted:true. Prefer the submit button.
    if (detect.submitSelector) {
      await ctx.dispatch('click', [detect.submitSelector]);
    } else if (detect.passwordSelector) {
      // No submit button found — click the password field (trusted) and hope the
      // form submits on its own handlers. Forms that submit only on Enter aren't
      // reachable via the current bridge surface.
      await ctx.dispatch('click', [detect.passwordSelector]);
    } else {
      return 'LOGIN_FAILED: found a password field but no submit control to click.';
    }

    // The submit navigates the page. CDP reads transiently fail with
    // "Inspected target navigated or closed" mid-navigation — retry host-side
    // until the new page settles (the trusted submit already happened).
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let afterUrl = beforeUrl;
    let after: LoginDetect = { hasPassword: true };
    let afterText = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(500);
      try {
        afterUrl = String((await ctx.dispatch('js', ['location.href'])) ?? '');
        after = parseDetect(await ctx.dispatch('js', [LOGIN_DETECT_EXPR]));
        afterText = String((await ctx.dispatch('text', [])) ?? '');
        break;
      } catch (e: any) {
        if (!NAV_TRANSIENT_RE.test(String(e?.message ?? e)) || attempt === 5) throw e;
        // else: page still navigating — retry
      }
    }

    const outcome = classifyOutcome({ beforeUrl, afterUrl, afterText, stillHasPassword: after.hasPassword });
    switch (outcome.status) {
      case 'twofa':
        return `TWOFA_REQUIRED: ${domain} reached two-factor as ${who} — approve it in your browser (it holds the live session). nightCrawl can resume once you're through.`;
      case 'success':
        return `LOGGED_IN: submitted ${domain} as ${who} using the browser's own saved password. No credential was read or stored.`;
      default:
        return `LOGIN_FAILED: submitted ${domain} but it's still on the login page — the browser may have no saved password for this site, or validation/2FA intervened. Log in once in your browser and retry.`;
    }
  } catch (e: any) {
    // A bridge error (SESSION_LOST, timeout, detach) must surface as clean text,
    // never an unhandled throw that the route renders as an HTML error page.
    const msg = String(e?.message ?? e);
    const hint = /SESSION_LOST|bound tab/i.test(msg)
      ? ' — navigate the real browser first (nc goto <url> --engine=real) so the bridge has a bound tab.'
      : '';
    return `AUTOFILL_LOGIN_ERROR: ${msg}${hint}`;
  }
}
