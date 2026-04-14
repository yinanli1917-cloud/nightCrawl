/**
 * [INPUT]: fs + ~/.nightcrawl/state/ (storage backend)
 * [OUTPUT]: ConsentStore + grant/revoke/isApproved/prune/eTldPlusOne
 * [POS]: Per-domain consent store for proactive handoff within browser module
 *
 * Why this exists: commit 520a253 flipped BROWSE_AUTO_HANDOVER to opt-in to
 * prevent silent window-pops on unknown domains (quark.cn). That broke
 * Canvas (canvas.uw.edu) because manual resume skips the login-wall
 * disappearance poll that makes SAML timing correct.
 *
 * This module restores autonomous handoff for APPROVED domains while
 * keeping unapproved domains safe from surprise pops. Consent is
 * per-eTLD+1 with a TTL, persisted to disk.
 *
 * See memory/feedback_proactive_handoff_ux.md and
 * memory/project_canvas_regression_2026_04_14.md.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────

export interface ConsentEntry {
  domain: string;       // eTLD+1, e.g. "uw.edu"
  grantedAt: string;    // ISO timestamp
  expiresAt: string;    // ISO timestamp
}

export interface ConsentStore {
  version: 1;
  entries: Record<string, ConsentEntry>; // keyed by eTLD+1
}

// ─── eTLD+1 extraction ──────────────────────────────────────

/**
 * Two-level public suffixes. Handcrafted MVP list (no tldts dep).
 * Covers Canvas (.edu), common CN/UK/AU/JP/HK institutional domains.
 * If a hostname ends with one of these, take THREE parts as eTLD+1;
 * otherwise TWO parts.
 */
const TWO_LEVEL_SUFFIXES = new Set([
  // United Kingdom
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'net.uk', 'ltd.uk', 'me.uk',
  // Australia
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  // China
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  // Japan
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  // Hong Kong
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk',
  // New Zealand
  'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'govt.nz',
  // Brazil
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  // India
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
]);

/**
 * Extract the eTLD+1 (registrable domain) from a URL or hostname.
 * Handles common two-level ccTLDs like .co.uk, .com.cn.
 * Returns the input (lowercased, port-stripped) for single-label
 * hosts like `localhost`.
 */
export function eTldPlusOne(urlOrHost: string): string {
  let host = urlOrHost.trim().toLowerCase();

  // If it looks like a URL, extract hostname via URL parser
  if (/^[a-z]+:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      // fall through and try literal parsing
    }
  }

  // Strip port, userinfo, path, trailing dot
  host = host.split('/')[0];
  host = host.split('@').pop()!;
  host = host.split(':')[0];
  host = host.replace(/\.+$/, '');

  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 1) return host;
  if (parts.length === 2) return host;

  const last2 = parts.slice(-2).join('.');
  if (TWO_LEVEL_SUFFIXES.has(last2) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return last2;
}

// ─── Store primitives ───────────────────────────────────────

export function emptyStore(): ConsentStore {
  return { version: 1, entries: {} };
}

/**
 * Read the consent store from disk.
 * Missing file or malformed JSON → empty store (never throws).
 */
export function readConsent(filePath: string): ConsentStore {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.entries) {
      return parsed as ConsentStore;
    }
  } catch {
    // fall through to empty
  }
  return emptyStore();
}

/**
 * Atomic write: write to a sibling tmp file, then rename.
 * Prevents a crash mid-write from leaving a half-written consent file.
 */
export function writeConsent(filePath: string, store: ConsentStore): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, filePath);
}

// ─── grant / revoke / isApproved ────────────────────────────

const DEFAULT_TTL_DAYS = 30;

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Add a consent entry for the eTLD+1 of the given URL/hostname.
 * Returns a new store (does not mutate input).
 */
export function grant(
  store: ConsentStore,
  urlOrHost: string,
  ttlDays: number = DEFAULT_TTL_DAYS,
  now: Date = new Date(),
): ConsentStore {
  const domain = eTldPlusOne(urlOrHost);
  const entry: ConsentEntry = {
    domain,
    grantedAt: now.toISOString(),
    expiresAt: addDays(now, ttlDays).toISOString(),
  };
  return {
    version: 1,
    entries: { ...store.entries, [domain]: entry },
  };
}

/**
 * Remove the consent entry for the eTLD+1 of the given URL/hostname.
 * No-op if the domain wasn't approved.
 */
export function revoke(store: ConsentStore, urlOrHost: string): ConsentStore {
  const domain = eTldPlusOne(urlOrHost);
  if (!store.entries[domain]) return store;
  const next = { ...store.entries };
  delete next[domain];
  return { version: 1, entries: next };
}

/**
 * True iff the eTLD+1 of urlOrHost has an unexpired entry.
 * Optional `now` lets tests inject a reference time.
 */
export function isApproved(
  store: ConsentStore,
  urlOrHost: string,
  now: Date = new Date(),
): boolean {
  const domain = eTldPlusOne(urlOrHost);
  const entry = store.entries[domain];
  if (!entry) return false;
  return new Date(entry.expiresAt).getTime() > now.getTime();
}

/**
 * Drop expired entries. Useful to run on read or periodically.
 */
export function prune(store: ConsentStore, now: Date = new Date()): ConsentStore {
  const nowMs = now.getTime();
  const next: Record<string, ConsentEntry> = {};
  for (const [k, v] of Object.entries(store.entries)) {
    if (new Date(v.expiresAt).getTime() > nowMs) next[k] = v;
  }
  return { version: 1, entries: next };
}

// ─── Default storage path ───────────────────────────────────

/**
 * Canonical on-disk location: ~/.nightcrawl/state/handoff-consent.json.
 * Callers may override via explicit filePath for tests.
 */
export function defaultConsentPath(): string {
  const home = process.env.HOME || '/tmp';
  return path.join(home, '.nightcrawl', 'state', 'handoff-consent.json');
}
