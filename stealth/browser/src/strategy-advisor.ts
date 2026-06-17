/**
 * [INPUT]: Pure decision logic — takes pre-computed signals (the caller wires
 *          isPinned/pinnedVendor, hasRealBrowserSession, isHostile,
 *          rememberedEngine, task hints) and returns advice. No I/O, no browser.
 * [OUTPUT]: Exports advise, enforceChoice, formatGuidance and the signal/advice types.
 * [POS]: The brain of the "agent decides, nightCrawl advises + enforces" model.
 *
 * nightCrawl is a browser FOR agents: a hardcoded router can't generalize across
 * the long tail of sites/tasks, so the AGENT chooses the engine. nightCrawl's job
 * is to (1) RECOMMEND the least-invasive engine that should work, (2) INJECT that
 * recommendation + the live signals into every response so the agent can't drift
 * past them, and (3) ENFORCE in tiers:
 *   - soft  : advice is shown every time; the agent is free to follow or not.
 *   - medium: an explicit choice that contradicts a STRONG signal is refused
 *             until re-issued with --force — a conscious, logged override.
 *   - hard  : safety (hostile domain) is blocked outright, never overridable.
 *
 * Engine choice is orthogonal to the existing safety layer (hostile-domains.ts,
 * sensitive-page.ts, consent): those still gate navigation regardless of engine.
 */

export type Engine = 'headless' | 'real';
export type Recommendation = Engine | 'handoff';

export interface AdvisorSignals {
  /** Domain is on the hardcoded hostile blocklist (XHS et al.). */
  hostile: boolean;
  /** Bot-vendor actively pins sessions to fingerprint (cf-mitigated, DataDome…). */
  pinned: boolean;
  /** The pinning vendor, for the guidance block. */
  vendor: string | null;
  /** User has a valid, non-expired session for this domain in their real browser. */
  realBrowserSession: boolean;
  /** What last succeeded here (advice, not a switch). */
  rememberedEngine: Engine | null;
  /** Task needs file upload / trusted file input — real-browser control can't. */
  fileUploadTask: boolean;
  /** A login wall is currently blocking the page. */
  loginWall: boolean;
  /** Headless imported cookies but the wall persisted (empirical pin signature). */
  cookieImportFailed: boolean;
}

export interface Advice {
  recommendation: Recommendation;
  strength: 'weak' | 'strong';
  reason: string;
}

export type EnforcementCode = 'ENGINE_OVERRIDE_REQUIRED' | 'HOSTILE_BLOCKED';

export interface EnforcementResult {
  allow: boolean;
  code?: EnforcementCode;
  message: string;
}

// ─── advise ────────────────────────────────────────────────

/**
 * Recommend the least-invasive engine likely to succeed. Strong = a clear live
 * signal that should gate a contradicting override; weak = a default/hint the
 * agent may freely ignore. Order matters: hard task constraints first, then the
 * pinned/logged-in signals, then memory, then the background default.
 */
