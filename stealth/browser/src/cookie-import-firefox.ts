/**
 * [INPUT]: Depends on bun:sqlite for reading Firefox cookie database
 * [OUTPUT]: Exports importFirefoxCookies, listFirefoxDomains, findFirefoxProfiles
 * [POS]: Firefox cookie reader within cookie-import subsystem
 *
 * Firefox stores cookies in moz_cookies table inside cookies.sqlite.
 * No encryption. Values are plaintext. Time is Unix seconds (expiry)
 * or microseconds since epoch (creationTime, lastAccessed).
 */

import { Database } from 'bun:sqlite';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PlaywrightCookie, ImportResult, DomainEntry } from './cookie-import-browser';
import { CookieImportError } from './cookie-import-browser';

// ─── Types ──────────────────────────────────────────────────────

export interface FirefoxProfile {
  name: string;
  dbPath: string;
}

interface RawFirefoxCookie {
  host: string;
  name: string;
  value: string;
  path: string;
  expiry: number;
  isSecure: number;
  isHttpOnly: number;
  sameSite: number;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Find Firefox profiles that have a cookies.sqlite file.
 */
export function findFirefoxProfiles(): FirefoxProfile[] {
  const profilesDir = getFirefoxProfilesDir();
  if (!profilesDir || !fs.existsSync(profilesDir)) return [];

  const profiles: FirefoxProfile[] = [];
  try {
    const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dbPath = path.join(profilesDir, entry.name, 'cookies.sqlite');
      if (fs.existsSync(dbPath)) {
        profiles.push({ name: entry.name, dbPath });
      }
    }
  } catch {}
  return profiles;
}

/**
 * List domains with cookie counts from a Firefox database. No decryption needed.
 */
export function listFirefoxDomains(dbPath: string): { domains: DomainEntry[]; browser: string } {
  const db = openFirefoxDb(dbPath);
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = db.query(
      `SELECT host AS domain, COUNT(*) AS count
       FROM moz_cookies
       WHERE expiry = 0 OR expiry > ?
       GROUP BY host
       ORDER BY count DESC`
    ).all(now) as DomainEntry[];
    return { domains: rows, browser: 'Firefox' };
  } finally {
    db.close();
  }
}

/**
 * Import cookies from Firefox for specific domains.
 */
export async function importFirefoxCookies(
  domains: string[],
  dbPath: string,
): Promise<ImportResult> {
  if (domains.length === 0) return { cookies: [], count: 0, failed: 0, domainCounts: {} };

  const db = openFirefoxDb(dbPath);
  try {
    const now = Math.floor(Date.now() / 1000);
    const placeholders = domains.map(() => '?').join(',');
    const rows = db.query(
      `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
       FROM moz_cookies
       WHERE host IN (${placeholders})
         AND (expiry = 0 OR expiry > ?)
       ORDER BY host, name`
    ).all(...domains, now) as RawFirefoxCookie[];

    const cookies: PlaywrightCookie[] = [];
    let failed = 0;
    const domainCounts: Record<string, number> = {};

    for (const row of rows) {
      try {
        cookies.push(toPlaywrightCookie(row));
        domainCounts[row.host] = (domainCounts[row.host] || 0) + 1;
      } catch {
        failed++;
      }
    }

    return { cookies, count: cookies.length, failed, domainCounts };
  } finally {
    db.close();
  }
}

// ─── Internal ───────────────────────────────────────────────────

function getFirefoxProfilesDir(): string | null {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles');
  }
  if (process.platform === 'linux') {
    return path.join(os.homedir(), '.mozilla', 'firefox');
  }
  return null;
}

function openFirefoxDb(dbPath: string): Database {
  try {
    const db = new Database(dbPath, { readonly: true });
    db.run('PRAGMA mmap_size = 268435456'); // 256 MB mmap for zero-syscall warm reads
    return db;
  } catch (err: any) {
    if (err.message?.includes('SQLITE_BUSY') || err.message?.includes('database is locked')) {
      return openFirefoxDbFromCopy(dbPath);
    }
    throw new CookieImportError(
      `Cannot open Firefox cookie database: ${err.message}`,
      'db_error',
    );
  }
}

function openFirefoxDbFromCopy(dbPath: string): Database {
  const tmpPath = `/tmp/nightcrawl-firefox-cookies-${crypto.randomUUID()}.db`;
  try {
    fs.copyFileSync(dbPath, tmpPath);
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (fs.existsSync(walPath)) fs.copyFileSync(walPath, tmpPath + '-wal');
    if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, tmpPath + '-shm');

    const db = new Database(tmpPath, { readonly: true });
    db.run('PRAGMA mmap_size = 268435456');
    const origClose = db.close.bind(db);
    db.close = () => {
      origClose();
      try { fs.unlinkSync(tmpPath); } catch {}
      try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
      try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
    };
    return db;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new CookieImportError(
      'Firefox cookie database is locked. Try closing Firefox first.',
      'db_locked',
      'retry',
    );
  }
}

function toPlaywrightCookie(row: RawFirefoxCookie): PlaywrightCookie {
  return {
    name: row.name,
    value: row.value,
    domain: row.host,
    path: row.path || '/',
    expires: row.expiry === 0 ? -1 : row.expiry,
    secure: row.isSecure === 1,
    httpOnly: row.isHttpOnly === 1,
    sameSite: mapSameSite(row.sameSite),
  };
}

function mapSameSite(value: number): 'Strict' | 'Lax' | 'None' {
  switch (value) {
    case 0: return 'None';
    case 1: return 'Lax';
    case 2: return 'Strict';
    default: return 'Lax';
  }
}
