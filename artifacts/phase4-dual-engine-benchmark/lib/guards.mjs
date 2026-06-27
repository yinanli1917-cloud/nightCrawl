/**
 * [INPUT]: re-exports the canonical policy predicates from the TS single source of
 *          truth (stealth/browser/src/metric-budget.ts).
 * [OUTPUT]: isReloginPrompt, isHeadedPop, isVerifyOk
 * [POS]: hard-rule guards for the Phase-4 dual-engine benchmark harness.
 *
 * The benchmark's hard rules and the online router's Completion-under-Policy gate are
 * ONE vocabulary. Rather than maintain a second copy of the regexes here (which would
 * drift), these are the SAME predicates the router scores against, re-exported under
 * the names the runners already import. The contract is unchanged:
 *   - a re-login / consent / 2FA wall = the engine failed to leverage the live
 *     session  → recorded FAILURE, never a silent retry.
 *   - a headed-window pop during a HEADLESS run = boundary violation → FAIL.
 *   - "done" requires a VERIFY_OK token from `nc verify` (DVC), nothing less.
 */

export {
  isReloginViolation as isReloginPrompt,
  isHeadedPopViolation as isHeadedPop,
  isVerifyOk,
} from '../../../stealth/browser/src/metric-budget.ts';
