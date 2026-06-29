/**
 * [INPUT]: Pure module — no imports beyond a caller-supplied notify (for confirmation).
 *          `goalType` is a plain string (no dependency on goal.ts) to keep the safety
 *          core dependency-free.
 * [OUTPUT]: Exports IntegrityVerdict, ActionDescriptor, classifyAction,
 *           classifyShapeIntegrity, isEfficiencyWrite, requireConfirmation.
 * [POS]: Skill-library SAFETY CORE — the legitimacy boundary, built FIRST. The
 *        triggering case (a court-ordered class completed by POSTing an xAPI
 *        `completed` statement directly) is exactly what this stops: a fact-asserting
 *        write to a third party becomes a gated, confirm-required action, NEVER a
 *        silent capability. Efficiency writes the user is entitled to (bulk archive,
 *        export, own-data form-fill) pass freely. Applies to local, community, and
 *        curated skills/recipes equally.
 *
 * Fail-safe by construction: efficiency is an ALLOWLIST; any unknown write that looks
 * like a fact-assertion defaults to confirm-required, not pass. The decision type has
 * no "auto-approve" — a sensitive action can only proceed through requireConfirmation.
 */

export type IntegrityVerdict =
  | { kind: 'pass' }
  | { kind: 'confirm-required'; reason: string; signals: string[] };

export interface ActionDescriptor {
  verb?: string;     // HTTP verb if known; undefined → treated as a write (fail-safe)
  url: string;
  body?: string;     // already-redacted body text (may be undefined)
  goalType?: string; // the task label, if supplied
}

// ─── Fact-assertion signals (any match → confirm-required) ──
// A fact-assertion is a write that tells a THIRD PARTY something is true: a course is
// complete, an exam is passed, attendance happened, an identity/payment/signature.
const SIGNALS: { name: string; re: RegExp }[] = [
  {
    name: 'xapi-completion',
    re: /\/xapi\b|\/statements\b|\/tincan\b|uctincan|\/scorm\b|cmi[._]core|scormdriver|adlnet\.gov\/expapi\/verbs\/(completed|passed|failed)|TCAPI_SetCompleted|SetReachedEnd/i,
  },
  { name: 'exam-grade', re: /\/quiz\b|\/exam\b|\/grade\b|\/assessment\b|\/submit-attempt\b|wpproquiz/i },
  { name: 'attendance', re: /\/attendance\b|\/check-?in\b|\/roster\b/i },
  {
    name: 'identity-esign',
    re: /\/verify-identity\b|\/kyc\b|\/e-?sign\b|\/docusign\b|\/signature\b|i\s+certify|i\s+attest|under\s+penalty/i,
  },
  { name: 'payment', re: /\/payments?\b|\/payment-intent|\/charge\b|\/checkout\b|\/transfer\b|\/billing\b/i },
];

// Tokens that make an UNKNOWN write look like an assertion (drives the fail-safe).
const ASSERTION_LIKE =
  /\b(complete|completed|completion|status|score|scored|grade|graded|passed|sign|signed|certif\w*|attest\w*|verif\w*|confirm|finali[sz]e|attendance)\b/i;

// Efficiency ALLOWLIST — owner-scoped ops the user is entitled to do fast.
const EFFICIENCY_URL = /(batch|bulk|archive|trash|\/delete\b|label|\/move\b|export|download|folders|unsubscribe)/i;
const EFFICIENCY_GOALS = new Set(['bulk-archive', 'export-data', 'fill-form', 'extract-data', 'fetch-article']);

function isWriteVerb(verb?: string): boolean {
  if (!verb) return true; // unknown verb → assume a write (fail-safe)
  return /^(POST|PUT|PATCH|DELETE)$/i.test(verb);
}

/** A known-safe efficiency write (owner bulk op / export / own-data fill). */
export function isEfficiencyWrite(a: ActionDescriptor): boolean {
  if (a.goalType && EFFICIENCY_GOALS.has(a.goalType)) return true;
  return EFFICIENCY_URL.test(a.url);
}

