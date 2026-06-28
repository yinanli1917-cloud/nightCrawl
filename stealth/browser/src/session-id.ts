/**
 * [INPUT]: process.env (agent-harness session vars), or the X-Nightcrawl-Session
 *          header value on the daemon side.
 * [OUTPUT]: resolveSessionId(), sanitizeSessionId(), SESSION_SOURCES,
 *           DEFAULT_SESSION_ID, SESSION_HEADER.
 * [POS]: Session identity layer. Maps ANY agent harness (Claude Code, Codex,
 *        Cursor, …) to a stable per-session id used to isolate browser tabs so
 *        concurrent sessions never steal or close each other's tabs.
 *
 * Data-driven, NOT per-agent if/else: support a new agent harness by adding one
 * row to SESSION_SOURCES. The wire format is the X-Nightcrawl-Session header —
 * terminal agents get it auto-set by the CLI; API/SDK agents (e.g. OpenClaw)
 * self-identify by setting the header directly.
 */

// ─── Types ──────────────────────────────────────────────────────

export interface SessionSource {
  /** Environment variable carrying the harness's session id. */
  env: string;
  /** Namespace prefix so two ecosystems can't collide. '' = use value verbatim. */
  prefix: string;
}

// ─── Constants ──────────────────────────────────────────────────

/** HTTP header the CLI sets and the daemon reads to scope a command. */
export const SESSION_HEADER = 'X-Nightcrawl-Session';

/** Shared fallback session — untagged callers behave exactly as before. */
export const DEFAULT_SESSION_ID = 'default';

/**
 * Ordered by precedence: explicit override first, then known agent harnesses.
 * Add a new harness as ONE row — no other code changes needed.
 */
export const SESSION_SOURCES: SessionSource[] = [
  { env: 'NIGHTCRAWL_SESSION_ID', prefix: '' },        // explicit override, verbatim
  { env: 'CLAUDE_CODE_SESSION_ID', prefix: 'claude' }, // Claude Code (one id per window)
  { env: 'CODEX_SESSION_ID', prefix: 'codex' },        // Codex CLI
  { env: 'CURSOR_SESSION_ID', prefix: 'cursor' },      // Cursor agent
];

const MAX_LEN = 64;
// Keep id-safe, log-readable chars only. ':' is allowed for the prefix separator.
const UNSAFE_RE = /[^A-Za-z0-9._:-]/g;

// ─── API ────────────────────────────────────────────────────────

/**
 * Normalize a raw id: strip unsafe chars and clamp length. Empty → default.
 * Used on the daemon side for the incoming header (never trust the wire).
 */
export function sanitizeSessionId(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_SESSION_ID;
  const cleaned = raw.replace(UNSAFE_RE, '').slice(0, MAX_LEN);
  return cleaned || DEFAULT_SESSION_ID;
}

/**
 * Resolve this process's session id from the environment.
 * Precedence: SESSION_SOURCES in order → default (the one shared workspace).
 *
 * Untagged callers ALL map to `default` on purpose. A prior design keyed them to
 * proc:<ppid>, but agent harnesses (Cursor) run each CLI command in a FRESH shell,
 * so every command got a new ppid → a new empty workspace → "No active page". A
 * tagged agent (env-var session) still gets its own isolated workspace.
 */
export function resolveSessionId(
  env: Record<string, string | undefined> = process.env,
): string {
  for (const src of SESSION_SOURCES) {
    const val = env[src.env];
    if (val && val.trim()) {
      const id = src.prefix ? `${src.prefix}:${val.trim()}` : val.trim();
      return sanitizeSessionId(id);
    }
  }
  return DEFAULT_SESSION_ID;
}