export function advise(s: AdvisorSignals): Advice {
  // File upload is a hard capability boundary: the real-browser bridge cannot
  // drive file inputs (CDP Input.setFiles is "Not allowed"). Headless wins.
  if (s.fileUploadTask) {
    return {
      recommendation: 'headless',
      strength: 'strong',
      reason: 'File upload requires the headless engine — real-browser control cannot drive file inputs.',
    };
  }

  // Hostile domains: headless + incognito read-only is the only sanctioned path;
  // the real browser does NOT make them safe (behavioral bans). The actual block
  // lives in the safety layer; here we just steer the engine + surface the rule.
  if (s.hostile) {
    return {
      recommendation: 'headless',
      strength: 'strong',
      reason: 'Hostile domain — read-only only; never authenticate or post on either engine.',
    };
  }

  // Pinned + logged in: only the real browser presents the fingerprint the
  // pinned session was minted against, so cookie replay headless will re-challenge.
  if (s.pinned && s.realBrowserSession) {
    return {
      recommendation: 'real',
      strength: 'strong',
      reason: `${s.vendor ?? 'Bot-managed'} pins sessions to fingerprint and you're logged in — the real browser preserves that session.`,
    };
  }

  // Headless already tried and the wall persisted, but a live session exists:
  // borrow it via the real browser rather than send the user to a handoff.
  if (s.cookieImportFailed && s.realBrowserSession) {
    return {
      recommendation: 'real',
      strength: 'strong',
      reason: 'Headless cookie replay failed but you are logged in — borrow the live session via the real browser.',
    };
  }

  // Login wall and no session anywhere we can reach: this is the ONLY legitimate
  // handoff case — the user genuinely must log in once.
  if (s.loginWall && !s.realBrowserSession) {
    return {
      recommendation: 'handoff',
      strength: 'strong',
      reason: 'Login wall and no existing session — a one-time handoff is required to log in.',
    };
  }

  // No strong live signal — fall back to what worked here before (advice only).
  if (s.rememberedEngine) {
    return {
      recommendation: s.rememberedEngine,
      strength: 'weak',
      reason: `Remembered: ${s.rememberedEngine} succeeded on this domain before.`,
    };
  }

  return {
    recommendation: 'headless',
    strength: 'weak',
    reason: 'Default background engine — no signal favors the real browser.',
  };
}

// ─── enforceChoice ─────────────────────────────────────────

/**
 * Gate an agent's explicit engine choice. Hostile is a hard block. A choice that
 * contradicts a STRONG engine recommendation is refused until `forced` — so a
 * known-bad default can only happen as a deliberate, logged decision. Weak advice
 * never gates. A 'handoff' recommendation does not gate an engine choice (the
 * agent may still attempt an engine; it just probably hits the wall).
 */
export function enforceChoice(
  chosen: Engine,
  s: AdvisorSignals,
  forced: boolean,
): EnforcementResult {
  if (s.hostile) {
    return {
      allow: false,
      code: 'HOSTILE_BLOCKED',
      message: 'Hostile domain is blocked for authenticated automation on every engine. Read-only access only.',
    };
  }

  const a = advise(s);
  const contradicts =
    a.strength === 'strong' &&
    (a.recommendation === 'headless' || a.recommendation === 'real') &&
    chosen !== a.recommendation;

  if (contradicts && !forced) {
    return {
      allow: false,
      code: 'ENGINE_OVERRIDE_REQUIRED',
      message:
        `Chosen engine '${chosen}' contradicts a strong recommendation of '${a.recommendation}': ${a.reason} ` +
        `Re-run with --force to override deliberately.`,
    };
  }

  return { allow: true, message: forced ? 'Forced override accepted.' : 'Choice accepted.' };
}

// ─── formatGuidance ────────────────────────────────────────

/**
 * The block injected into every relevant command response. The agent sees the
 * recommendation, the engine actually used, and the raw signals each time —
 * this is the "enforced reminder" channel that works for any agent (not just
 * Claude Code hooks). Kept compact and machine-skimmable.
 */
export function formatGuidance(
  chosen: Engine | null,
  advice: Advice,
  s: AdvisorSignals,
): string {
  const flags = [
    s.hostile ? 'hostile' : null,
    s.pinned ? `pinned:${s.vendor ?? 'yes'}` : null,
    s.realBrowserSession ? 'real-session' : null,
    s.loginWall ? 'login-wall' : null,
    s.cookieImportFailed ? 'cookie-replay-failed' : null,
    s.fileUploadTask ? 'file-upload' : null,
    s.rememberedEngine ? `remembered:${s.rememberedEngine}` : null,
  ].filter(Boolean).join(', ') || 'none';

  return [
    '── nightcrawl engine guidance ──',
    `engine_used: ${chosen ?? 'headless'}`,
    `recommended: ${advice.recommendation} (${advice.strength})`,
    `signals: ${flags}`,
    `why: ${advice.reason}`,
    `override: pass --engine=headless|real (add --force to go against a strong recommendation)`,
  ].join('\n');
}
