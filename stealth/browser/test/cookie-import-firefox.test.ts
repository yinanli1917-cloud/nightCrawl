/**
 * Unit tests for Firefox cookie import
 *
 * Firefox stores cookies in ~/Library/Application Support/Firefox/Profiles/<profile>/cookies.sqlite
 * using the moz_cookies table. NO encryption, values are plaintext.
 *
 * Time format: expiry is Unix seconds, creationTime/lastAccessed are microseconds since epoch.
 * sameSite: 0=None, 1=Lax, 2=Strict (same mapping as Chromium)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';

// ─── Fixture Setup ──────────────────────────────────────────────

const FIXTURE_DIR = path.join(import.meta.dir, 'fixtures');
const FIREFOX_DB = path.join(FIXTURE_DIR, 'firefox-cookies.db');

function createFirefoxFixtureDb(): void {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  if (fs.existsSync(FIREFOX_DB)) fs.unlinkSync(FIREFOX_DB);

  const db = new Database(FIREFOX_DB);
  db.run(`CREATE TABLE moz_cookies (
    id INTEGER PRIMARY KEY,
    originAttributes TEXT NOT NULL DEFAULT '',
    name TEXT,
    value TEXT,
    host TEXT,
    path TEXT,
    expiry INTEGER,
    lastAccessed INTEGER,
    creationTime INTEGER,
    isSecure INTEGER,
    isHttpOnly INTEGER,
    inBrowserElement INTEGER DEFAULT 0,
    sameSite INTEGER DEFAULT 0,
    rawSameSite INTEGER DEFAULT 0,
    schemeMap INTEGER DEFAULT 0
  )`);

  const insert = db.prepare(`INSERT INTO moz_cookies
    (name, value, host, path, expiry, lastAccessed, creationTime, isSecure, isHttpOnly, sameSite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const now = Math.floor(Date.now() / 1000);
  const futureExpiry = now + 86400 * 365;
  const pastExpiry = now - 86400;
  const nowMicro = now * 1_000_000;

  // .github.com — 2 cookies
  insert.run('session_id', 'ff-session-123', '.github.com', '/', futureExpiry, nowMicro, nowMicro, 1, 1, 1);
  insert.run('theme', 'dark', '.github.com', '/', futureExpiry, nowMicro, nowMicro, 0, 0, 2);

  // .google.com — 1 cookie
  insert.run('NID', 'ff-google-nid', '.google.com', '/', futureExpiry, nowMicro, nowMicro, 1, 1, 0);

  // .expired.com — expired cookie (should be filtered)
  insert.run('old', 'expired-value', '.expired.com', '/', pastExpiry, nowMicro, nowMicro, 0, 0, 1);

  // .session.com — session cookie (expiry=0)
  insert.run('sess', 'session-value', '.session.com', '/', 0, nowMicro, nowMicro, 1, 1, 1);

  db.close();
}

// ─── Import under test ──────────────────────────────────────────

let importFirefoxCookies: typeof import('../src/cookie-import-firefox').importFirefoxCookies;
let listFirefoxDomains: typeof import('../src/cookie-import-firefox').listFirefoxDomains;
let findFirefoxProfiles: typeof import('../src/cookie-import-firefox').findFirefoxProfiles;

beforeAll(async () => {
  createFirefoxFixtureDb();
  const mod = await import('../src/cookie-import-firefox');
  importFirefoxCookies = mod.importFirefoxCookies;
  listFirefoxDomains = mod.listFirefoxDomains;
  findFirefoxProfiles = mod.findFirefoxProfiles;
});

afterAll(() => {
  try { fs.unlinkSync(FIREFOX_DB); } catch {}
});

// ─── Tests ──────────────────────────────────────────────────────

describe('Firefox Cookie Import', () => {

  describe('importFirefoxCookies', () => {
    test('imports plaintext cookies from fixture DB', async () => {
      const result = await importFirefoxCookies(['.github.com'], FIREFOX_DB);

      expect(result.count).toBe(2);
      expect(result.failed).toBe(0);

      const sessionCookie = result.cookies.find(c => c.name === 'session_id');
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie!.value).toBe('ff-session-123');
      expect(sessionCookie!.domain).toBe('.github.com');
      expect(sessionCookie!.secure).toBe(true);
      expect(sessionCookie!.httpOnly).toBe(true);
      expect(sessionCookie!.sameSite).toBe('Lax');

      const themeCookie = result.cookies.find(c => c.name === 'theme');
      expect(themeCookie).toBeDefined();
      expect(themeCookie!.value).toBe('dark');
      expect(themeCookie!.secure).toBe(false);
      expect(themeCookie!.sameSite).toBe('Strict');
    });

    test('filters expired cookies', async () => {
      const result = await importFirefoxCookies(['.expired.com'], FIREFOX_DB);
      expect(result.count).toBe(0);
    });

    test('handles session cookies (expiry=0)', async () => {
      const result = await importFirefoxCookies(['.session.com'], FIREFOX_DB);
      expect(result.count).toBe(1);
      expect(result.cookies[0].expires).toBe(-1);
    });

    test('returns empty for no matching domains', async () => {
      const result = await importFirefoxCookies(['.nonexistent.com'], FIREFOX_DB);
      expect(result.count).toBe(0);
      expect(result.cookies).toEqual([]);
    });

    test('returns empty for empty domain list', async () => {
      const result = await importFirefoxCookies([], FIREFOX_DB);
      expect(result.count).toBe(0);
    });

    test('imports multiple domains at once', async () => {
      const result = await importFirefoxCookies(['.github.com', '.google.com'], FIREFOX_DB);
      expect(result.count).toBe(3);
      expect(result.domainCounts['.github.com']).toBe(2);
      expect(result.domainCounts['.google.com']).toBe(1);
    });
  });

  describe('listFirefoxDomains', () => {
    test('lists all non-expired domains with counts', () => {
      const result = listFirefoxDomains(FIREFOX_DB);

      const domainMap = Object.fromEntries(result.domains.map(d => [d.domain, d.count]));
      expect(domainMap['.github.com']).toBe(2);
      expect(domainMap['.google.com']).toBe(1);
      expect(domainMap['.session.com']).toBe(1);
      // Expired domain should not appear
      expect(domainMap['.expired.com']).toBeUndefined();
    });
  });

  describe('findFirefoxProfiles', () => {
    test('returns array (may be empty on CI)', () => {
      const profiles = findFirefoxProfiles();
      expect(Array.isArray(profiles)).toBe(true);
      // Each profile should have name and dbPath
      for (const p of profiles) {
        expect(p).toHaveProperty('name');
        expect(p).toHaveProperty('dbPath');
      }
    });
  });
});
