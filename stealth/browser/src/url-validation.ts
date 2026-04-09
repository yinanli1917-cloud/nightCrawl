/**
 * URL validation for navigation commands — blocks dangerous schemes, cloud metadata
 * endpoints, and IPv6 private/reserved ranges that could be SSRF vectors.
 *
 * [INPUT]: Raw URL string from navigation commands
 * [OUTPUT]: Throws on blocked URLs, resolves on safe ones
 * [POS]: Security gate before any Playwright navigation
 */

const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',  // AWS/GCP/Azure instance metadata
  'metadata.google.internal', // GCP metadata
  'metadata.azure.internal',  // Azure IMDS
]);

/**
 * Normalize hostname for blocklist comparison:
 * - Strip trailing dot (DNS fully-qualified notation)
 * - Strip IPv6 brackets (URL.hostname includes [] for IPv6)
 * - Resolve hex (0xA9FEA9FE) and decimal (2852039166) IP representations
 */
function normalizeHostname(hostname: string): string {
  // Strip IPv6 brackets
  let h = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  // Strip trailing dot
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * Check if a hostname resolves to the link-local metadata IP 169.254.169.254.
 * Catches hex (0xA9FEA9FE), decimal (2852039166), and octal (0251.0376.0251.0376) forms.
 */
function isMetadataIp(hostname: string): boolean {
  // Try to parse as a numeric IP via URL constructor — it normalizes all forms
  try {
    const probe = new URL(`http://${hostname}`);
    const normalized = probe.hostname;
    if (BLOCKED_METADATA_HOSTS.has(normalized)) return true;
    // Also check after stripping trailing dot
    if (normalized.endsWith('.') && BLOCKED_METADATA_HOSTS.has(normalized.slice(0, -1))) return true;
  } catch {
    // Not a valid hostname — can't be a metadata IP
  }
  return false;
}

/**
 * Check if an IPv6 address falls in a blocked range.
 * Blocks: loopback (::1), unspecified (::), ULA (fc00::/7), link-local (fe80::/10),
 * and IPv4-mapped addresses (::ffff:x.x.x.x) that map to blocked IPv4 ranges.
 */
function isBlockedIpv6(addr: string): boolean {
  // Strip zone ID (e.g., fe80::1%eth0 → fe80::1)
  const clean = addr.split('%')[0].toLowerCase();

  // Loopback and unspecified
  if (clean === '::1' || clean === '::') return true;

  // ULA: fc00::/7 — first byte is fc or fd (binary 1111110x)
  if (/^f[cd][0-9a-f]{2}:/i.test(clean)) return true;

  // Link-local: fe80::/10 — first 10 bits are 1111111010
  if (/^fe[89ab][0-9a-f]:/i.test(clean)) return true;

  // IPv4-mapped IPv6 — two forms after URL normalization:
  //   ::ffff:192.168.1.1  (dotted decimal, some parsers)
  //   ::ffff:c0a8:101     (hex, Bun/Node URL parser)
  const v4dotted = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4dotted) {
    const ipv4 = v4dotted[1];
    if (BLOCKED_METADATA_HOSTS.has(ipv4)) return true;
    if (isBlockedPrivateIpv4(ipv4)) return true;
  }
  const v4hex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4hex) {
    const hi = parseInt(v4hex[1], 16);
    const lo = parseInt(v4hex[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (BLOCKED_METADATA_HOSTS.has(ipv4)) return true;
    if (isBlockedPrivateIpv4(ipv4)) return true;
  }

  return false;
}

/** Check if an IPv4 address is loopback or private (SSRF risk via IPv4-mapped IPv6) */
function isBlockedPrivateIpv4(ip: string): boolean {
  if (ip === '127.0.0.1' || ip.startsWith('127.')) return true;
  return /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(ip);
}

/**
 * Resolve a hostname to its IP addresses and check if any resolve to blocked IPs.
 * Checks both A (IPv4) and AAAA (IPv6) records to prevent DNS rebinding via either.
 */
async function resolvesToBlockedIp(hostname: string): Promise<boolean> {
  try {
    const dns = await import('node:dns');
    const { resolve4, resolve6 } = dns.promises;

    // Check A records
    const v4 = await resolve4(hostname).catch(() => [] as string[]);
    if (v4.some(addr => BLOCKED_METADATA_HOSTS.has(addr) || isBlockedPrivateIpv4(addr))) {
      return true;
    }

    // Check AAAA records
    const v6 = await resolve6(hostname).catch(() => [] as string[]);
    if (v6.some(addr => isBlockedIpv6(addr))) return true;

    return false;
  } catch {
    return false;
  }
}

import { isExfiltrationUrl } from './content-security';

/**
 * Escape special regex characters to prevent ReDoS when constructing RegExp from user input.
 * Used by frame --url command and exported for testing.
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function validateNavigationUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Blocked: scheme "${parsed.protocol}" is not allowed. Only http: and https: URLs are permitted.`
    );
  }

  // Exfiltration URL check — block known data-capture services
  if (isExfiltrationUrl(url)) {
    throw new Error(
      `Blocked: ${parsed.hostname} is a known data exfiltration service. Navigation denied for security.`
    );
  }

  const hostname = normalizeHostname(parsed.hostname.toLowerCase());

  // Check static blocklist (metadata hostnames + numeric IP forms)
  if (BLOCKED_METADATA_HOSTS.has(hostname) || isMetadataIp(hostname)) {
    throw new Error(
      `Blocked: ${parsed.hostname} is a cloud metadata endpoint. Access is denied for security.`
    );
  }

  // Check IPv6 reserved ranges (ULA, link-local, loopback, IPv4-mapped)
  if (isBlockedIpv6(hostname)) {
    throw new Error(
      `Blocked: ${parsed.hostname} is a reserved IPv6 address. Access is denied for security.`
    );
  }

  // DNS rebinding protection: resolve hostname and check if it points to blocked IPs.
  // Skip for literal IPs and localhost — they can't be DNS-rebinded and the async DNS
  // resolution adds latency that breaks concurrent E2E tests under load.
  const isLocalhost = hostname === 'localhost';
  const isLiteralIp = hostname === '127.0.0.1' || /^[\da-f.:]+$/i.test(hostname);
  const isPrivateNet = /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname);
  if (!isLocalhost && !isLiteralIp && !isPrivateNet && await resolvesToBlockedIp(hostname)) {
    throw new Error(
      `Blocked: ${parsed.hostname} resolves to a blocked IP. Possible DNS rebinding attack.`
    );
  }
}
