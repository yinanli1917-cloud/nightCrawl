/**
 * [INPUT]: Pure module — no imports. The server's post-command flow gathers the
 *          signals (wall detection, handoff-consent, bridge binding) and passes them.
 * [OUTPUT]: Exports LoginPreviewSignals, LoginPreviewDecision, decideLoginPreview.
 * [POS]: Track B P0-4. The real session dead-ended at LOGIN_REQUIRED on an ALREADY-
 *        consented domain because wall detection and autofill-login were two code
 *        paths that never met. This is the join: at a wall on a consented, bridge-
 *        bound domain, auto-fire a PREVIEW (fill the saved password, do NOT submit) so
 *        the agent is one trusted step from logged-in instead of stuck. It never
 *        auto-submits and never acts on an unconsented domain — the decision type is
 *        preview | skip, so "auto-submit" is unrepresentable by construction.
 */

export interface LoginPreviewSignals {
  wallDetected: boolean;     // a login wall is present on the current page
  domainApproved: boolean;   // grant-handoff consent exists for this eTLD+1
  bridgeBound: boolean;      // an Engine-R tab is bound for this session
  alreadyPreviewed: boolean; // a preview already fired this visit (don't loop)
}

export type LoginPreviewDecision = 'preview' | 'skip';

/**
 * Decide whether to auto-fire a login PREVIEW. Only when a wall is present AND the
 * domain is consented AND a bridge tab is bound AND we haven't already previewed.
 * Never returns submit — submission stays an explicit, separate step. Pure.
 */
export function decideLoginPreview(s: LoginPreviewSignals): LoginPreviewDecision {
  return s.wallDetected && s.domainApproved && s.bridgeBound && !s.alreadyPreviewed ? 'preview' : 'skip';
}
