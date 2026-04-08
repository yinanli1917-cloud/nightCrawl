/**
 * [INPUT]: Reads Safari binary cookies file (Cookies.binarycookies)
 * [OUTPUT]: Exports parseBinaryCookies, importSafariCookies, listSafariDomains
 * [POS]: Safari cookie reader within cookie-import subsystem
 *
 * Safari uses a proprietary binary format. No encryption.
 * Format: "cook" magic, big-endian page count/sizes, little-endian page contents.
 * Dates use Mac absolute time (seconds since 2001-01-01) as float64 LE.
 * Flags: 0x1=secure, 0x4=httpOnly.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PlaywrightCookie, ImportResult, DomainEntry } from './cookie-import-browser';
import { CookieImportError } from './cookie-import-browser';

// ─── Constants ──────────────────────────────────────────────────

const MAGIC = 'cook';
const PAGE_HEADER = 0x00000100;
const MAC_EPOCH_OFFSET = 978307200; // seconds between 1970-01-01 and 2001-01-01
const FLAG_SECURE = 0x1;
const FLAG_HTTPONLY = 0x4;

// ─── Types ──────────────────────────────────────────────────────

interface ParsedCookie {
  domain: string;
  name: string;
  value: string;
  path: string;
  flags: number;
  expires: number;    // Unix timestamp
  creation: number;   // Unix timestamp
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Parse a Safari .binarycookies buffer into PlaywrightCookie array.
 */
export function parseBinaryCookies(data: Buffer | Uint8Array): PlaywrightCookie[] {
  const buf = Buffer.from(data);
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== MAGIC) {
    throw new CookieImportError('Not a Safari binary cookies file (bad magic)', 'bad_format');
  }

  const pageCount = buf.readUInt32BE(4);
  if (pageCount === 0) return [];

  // Read page sizes (big-endian)
  const pageSizes: number[] = [];
  let offset = 8;
  for (let i = 0; i < pageCount; i++) {
    pageSizes.push(buf.readUInt32BE(offset));
    offset += 4;
  }

  // Parse each page
  const cookies: PlaywrightCookie[] = [];
  for (let i = 0; i < pageCount; i++) {
    const pageStart = offset;
    const pageEnd = pageStart + pageSizes[i];
    const pageBuf = buf.subarray(pageStart, pageEnd);
    parsePage(pageBuf, cookies);
    offset = pageEnd;
  }

  return cookies;
}

/**
 * Import Safari cookies for specific domains.
 */
export async function importSafariCookies(
  domains: string[],
  filePath?: string,
): Promise<ImportResult> {
  if (domains.length === 0) return { cookies: [], count: 0, failed: 0, domainCounts: {} };

  const cookiePath = filePath || getDefaultSafariCookiePath();
  const data = readSafariFile(cookiePath);
  const allCookies = parseBinaryCookies(data);
  const domainSet = new Set(domains);

  const cookies: PlaywrightCookie[] = [];
  const domainCounts: Record<string, number> = {};

  for (const cookie of allCookies) {
    if (!domainSet.has(cookie.domain)) continue;
    cookies.push(cookie);
    domainCounts[cookie.domain] = (domainCounts[cookie.domain] || 0) + 1;
  }

  return { cookies, count: cookies.length, failed: 0, domainCounts };
}

/**
 * List all domains with cookie counts from Safari.
 */
export function listSafariDomains(filePath?: string): { domains: DomainEntry[]; browser: string } {
  const cookiePath = filePath || getDefaultSafariCookiePath();
  const data = readSafariFile(cookiePath);
  const allCookies = parseBinaryCookies(data);

  const counts = new Map<string, number>();
  for (const cookie of allCookies) {
    counts.set(cookie.domain, (counts.get(cookie.domain) || 0) + 1);
  }

  const domains: DomainEntry[] = [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count);

  return { domains, browser: 'Safari' };
}

// ─── Internal: Page Parsing ─────────────────────────────────────

function parsePage(pageBuf: Buffer, out: PlaywrightCookie[]): void {
  if (pageBuf.length < 8) return;

  // Verify page header (big-endian 0x00000100)
  const header = pageBuf.readUInt32BE(0);
  if (header !== PAGE_HEADER) return;

  const cookieCount = pageBuf.readUInt32LE(4);
  if (cookieCount === 0) return;

  // Read cookie offsets (little-endian, relative to page start)
  const offsets: number[] = [];
  let pos = 8;
  for (let i = 0; i < cookieCount; i++) {
    offsets.push(pageBuf.readUInt32LE(pos));
    pos += 4;
  }

  // Parse each cookie record
  for (const cookieOffset of offsets) {
    try {
      const cookie = parseCookieRecord(pageBuf, cookieOffset);
      out.push(cookie);
    } catch {
      // Skip malformed cookies
    }
  }
}

function parseCookieRecord(pageBuf: Buffer, start: number): PlaywrightCookie {
  const recordSize = pageBuf.readUInt32LE(start);
  // Skip unknown field at start+4
  const flags = pageBuf.readUInt32LE(start + 8);
  // Skip unknown field at start+12
  const domainOffset = pageBuf.readUInt32LE(start + 16);
  const nameOffset = pageBuf.readUInt32LE(start + 20);
  const pathOffset = pageBuf.readUInt32LE(start + 24);
  const valueOffset = pageBuf.readUInt32LE(start + 28);
  // Skip 8 reserved bytes at start+32
  const expiryMac = pageBuf.readDoubleLE(start + 40);
  // Creation at start+48 (not needed for Playwright cookies)

  const domain = readNullTermString(pageBuf, start + domainOffset, start + recordSize);
  const name = readNullTermString(pageBuf, start + nameOffset, start + recordSize);
  const cookiePath = readNullTermString(pageBuf, start + pathOffset, start + recordSize);
  const value = readNullTermString(pageBuf, start + valueOffset, start + recordSize);

  const expiryUnix = Math.round(expiryMac + MAC_EPOCH_OFFSET);

  return {
    name,
    value,
    domain,
    path: cookiePath || '/',
    expires: expiryUnix,
    secure: (flags & FLAG_SECURE) !== 0,
    httpOnly: (flags & FLAG_HTTPONLY) !== 0,
    sameSite: 'Lax', // Safari does not store sameSite in binarycookies
  };
}

function readNullTermString(buf: Buffer, start: number, limit: number): string {
  let end = start;
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString('utf-8', start, end);
}

// ─── Internal: File Access ──────────────────────────────────────

function getDefaultSafariCookiePath(): string {
  return path.join(os.homedir(), 'Library', 'Cookies', 'Cookies.binarycookies');
}

function readSafariFile(filePath: string): Buffer {
  try {
    return fs.readFileSync(filePath) as Buffer;
  } catch (err: any) {
    throw new CookieImportError(
      `Cannot read Safari cookies: ${err.message}`,
      'file_error',
    );
  }
}