/**
 * Classify an outgoing action. A fact-assertion signal → confirm-required. Otherwise,
 * an unknown write whose payload looks assertion-like and is NOT a known efficiency op
 * fails safe to confirm-required. Everything else (reads, benign writes, efficiency
 * ops) passes. Pure, total — never throws.
 */
export function classifyAction(a: ActionDescriptor): IntegrityVerdict {
  const hay = `${a.url} ${a.body ?? ''}`;
  const signals = SIGNALS.filter((s) => s.re.test(hay)).map((s) => s.name);
  if (signals.length) {
    return { kind: 'confirm-required', reason: `fact-asserting action (${signals.join(', ')})`, signals };
  }
  if (isWriteVerb(a.verb) && ASSERTION_LIKE.test(hay) && !isEfficiencyWrite(a)) {
    return { kind: 'confirm-required', reason: 'unknown assertion-like write (fail-safe)', signals: ['fail-safe'] };
  }
  return { kind: 'pass' };
}

/** Classify a DISCOVERED skill shape (used at discovery time). complete-course is always sensitive. */
export function classifyShapeIntegrity(
  shape: { verb: string; urlPattern: string; bodySchema?: Record<string, string> },
  goal: string,
): boolean {
  if (goal === 'complete-course') return true;
  const hay = `${shape.urlPattern} ${Object.keys(shape.bodySchema ?? {}).join(' ')}`;
  return SIGNALS.some((s) => s.re.test(hay));
}

/**
 * Gate a raw `js`/`eval` code string before it runs in the page. Extracts a fetch /
 * XMLHttpRequest target (the only thing that can assert a fact to a third party) and
 * classifies it. Non-network code, and benign reads, pass. A clear fact-assertion (the
 * court-class forged an xAPI `completed` POST by hand) is confirm-required — this is the
 * runtime backstop for an agent that hand-writes the call instead of using a surfaced,
 * already-gated skill. Best-effort parse: if no network call is found, it passes (the
 * surfacing-level gate is the primary boundary). Pure.
 */
export function gateJsCode(code: string): IntegrityVerdict {
  const fetchUrl = code.match(/fetch\s*\(\s*[`'"]([^`'"]+)[`'"]/);
  const xhrOpen = code.match(/\.open\s*\(\s*[`'"]([A-Za-z]+)[`'"]\s*,\s*[`'"]([^`'"]+)[`'"]/);
  let url: string | undefined;
  let verb: string | undefined;
  if (fetchUrl) {
    url = fetchUrl[1];
    verb = code.match(/method\s*:\s*[`'"]([A-Za-z]+)[`'"]/)?.[1];
  } else if (xhrOpen) {
    verb = xhrOpen[1];
    url = xhrOpen[2];
  }
  if (!url) return { kind: 'pass' }; // no network call → nothing to assert here
  const body = code.match(/body\s*:\s*[`'"]([\s\S]*?)[`'"]/)?.[1];
  return classifyAction({ url, verb, body });
}

// ─── Confirmation (never auto-approves) ────────────────────

export interface ConfirmDeps {
  notify: (title: string, body: string) => Promise<'approved' | 'rejected' | 'error'>;
}

/**
 * Require explicit confirmation for a sensitive action. Returns true ONLY on an
 * 'approved' result — 'rejected', 'error', or a thrown notify all fail closed. There is
 * no path that auto-approves a fact-assertion.
 */
export async function requireConfirmation(
  a: ActionDescriptor,
  verdict: Extract<IntegrityVerdict, { kind: 'confirm-required' }>,
  deps: ConfirmDeps,
): Promise<boolean> {
  try {
    const res = await deps.notify('Confirm sensitive action', `${verdict.reason}\n${a.verb ?? 'GET'} ${a.url}`);
    return res === 'approved';
  } catch {
    return false;
  }
}
