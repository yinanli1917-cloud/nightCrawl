/**
 * [INPUT]: Pure logic — no fs, no browser, no network
 * [OUTPUT]: Exports decidePoll, initialPollState, defaultPollOptions
 * [POS]: Auto-handover polling decision logic within browser module
 *
 * Why this exists: the previous polling loop (browser-handoff.ts:498-525
 * pre-2026-04-14-fix) concluded "login complete" the moment the URL
 * changed off /login + no wall. With multi-step IDPs (UW IDP -> Duo ->
 * SP callbacks), that fired DURING the SAML chain — before the SP set
 * _shibsession_*. The cookies snapshotted then were incomplete; next
 * navigation re-bounced. Same bug surface as the Canvas regression
 * (project_canvas_regression_2026_04_14.md), at a different layer.
 *
 * Fix: require URL stability across the full redirect chain. Only
 * resume when the URL has been unchanged for stabilityMs AND is not on
 * a login pattern AND no wall is visible right now. A currently-visible
 * wall (password form / QR / auth text) always means the human is still
 * working, so it blocks resume even if the pre-poll confirm loop missed
 * it on a slow-painting page. Pure function so the timing rules are
 * unit-testable without a browser.
 */

// ─── Types ──────────────────────────────────────────────────

export interface PollContext {
  url: string;        // current page URL
  hasWall: boolean;   // page currently shows password form / QR / Chinese auth-text
  elapsedMs: number;  // time since polling began
}

export interface PollState {
  lastUrl: string;        // last URL we observed
  lastUrlChangeAt: number; // elapsedMs at which the URL last changed
}

export interface PollOptions {
  loginUrl: string;        // URL where polling began (the original wall)
  maxWaitMs: number;       // total time budget; default 5min
  stabilityMs: number;     // URL must be unchanged for this long; default 5s
  loginUrlPattern: RegExp; // pattern that flags a URL as still being a login page
}

export type PollAction = 'continue' | 'resume' | 'timeout';

export interface PollDecision {
  action: PollAction;
  reason: string;
}

// ─── Defaults ───────────────────────────────────────────────

const DEFAULT_LOGIN_URL_PATTERN = /[/=](login|signin|sign-in|auth|captcha|verify|sso|saml)\b/i;

export function initialPollState(loginUrl: string): PollState {
  return { lastUrl: loginUrl, lastUrlChangeAt: 0 };
}

export function defaultPollOptions(loginUrl: string): PollOptions {
  return {
    loginUrl,
    maxWaitMs: 5 * 60 * 1000, // 5 minutes
    stabilityMs: 5 * 1000,    // 5 seconds of unchanged URL
    loginUrlPattern: DEFAULT_LOGIN_URL_PATTERN,
  };
}

// ─── Decision function ──────────────────────────────────────

/**
 * Given the current page state and elapsed time, decide whether to
 * keep polling, resume to headless, or time out.
 *
 * MUTATES `state` in place to track URL changes across calls. (Caller
 * threads the same state object through repeated calls.)
 */
export function decidePoll(
  ctx: PollContext,
  options: PollOptions,
  state: PollState,
): PollDecision {
  // Track URL changes: any new URL resets the stability clock.
  if (ctx.url !== state.lastUrl) {
    state.lastUrl = ctx.url;
    state.lastUrlChangeAt = ctx.elapsedMs;
  }

  // Hard timeout takes precedence over everything.
  if (ctx.elapsedMs > options.maxWaitMs) {
    return { action: 'timeout', reason: `Max wait ${options.maxWaitMs}ms exceeded` };
  }

  // Still on a login-pattern URL? The chain hasn't even started landing.
  if (options.loginUrlPattern.test(ctx.url)) {
    return { action: 'continue', reason: `URL still matches login pattern: ${ctx.url}` };
  }

  // Wall visible right now? The human is still working — never resume,
  // regardless of whether the pre-poll confirm loop happened to catch it.
  if (ctx.hasWall) {
    return { action: 'continue', reason: 'Login wall still present on page' };
  }

  // URL stability check: the chain may have multiple hops. We resume only
  // when the page has settled. Without this, a Duo iframe load (URL change
  // off /SSO + no password form) would prematurely declare success.
  const timeOnCurrentUrl = ctx.elapsedMs - state.lastUrlChangeAt;
  if (timeOnCurrentUrl < options.stabilityMs) {
    return {
      action: 'continue',
      reason: `URL settled ${timeOnCurrentUrl}ms ago; need ${options.stabilityMs}ms of stability`,
    };
  }

  // All conditions satisfied: URL stable, no login pattern, wall gone (or never seen).
  return {
    action: 'resume',
    reason: `URL stable ${timeOnCurrentUrl}ms at ${ctx.url}`,
  };
}
