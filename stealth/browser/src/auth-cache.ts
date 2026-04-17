/**
 * Authenticated-domain cache — skip redundant login wall detection.
 *
 * After a successful navigation to a domain where cookies are present
 * and no login wall was detected, cache that domain as "authenticated"
 * for a TTL period. Subsequent navigations to the same domain skip
 * the 2s SPA-render wait + 4 DOM evaluation passes in detectLoginWall.
 *
 * This is invisible to the user. No commands, no config. Just faster.
 *
 * Cache is in-memory only (dies with the daemon). No disk persistence
 * needed — cookies are already persisted, and the cache rebuilds
 * automatically as the user browses.
 *
 * [INPUT]: URL from navigation
 * [OUTPUT]: isAuthenticated(), markAuthenticated(), invalidate()
 * [POS]: Performance layer between server.ts navigation and login-wall detection
 */

import { eTldPlusOne } from './handoff-consent';

// ─── Config ───────────────────────────────────────────────

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Cache ────────────────────────────────────────────────

interface AuthEntry {
  domain: string;
  authenticatedAt: number;
  ttlMs: number;
}

const cache = new Map<string, AuthEntry>();

/**
 * Check if a URL's domain is cached as authenticated.
 * Returns true only if the entry exists and hasn't expired.
 */
export function isAuthenticated(url: string): boolean {
  try {
    const domain = eTldPlusOne(url);
    const entry = cache.get(domain);
    if (!entry) return false;
    if (Date.now() - entry.authenticatedAt > entry.ttlMs) {
      cache.delete(domain);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark a domain as authenticated (no login wall detected after navigation).
 * Called by server.ts after a successful goto with no wall.
 */
export function markAuthenticated(url: string, ttlMs = DEFAULT_TTL_MS): void {
  try {
    const domain = eTldPlusOne(url);
    cache.set(domain, { domain, authenticatedAt: Date.now(), ttlMs });
  } catch {}
}

/**
 * Invalidate a domain's auth cache (e.g., when a login wall IS detected).
 */
export function invalidate(url: string): void {
  try {
    const domain = eTldPlusOne(url);
    cache.delete(domain);
  } catch {}
}

/**
 * Clear the entire cache (e.g., on daemon restart).
 */
export function clearAuthCache(): void {
  cache.clear();
}

/**
 * Get cache stats for debugging/health reporting.
 */
export function authCacheStats(): { size: number; domains: string[] } {
  // Prune expired entries first
  const now = Date.now();
  for (const [domain, entry] of cache) {
    if (now - entry.authenticatedAt > entry.ttlMs) cache.delete(domain);
  }
  return { size: cache.size, domains: [...cache.keys()] };
}
