/**
 * Fingerprint-pinned domain classifier.
 *
 * Detects domains whose bot-management vendor (Cloudflare, Akamai, DataDome,
 * Kasada, Imperva/Incapsula, PerimeterX) pins session cookies to the TLS/
 * fingerprint that solved the challenge. For those domains, cookie import
 * from another browser (e.g. Arc) is STRUCTURALLY USELESS — the replayed
 * cookies fail at the edge before reaching the origin.
 *
 * Classification is automatic and by response-header sniffing, not by a
 * hand-maintained allowlist. The cache is persisted to disk so subsequent
 * daemon runs know to skip the doomed Arc-cookie-polling step.
 *
 * [INPUT]: Response headers from each navigation
 * [OUTPUT]: isPinned(url), markPinnedFromHeaders(url, headers),
 *          pinnedVendor(url), prunePinned()
 * [POS]: UX optimization layer between browser-manager response hook and
 *        browser-handoff autoHandover logic.
 */

import * as fs from 'fs';
import * as path from 'path';
import { eTldPlusOne } from './handoff-consent';

// ─── Config ───────────────────────────────────────────────

const STATE_FILE = path.join(
  process.env.HOME || '/tmp',
  '.nightcrawl',
  'state',
  'fingerprint-pinned.json',
);

// Entries older than this are re-verified on next visit. Vendors can change;
// a domain might migrate off CF. 30 days keeps the cache fresh without
// forcing re-classification every session.
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Vendor Detection ─────────────────────────────────────

/**
 * Vendors known to pin sessions to TLS/browser fingerprint.
 * Add new entries here as we encounter them in the wild.
 */
export type PinVendor =
  | 'cloudflare'
  | 'akamai'
  | 'datadome'
  | 'kasada'
  | 'imperva'
  | 'perimeterx';

/**
 * Sniff vendor from a response-headers bag. Returns null for anything we
 * don't positively identify — we'd rather miss a pin than falsely brand
 * a friendly site as hostile.
 *
 * CRITICAL DISTINCTION: A site being behind Cloudflare/Akamai does NOT
 * mean its sessions are fingerprint-pinned. Most CF customers use CF for
 * CDN/DDoS only; their login cookies port fine between browsers. We only
 * want to flag sites that are actively running bot-management challenges
 * (Turnstile, Akamai Bot Manager, etc.) — those are the ones that pin.
 *
 * So we look for ACTIVE-CHALLENGE signals, not vendor-presence signals.
 */
export function sniffVendor(
  headers: Record<string, string>,
): PinVendor | null {
  const h = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );

  // Cloudflare: `cf-mitigated` is set ONLY when CF's bot-management
  // actively challenged/blocked the request. `cf-ray` alone is not enough —
  // every CF-edged response carries it, including pure CDN customers.
  if (h['cf-mitigated']) return 'cloudflare';

  // DataDome: x-datadome / x-dd-* headers appear only on challenges.
  if (h['x-datadome'] || h['x-dd-b']) return 'datadome';

  // Kasada: x-kpsdk-* headers are challenge-only.
  if (h['x-kpsdk-ct'] || h['x-kpsdk-v']) return 'kasada';

  // PerimeterX / HUMAN Security: x-px-* headers appear only on challenges.
  if (h['x-px-ref'] || h['x-px-action'] || h['x-px-backend-response'])
    return 'perimeterx';

  // Imperva/Incapsula: x-iinfo appears on a wide range of responses, not
  // only challenges — it's too noisy to trigger pinning alone.
  // Akamai: x-akamai-transformed appears on all Akamai-delivered pages.
  // Both cases need observational confirmation (markPinnedObserved) rather
  // than header sniffing. Return null here and let the handoff flow mark
  // them after Arc cookie import actually fails to clear the wall.
  return null;
}

// ─── Persistence ──────────────────────────────────────────

interface PinnedEntry {
  domain: string;
  vendor: PinVendor;
  firstSeen: number;
  lastSeen: number;
}

interface PinnedStore {
  version: 1;
  entries: Record<string, PinnedEntry>;
}

function emptyStore(): PinnedStore {
  return { version: 1, entries: {} };
}

function loadStore(): PinnedStore {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && parsed.entries) return parsed;
  } catch {}
  return emptyStore();
}

function saveStore(store: PinnedStore): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(store, null, 2));
  } catch {}
}

// ─── Public API ───────────────────────────────────────────

/**
 * Check if a URL's eTLD+1 is known to pin sessions to fingerprint.
 * Returns false on malformed URLs (fail-open — don't falsely block
 * Arc-import on domains we can't parse).
 */
export function isPinned(url: string): boolean {
  try {
    const domain = eTldPlusOne(url);
    const store = loadStore();
    const entry = store.entries[domain];
    if (!entry) return false;
    if (Date.now() - entry.lastSeen > ENTRY_TTL_MS) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the pinning vendor for a URL, or null if not pinned.
 */
export function pinnedVendor(url: string): PinVendor | null {
  try {
    const domain = eTldPlusOne(url);
    const store = loadStore();
    const entry = store.entries[domain];
    if (!entry) return null;
    if (Date.now() - entry.lastSeen > ENTRY_TTL_MS) return null;
    return entry.vendor;
  } catch {
    return null;
  }
}

/**
 * Inspect response headers and, if they match a fingerprint-pinning vendor,
 * record the URL's eTLD+1 in the pinned store. Best-effort — never throws.
 *
 * Called from the response event in browser-manager.wirePageEvents.
 */
export function markPinnedFromHeaders(
  url: string,
  headers: Record<string, string>,
): void {
  try {
    const vendor = sniffVendor(headers);
    if (!vendor) return;
    const domain = eTldPlusOne(url);
    if (!domain) return;
    const store = loadStore();
    const now = Date.now();
    const existing = store.entries[domain];
    store.entries[domain] = {
      domain,
      vendor,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    };
    saveStore(store);
  } catch {}
}

/**
 * Mark a domain as pinned based on OBSERVED behavior — specifically,
 * the handoff flow importing fresh cookies from the user's default
 * browser and finding that the login wall is still present after
 * re-navigation. That's the empirical definition of a fingerprint-
 * pinned session: the cookies are valid but the edge rejects them.
 *
 * vendor='cloudflare' is the common case but we accept the full set
 * so Akamai/Imperva observations can be tagged correctly when detected
 * by context (URL patterns, etc.).
 */
export function markPinnedObserved(url: string, vendor: PinVendor): void {
  try {
    const domain = eTldPlusOne(url);
    if (!domain) return;
    const store = loadStore();
    const now = Date.now();
    const existing = store.entries[domain];
    store.entries[domain] = {
      domain,
      vendor,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    };
    saveStore(store);
  } catch {}
}

/**
 * Drop expired entries. Called opportunistically; no scheduled job needed.
 */
export function prunePinned(): void {
  try {
    const store = loadStore();
    const now = Date.now();
    let changed = false;
    for (const [domain, entry] of Object.entries(store.entries)) {
      if (now - entry.lastSeen > ENTRY_TTL_MS) {
        delete store.entries[domain];
        changed = true;
      }
    }
    if (changed) saveStore(store);
  } catch {}
}

/**
 * Debug helper — list all pinned entries. Not wired to any CLI command
 * yet; useful for ad-hoc inspection via `bun -e`.
 */
export function listPinned(): PinnedEntry[] {
  const store = loadStore();
  return Object.values(store.entries);
}
