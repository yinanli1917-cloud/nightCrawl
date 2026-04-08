/**
 * Unit tests for Safari binary cookie import
 *
 * Safari stores cookies in ~/Library/Cookies/Cookies.binarycookies
 * using a proprietary binary format. NO encryption.
 *
 * Binary format:
 *   - Magic: "cook" (4 bytes)
 *   - Page count: big-endian uint32
 *   - Page sizes: big-endian uint32 array
 *   - Pages: each starts with 0x00000100, little-endian cookie records
 *   - Date epoch: Mac absolute time (seconds since 2001-01-01) as float64 LE
 *   - Flags: 0x1=secure, 0x4=httpOnly
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// ─── Constants ──────────────────────────────────────────────────

const MAC_EPOCH_OFFSET = 978307200; // seconds between 1970-01-01 and 2001-01-01
const FIXTURE_DIR = path.join(import.meta.dir, 'fixtures');
const SAFARI_FIXTURE = path.join(FIXTURE_DIR, 'safari-cookies.binarycookies');

// ─── Binary Cookie Builder ─────────────────────────────────────

interface TestCookie {
  domain: string;
  name: string;
  path: string;
  value: string;
  flags: number;       // 0=none, 1=secure, 4=httpOnly, 5=both
  expiry: number;      // Unix timestamp
  creation: number;    // Unix timestamp
}

function buildCookieRecord(cookie: TestCookie): Buffer {
  const domainBuf = Buffer.from(cookie.domain + '\0', 'utf-8');
  const nameBuf = Buffer.from(cookie.name + '\0', 'utf-8');
  const pathBuf = Buffer.from(cookie.path + '\0', 'utf-8');
  const valueBuf = Buffer.from(cookie.value + '\0', 'utf-8');

  // Fixed header: 56 bytes
  const headerSize = 56;
  const domainOffset = headerSize;
  const nameOffset = domainOffset + domainBuf.length;
  const pathOffset = nameOffset + nameBuf.length;
  const valueOffset = pathOffset + pathBuf.length;
  const totalSize = valueOffset + valueBuf.length;

  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  // Record size (LE uint32)
  buf.writeUInt32LE(totalSize, offset); offset += 4;
  // Unknown field
  buf.writeUInt32LE(0, offset); offset += 4;
  // Flags (LE uint32)
  buf.writeUInt32LE(cookie.flags, offset); offset += 4;
  // Unknown field
  buf.writeUInt32LE(0, offset); offset += 4;
  // Domain offset (LE uint32)
  buf.writeUInt32LE(domainOffset, offset); offset += 4;
  // Name offset (LE uint32)
  buf.writeUInt32LE(nameOffset, offset); offset += 4;
  // Path offset (LE uint32)
  buf.writeUInt32LE(pathOffset, offset); offset += 4;
  // Value offset (LE uint32)
  buf.writeUInt32LE(valueOffset, offset); offset += 4;
  // Reserved 8 bytes
  buf.writeBigUInt64LE(0n, offset); offset += 8;
  // Expiry date (LE float64, Mac absolute time)
  buf.writeDoubleLE(cookie.expiry - MAC_EPOCH_OFFSET, offset); offset += 8;
  // Creation date (LE float64, Mac absolute time)
  buf.writeDoubleLE(cookie.creation - MAC_EPOCH_OFFSET, offset); offset += 8;

  // String data
  domainBuf.copy(buf, domainOffset);
  nameBuf.copy(buf, nameOffset);
  pathBuf.copy(buf, pathOffset);
  valueBuf.copy(buf, valueOffset);

  return buf;
}

function buildPage(cookies: TestCookie[]): Buffer {
  const records = cookies.map(buildCookieRecord);

  // Page header: 4 (signature) + 4 (count) + 4*N (offsets) + 4 (footer)
  const headerSize = 4 + 4 + 4 * records.length + 4;
  const recordsSize = records.reduce((sum, r) => sum + r.length, 0);
  const pageSize = headerSize + recordsSize;

  const buf = Buffer.alloc(pageSize);
  let offset = 0;

  // Page signature: 0x00000100
  buf.writeUInt32BE(0x00000100, offset); offset += 4;
  // Cookie count (LE uint32)
  buf.writeUInt32LE(records.length, offset); offset += 4;

  // Cookie offsets (LE uint32, relative to page start)
  let recordOffset = headerSize;
  for (const record of records) {
    buf.writeUInt32LE(recordOffset, offset); offset += 4;
    recordOffset += record.length;
  }

  // Page footer
  buf.writeUInt32LE(0, offset); offset += 4;

  // Copy records
  for (const record of records) {
    record.copy(buf, offset);
    offset += record.length;
  }

  return buf;
}

function buildBinaryCookiesFile(pages: TestCookie[][]): Buffer {
  const pageBuffers = pages.map(buildPage);

  // File header: 4 (magic) + 4 (page count) + 4*N (page sizes)
  const headerSize = 4 + 4 + 4 * pageBuffers.length;
  // File footer: 8 bytes (checksum placeholder)
  const footerSize = 8;
  const totalSize = headerSize + pageBuffers.reduce((s, p) => s + p.length, 0) + footerSize;

  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  // Magic: "cook"
  buf.write('cook', offset, 'ascii'); offset += 4;
  // Page count (BE uint32)
  buf.writeUInt32BE(pageBuffers.length, offset); offset += 4;
  // Page sizes (BE uint32)
  for (const page of pageBuffers) {
    buf.writeUInt32BE(page.length, offset); offset += 4;
  }
  // Pages
  for (const page of pageBuffers) {
    page.copy(buf, offset);
    offset += page.length;
  }
  // Footer (8 zero bytes)
  buf.writeBigUInt64BE(0n, offset);

  return buf;
}

function createSafariFixture(): void {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  const now = Math.floor(Date.now() / 1000);
  const futureExpiry = now + 86400 * 365;

  const page1: TestCookie[] = [
    { domain: '.github.com', name: 'session_id', path: '/', value: 'safari-session-123', flags: 5, expiry: futureExpiry, creation: now },
    { domain: '.github.com', name: 'theme', path: '/', value: 'dark', flags: 0, expiry: futureExpiry, creation: now },
  ];

  const page2: TestCookie[] = [
    { domain: '.google.com', name: 'NID', path: '/', value: 'safari-google-nid', flags: 1, expiry: futureExpiry, creation: now },
    { domain: '.example.com', name: 'plain', path: '/app', value: 'example-value', flags: 4, expiry: futureExpiry, creation: now },
  ];

  const binary = buildBinaryCookiesFile([page1, page2]);
  fs.writeFileSync(SAFARI_FIXTURE, binary);
}

// ─── Import under test ──────────────────────────────────────────

let importSafariCookies: typeof import('../src/cookie-import-safari').importSafariCookies;
let listSafariDomains: typeof import('../src/cookie-import-safari').listSafariDomains;
let parseBinaryCookies: typeof import('../src/cookie-import-safari').parseBinaryCookies;

beforeAll(async () => {
  createSafariFixture();
  const mod = await import('../src/cookie-import-safari');
  importSafariCookies = mod.importSafariCookies;
  listSafariDomains = mod.listSafariDomains;
  parseBinaryCookies = mod.parseBinaryCookies;
});

afterAll(() => {
  try { fs.unlinkSync(SAFARI_FIXTURE); } catch {}
});

// ─── Tests ──────────────────────────────────────────────────────

describe('Safari Cookie Import', () => {

  describe('parseBinaryCookies', () => {
    test('parses all cookies from fixture', () => {
      const data = fs.readFileSync(SAFARI_FIXTURE);
      const cookies = parseBinaryCookies(data);

      expect(cookies.length).toBe(4);

      const names = cookies.map(c => c.name).sort();
      expect(names).toEqual(['NID', 'plain', 'session_id', 'theme']);
    });

    test('parses domain correctly', () => {
      const data = fs.readFileSync(SAFARI_FIXTURE);
      const cookies = parseBinaryCookies(data);

      const session = cookies.find(c => c.name === 'session_id')!;
      expect(session.domain).toBe('.github.com');
    });

    test('parses flags correctly', () => {
      const data = fs.readFileSync(SAFARI_FIXTURE);
      const cookies = parseBinaryCookies(data);

      // flags=5 → secure + httpOnly
      const session = cookies.find(c => c.name === 'session_id')!;
      expect(session.secure).toBe(true);
      expect(session.httpOnly).toBe(true);

      // flags=0 → neither
      const theme = cookies.find(c => c.name === 'theme')!;
      expect(theme.secure).toBe(false);
      expect(theme.httpOnly).toBe(false);

      // flags=1 → secure only
      const nid = cookies.find(c => c.name === 'NID')!;
      expect(nid.secure).toBe(true);
      expect(nid.httpOnly).toBe(false);

      // flags=4 → httpOnly only
      const plain = cookies.find(c => c.name === 'plain')!;
      expect(plain.secure).toBe(false);
      expect(plain.httpOnly).toBe(true);
    });

    test('parses expiry as Unix timestamp', () => {
      const data = fs.readFileSync(SAFARI_FIXTURE);
      const cookies = parseBinaryCookies(data);

      const session = cookies.find(c => c.name === 'session_id')!;
      // Expiry should be roughly now + 365 days
      const now = Math.floor(Date.now() / 1000);
      expect(session.expires).toBeGreaterThan(now);
      expect(session.expires).toBeLessThan(now + 86400 * 400);
    });

    test('parses path correctly', () => {
      const data = fs.readFileSync(SAFARI_FIXTURE);
      const cookies = parseBinaryCookies(data);

      const plain = cookies.find(c => c.name === 'plain')!;
      expect(plain.path).toBe('/app');
    });

    test('rejects non-binarycookies data', () => {
      const garbage = Buffer.from('not a cookie file');
      expect(() => parseBinaryCookies(garbage)).toThrow(/magic/i);
    });

    test('handles empty file (just header, 0 pages)', () => {
      const buf = Buffer.alloc(8);
      buf.write('cook', 0, 'ascii');
      buf.writeUInt32BE(0, 4);
      const cookies = parseBinaryCookies(buf);
      expect(cookies).toEqual([]);
    });
  });

  describe('importSafariCookies', () => {
    test('imports cookies for specific domains', async () => {
      const result = await importSafariCookies(['.github.com'], SAFARI_FIXTURE);

      expect(result.count).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.domainCounts['.github.com']).toBe(2);

      const session = result.cookies.find(c => c.name === 'session_id')!;
      expect(session.value).toBe('safari-session-123');
      expect(session.sameSite).toBe('Lax'); // Safari default
    });

    test('imports multiple domains', async () => {
      const result = await importSafariCookies(['.github.com', '.google.com'], SAFARI_FIXTURE);
      expect(result.count).toBe(3);
    });

    test('returns empty for unmatched domains', async () => {
      const result = await importSafariCookies(['.nonexistent.com'], SAFARI_FIXTURE);
      expect(result.count).toBe(0);
    });

    test('returns empty for empty domain list', async () => {
      const result = await importSafariCookies([], SAFARI_FIXTURE);
      expect(result.count).toBe(0);
    });
  });

  describe('listSafariDomains', () => {
    test('lists all domains with counts', () => {
      const result = listSafariDomains(SAFARI_FIXTURE);
      const domainMap = Object.fromEntries(result.domains.map(d => [d.domain, d.count]));

      expect(domainMap['.github.com']).toBe(2);
      expect(domainMap['.google.com']).toBe(1);
      expect(domainMap['.example.com']).toBe(1);
    });
  });
});
