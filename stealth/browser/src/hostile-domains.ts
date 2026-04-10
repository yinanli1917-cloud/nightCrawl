/**
 * Hostile-domain blocklist — hardcoded safety enforcement.
 *
 * Background: 2026-04-09 — two real Xiaohongshu accounts permanently
 * banned because a prior nightCrawl session navigated to xiaohongshu.com
 * with the default (non-incognito) profile. nightCrawl auto-restored
 * real cookies, XHS detected automated Chromium signed in as the user,
 * and banned both linked accounts.
 *
 * The "never load real cookies on hostile platforms" rule had existed
 * in CLAUDE.md and memory files, but soft rules cannot enforce safety
 * across sessions. This file moves the rule into code that throws.
 *
 * DESIGN RULES (do not violate):
 * 1. The HOSTILE_DOMAINS list is HARDCODED. Not config-driven. Not a
 *    YAML key. Editing it requires a code change + commit + review.
 * 2. URL matching parses hostnames and checks suffix at hostname
 *    boundaries. Never substring match (xiaohongshu.com.evil.com is
 *    NOT xiaohongshu.com).
 * 3. filterHostileCookies takes no env. Cookies for hostile domains
 *    are ALWAYS filtered, regardless of BROWSE_INCOGNITO. The cookie
 *    file must be safe to load even if a future caller forgets the
 *    incognito flag.
 * 4. assertSafeNavigation is the only function that respects
 *    BROWSE_INCOGNITO=1 — and only because there are legitimate
 *    research uses for hitting these sites with a clean profile.
 *
 * [INPUT]: process.env (BROWSE_INCOGNITO), cookie arrays from restoreCookies
 * [OUTPUT]: HOSTILE_DOMAINS list, isHostile, assertSafeNavigation, filterHostileCookies, HostileDomainError
 * [POS]: Safety enforcement layer between CLI and browser-manager
 */

// Cookie type from playwright — we declare a minimal shape so this
// module has zero runtime imports (faster, simpler to test).
interface CookieLike {
  domain: string;
  [key: string]: any;
}

// ─── The blocklist (hardcoded — DO NOT make this configurable) ──

export const HOSTILE_DOMAINS = [
  // Xiaohongshu (the trigger of the 2026-04-09 incident)
  'xiaohongshu.com',
  'xhscdn.com',
  'xhslink.com',
  // Douyin (TikTok China)
  'douyin.com',
  'iesdouyin.com',
  'douyinpic.com',
  // Weibo
  'weibo.com',
  'weibo.cn',
  'weibocdn.com',
  // LinkedIn (aggressive automation detection)
  'linkedin.com',
  'licdn.com',
  // Instagram
  'instagram.com',
  'cdninstagram.com',
] as const;

// ─── Error type ─────────────────────────────────────────────────

export class HostileDomainError extends Error {
  constructor(url: string) {
    super(
      `[SAFETY] Navigation to ${url} blocked: hostile platform requires BROWSE_INCOGNITO=1. ` +
      `This is a hardcoded safety rule. See project_xhs_account_ban_2026_04_09 memory. ` +
      `Two real accounts were lost on 2026-04-09 because this rule was only soft guidance.`
    );
    this.name = 'HostileDomainError';
  }
}

// ─── Hostname matching (anti-bypass) ────────────────────────────

/**
 * Returns true if `hostname` matches `suffix` at a hostname boundary.
 * - hostname === suffix              -> true
 * - hostname endsWith ('.' + suffix) -> true
 * - anything else                    -> false
 *
 * This rejects xiaohongshu.com.evil.com and fakexiaohongshu.com.
 */
function hostnameMatchesSuffix(hostname: string, suffix: string): boolean {
  const h = hostname.toLowerCase();
  const s = suffix.toLowerCase();
  if (h === s) return true;
  if (h.endsWith('.' + s)) return true;
  return false;
}

/**
 * Parse a URL safely. Returns null on any malformed input.
 */
function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Extract domain from a cookie (handles leading-dot convention).
 */
function cookieDomain(cookie: CookieLike): string {
  const d = cookie.domain || '';
  return d.startsWith('.') ? d.slice(1) : d;
}

// ─── Public API ─────────────────────────────────────────────────

export function isHostile(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const hostname = parsed.hostname;
  return HOSTILE_DOMAINS.some((d) => hostnameMatchesSuffix(hostname, d));
}

export function assertSafeNavigation(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isHostile(url)) return;
  if (env.BROWSE_INCOGNITO === '1') return;
  throw new HostileDomainError(url);
}

export function filterHostileCookies<T extends CookieLike>(cookies: T[]): T[] {
  return cookies.filter((c) => {
    const host = cookieDomain(c);
    return !HOSTILE_DOMAINS.some((d) => hostnameMatchesSuffix(host, d));
  });
}
