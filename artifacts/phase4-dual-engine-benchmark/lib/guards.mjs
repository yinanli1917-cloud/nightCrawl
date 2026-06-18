/**
 * [INPUT]: raw stdout/stderr strings from `nc` / Kimi / `nc verify`
 * [OUTPUT]: isReloginPrompt, isHeadedPop, isVerifyOk
 * [POS]: hard-rule guards for the Phase-4 dual-engine benchmark harness
 *
 * The user is already logged in to Arc. The contract for this benchmark:
 *   - a re-login / consent / 2FA wall = the engine failed to leverage the
 *     live session  → recorded FAILURE, never a silent retry.
 *   - a headed-window pop during a HEADLESS run = boundary violation → FAIL.
 *   - "done" requires a VERIFY_OK token from `nc verify` (DVC), nothing less.
 */

// ── Re-login / consent / 2FA detection ───────────────────────────────────
// Strongest signals are nightcrawl's own emitted markers (LOGIN_REQUIRED,
// CONSENT_REQUIRED). We also catch explicit human-facing login/2FA wall copy.
// We deliberately do NOT match a bare "sign out" / "signed in" — those appear
// on pages where the session is healthy.
const RELOGIN_RE = new RegExp(
  [
    'LOGIN_REQUIRED',
    'CONSENT_REQUIRED',
    'AUTH_REQUIRED',
    'sign in to',
    'sign in with',
    'please sign in',
    'log in to',
    'please log in',
    'enter your (net\\s?id|password|credentials)',
    'two-factor',
    'two factor',
    '\\bDuo\\b',
    'verify your identity',
  ].join('|'),
  'i',
);

export function isReloginPrompt(out) {
  if (!out) return false;
  return RELOGIN_RE.test(String(out));
}

// ── Unexpected headed-window pop (headless runs only) ─────────────────────
const HEADED_RE = /launchHeaded|open-handoff|headed Chromium|opening headed|launchCloakBrowser\b.*headed/i;

export function isHeadedPop(out) {
  if (!out) return false;
  return HEADED_RE.test(String(out));
}

// ── Deliverable verification gate ────────────────────────────────────────
// `nc verify` prints VERIFY_OK on success and VERIFY_FAILED on failure. A pass
// requires the OK token AND the absence of the failure token (defensive).
export function isVerifyOk(out) {
  if (!out) return false;
  const s = String(out);
  return s.includes('VERIFY_OK') && !s.includes('VERIFY_FAILED');
}
