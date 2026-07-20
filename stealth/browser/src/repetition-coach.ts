/**
 * [INPUT]: Pure core (argsKeyFor, detectRepetition) + a module-level per-session Map
 *          (repetitionHint, resetRepetition). No other imports.
 * [OUTPUT]: A one-line nudge when a weak driver repeats an action with no progress.
 * [POS]: The PLANNING-layer analog of the perception layer. The perception primitives
 *        removed DOM-fumbling; this removes step-WASTE — a weak model that re-searches the
 *        same term, re-guesses a visited URL, or re-runs `find` on a page that doesn't have
 *        the answer burns its small budget without moving. The daemon tracks each session's
 *        recent actions (stateless CLI callers share one session) and injects an actionable
 *        next-move line. General, session-scoped, no per-site logic. Wired in server.ts.
 */

export interface ActionRecord {
  command: string;
  argsKey: string; // normalized args (a URL for goto, the lowercased query for search/etc.)
  url: string;     // normalized resulting URL (where the action left the page)
}

// Only the exploration/reading commands loop; click/fill/etc. are legitimately repeatable.
const EXPLORE = new Set(['goto', 'search', 'follow', 'find', 'read', 'text', 'data', 'table']);
const READ_ONLY = new Set(['find', 'read', 'text', 'data', 'table']);
const MAX_HISTORY = 20;
const SEARCH_DUP_OVERLAP = 0.6; // token overlap that counts two searches as re-phrasings

function normalizeUrl(u: string): string {
  const raw = (u || '').trim();
  try {
    const x = new URL(raw);
    return `${x.host}${x.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  }
}

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) || []).concat(s.match(/[一-鿿]/g) || []);
}

function overlap(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** Normalize a command's args into a comparable key. */
export function argsKeyFor(command: string, args: string[]): string {
  const raw = args.join(' ').trim();
  if (command === 'goto') return normalizeUrl(raw);
  return raw.replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * One nudge (prefixed `coach:`) when `command`+`argsKey` repeats a wasted move, or null.
 * `currentUrl` is the normalized URL the current action lands on (for the read-only rule).
 */
export function detectRepetition(
  history: ActionRecord[],
  command: string,
  argsKey: string,
  currentUrl: string,
): string | null {
  if (!EXPLORE.has(command)) return null;

  if (command === 'goto') {
    const visited = history.some((r) => r.argsKey === argsKey || r.url === argsKey);
    if (visited) {
      return 'coach: you already tried this URL. Guessing URLs is looping — `read`/`find` what is already loaded, or use `search`/`follow` to reach a new page.';
    }
    return null;
  }

  if (command === 'search') {
    const priorSearches = history.filter((r) => r.command === 'search');
    const nearDup = priorSearches.some((r) => overlap(r.argsKey, argsKey) >= SEARCH_DUP_OVERLAP);
    if (nearDup || priorSearches.length >= 2) {
      return 'coach: you have already searched several times. Stop searching — `read`/`find` the current results and `follow` the best-matching result.';
    }
    return null;
  }

  if (command === 'follow') {
    if (history.some((r) => r.command === 'follow' && r.argsKey === argsKey)) {
      return 'coach: that `follow` keyword was already used. `read` the page to see the real link texts, then `follow` a DIFFERENT exact phrase, or `search`.';
    }
    return null;
  }

  // READ_ONLY: repeating the same read on the SAME page returns the same nothing.
  if (READ_ONLY.has(command)) {
    const last = history[history.length - 1];
    if (last && last.command === command && last.argsKey === argsKey && last.url === currentUrl) {
      return `coach: \`${command}\` here returned the same thing — the answer is not on this page. Go to a different page (\`follow\`/\`search\`), or try \`table\`/\`data\`.`;
    }
  }
  return null;
}

// ─── Stateful per-session shell (the daemon holds one history per session) ──
const HISTORY = new Map<string, ActionRecord[]>();

/** Check the current action against the session's history, then record it. Returns a nudge or null. */
export function repetitionHint(
  sessionId: string,
  command: string,
  args: string[],
  resultingUrl: string,
): string | null {
  const key = argsKeyFor(command, args);
  const url = normalizeUrl(resultingUrl);
  const hist = HISTORY.get(sessionId) ?? [];
  const hint = detectRepetition(hist, command, key, url);
  if (EXPLORE.has(command)) {
    hist.push({ command, argsKey: key, url });
    if (hist.length > MAX_HISTORY) hist.shift();
    HISTORY.set(sessionId, hist);
  }
  return hint;
}

/** Clear one session's history (or all). Used on tests and could reset per task. */
export function resetRepetition(sessionId?: string): void {
  if (sessionId) HISTORY.delete(sessionId);
  else HISTORY.clear();
}
