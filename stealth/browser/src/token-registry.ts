/**
 * Scoped token system — per-agent permission control
 *
 * [INPUT]: Token ID from auth header, command name, current URL
 * [OUTPUT]: Allow/deny decision with reason
 * [POS]: Security gate between auth validation and command dispatch in server.ts
 *
 * Scope hierarchy:
 *   meta  — status, tabs, screenshots, snapshots (safe introspection)
 *   read  — text, html, links, forms, css, attrs (page content extraction)
 *   write — click, fill, goto, scroll, wait (page interaction)
 *   admin — js, eval, cookies, storage, headers, stop/restart (dangerous)
 *
 * Design: scopes are independent (not hierarchical). A token holds an explicit
 * set of scopes. Domain globs restrict WHERE commands can run. Rate limits
 * restrict HOW OFTEN.
 */

import {
  READ_COMMANDS,
  WRITE_COMMANDS,
  META_COMMANDS,
} from './commands';

// ─── Scopes ─────────────────────────────────────────────────────

export enum Scope {
  Read = 'read',
  Write = 'write',
  Admin = 'admin',
  Meta = 'meta',
}

// ─── Token Shape ────────────────────────────────────────────────

export interface ScopedToken {
  id: string;
  scopes: Scope[];
  domains?: string[];    // Optional domain restriction globs
  rateLimit?: number;    // Max requests per window (undefined = unlimited)
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

// ─── Command-to-Scope Mapping ───────────────────────────────────
// Dangerous commands that would let an agent exfiltrate data, hijack sessions,
// or destabilize the server are gated behind admin scope — even if they live
// in READ_COMMANDS or WRITE_COMMANDS by dispatch category.

const ADMIN_COMMANDS = new Set([
  // Arbitrary code execution
  'js', 'eval',
  // Cookie/session access
  'cookies', 'cookie', 'cookie-import', 'cookie-import-browser',
  // Request manipulation
  'header', 'useragent',
  // Storage (read+write)
  'storage',
  // Log inspection (can leak sensitive request data)
  'console', 'network', 'dialog',
  // Server lifecycle
  'stop', 'restart',
  // Headed mode control
  'handoff', 'resume', 'connect', 'disconnect',
]);

const META_SCOPE_COMMANDS = new Set([
  'status', 'tabs', 'tab', 'newtab', 'closetab',
  'screenshot', 'pdf', 'responsive', 'snapshot',
  'url', 'chain', 'diff', 'focus', 'inbox', 'watch',
  'state', 'frame',
]);

function buildCommandScopeMap(): Record<string, Scope> {
  const map: Record<string, Scope> = {};

  // Admin overrides take priority
  for (const cmd of ADMIN_COMMANDS) {
    map[cmd] = Scope.Admin;
  }

  // Meta scope commands
  for (const cmd of META_SCOPE_COMMANDS) {
    if (!map[cmd]) map[cmd] = Scope.Meta;
  }

  // Remaining READ_COMMANDS → read scope
  for (const cmd of READ_COMMANDS) {
    if (!map[cmd]) map[cmd] = Scope.Read;
  }

  // Remaining WRITE_COMMANDS → write scope
  for (const cmd of WRITE_COMMANDS) {
    if (!map[cmd]) map[cmd] = Scope.Write;
  }

  // Remaining META_COMMANDS → meta scope (shouldn't be any, but safety net)
  for (const cmd of META_COMMANDS) {
    if (!map[cmd]) map[cmd] = Scope.Meta;
  }

  return map;
}

export const COMMAND_SCOPE_MAP: Record<string, Scope> = buildCommandScopeMap();

// ─── Domain Matching ────────────────────────────────────────────

/**
 * Check if a hostname matches any domain glob in the list.
 * Supports exact match and wildcard subdomains (*.example.com).
 */
export function matchesDomain(hostname: string, domains: string[]): boolean {
  for (const pattern of domains) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".example.com"
      if (hostname.endsWith(suffix) && hostname !== suffix.slice(1)) {
        return true;
      }
    } else if (hostname === pattern) {
      return true;
    }
  }
  return false;
}

function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ─── Permission Check ──────────────────────────────────────────

/**
 * Check whether a token is allowed to run a command, optionally
 * on a specific URL. Pure function — no side effects.
 */
export function checkPermission(
  token: ScopedToken,
  command: string,
  currentUrl?: string,
): PermissionResult {
  // Unknown command — deny
  const requiredScope = COMMAND_SCOPE_MAP[command];
  if (!requiredScope) {
    return { allowed: false, reason: `unknown command: ${command}` };
  }

  // Scope check
  if (!token.scopes.includes(requiredScope)) {
    return {
      allowed: false,
      reason: `command '${command}' requires '${requiredScope}' scope, token has: [${token.scopes.join(', ')}]`,
    };
  }

  // Domain restriction (skip for meta-scope commands — they don't target a page)
  if (token.domains && token.domains.length > 0 && requiredScope !== Scope.Meta) {
    if (!currentUrl) {
      return {
        allowed: false,
        reason: `command '${command}' blocked: token has domain restrictions but no URL available`,
      };
    }
    const hostname = extractHostname(currentUrl);
    if (!hostname || !matchesDomain(hostname, token.domains)) {
      return {
        allowed: false,
        reason: `command '${command}' blocked: domain '${hostname || currentUrl}' not in allowed domains`,
      };
    }
  }

  return { allowed: true };
}

// ─── Token Registry ─────────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class TokenRegistry {
  private tokens = new Map<string, ScopedToken>();
  private rateLimits = new Map<string, RateLimitEntry>();
  private windowMs: number;

  constructor(windowMs: number = 60_000) {
    this.windowMs = windowMs;
  }

  register(token: ScopedToken): void {
    this.tokens.set(token.id, token);
  }

  get(id: string): ScopedToken | null {
    return this.tokens.get(id) ?? null;
  }

  revoke(id: string): void {
    this.tokens.delete(id);
    this.rateLimits.delete(id);
  }

  /**
   * Check and consume one rate-limit credit. Returns true if allowed.
   * Tokens without rateLimit are always allowed.
   * Unknown tokens are always denied.
   */
  checkRateLimit(tokenId: string): boolean {
    const token = this.tokens.get(tokenId);
    if (!token) return false;
    if (token.rateLimit === undefined) return true;

    const now = Date.now();
    let entry = this.rateLimits.get(tokenId);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      entry = { count: 0, windowStart: now };
      this.rateLimits.set(tokenId, entry);
    }

    if (entry.count >= token.rateLimit) return false;
    entry.count++;
    return true;
  }

  /** Create a full-access token for the main CLI (backward compat). */
  createFullAccessToken(id: string): ScopedToken {
    const token: ScopedToken = {
      id,
      scopes: [Scope.Read, Scope.Write, Scope.Admin, Scope.Meta],
    };
    this.register(token);
    return token;
  }

  /** Create a restricted token for sidebar agents (no admin scope). */
  createSidebarToken(id: string): ScopedToken {
    const token: ScopedToken = {
      id,
      scopes: [Scope.Read, Scope.Write, Scope.Meta],
    };
    this.register(token);
    return token;
  }
}
