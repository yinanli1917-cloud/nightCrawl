/**
 * [INPUT]: Depends on config.resolveConfig (stateDir) and handoff-consent.eTldPlusOne.
 * [OUTPUT]: Exports rememberedEngine, recordWin, pruneStrategy, listStrategy,
 *           strategyFilePath, and the Engine type.
 * [POS]: Per-domain engine memory. ADVICE only — it feeds the recommendation
 *        the agent sees (strategy-advisor.ts); it never switches engines on its
 *        own. The agent decides; this is one input to that decision.
 *
 * Modeled on fingerprint-pinned.ts (same shape the codebase already trusts), but
 * keyed in the per-project stateDir (BROWSE_STATE_FILE-isolatable) rather than a
 * hardcoded HOME path, so each daemon/test owns its own memory.
 *
 * Semantics: records the LAST engine that succeeded for a domain. We deliberately
 * follow the latest winner rather than pinning monotonically — headless is the
 * preferred (background, cheap) engine, so if it starts working again on a domain
 * that once needed the real browser, we want the memory to drift back to headless.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveConfig } from './config';
import { eTldPlusOne } from './handoff-consent';

// ─── Types ─────────────────────────────────────────────────

export type Engine = 'headless' | 'real';

interface StrategyEntry {
  domain: string;
  engine: Engine;
  lastWin: number;
  wins: number;
}

interface StrategyStore {
  version: 1;
  entries: Record<string, StrategyEntry>;
}

// Same 30-day freshness window the other stores use. A site's bot posture can
// change; we'd rather re-learn than trust a stale engine choice forever.
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Paths ─────────────────────────────────────────────────

export function strategyFilePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveConfig(env).stateDir, 'domain-strategy.json');
}

// ─── Persistence ───────────────────────────────────────────

function emptyStore(): StrategyStore {
  return { version: 1, entries: {} };
}

function loadStore(): StrategyStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(strategyFilePath(), 'utf-8'));
    if (parsed?.version === 1 && parsed.entries) return parsed;
  } catch {}
  return emptyStore();
}

function saveStore(store: StrategyStore): void {
  try {
    const dest = strategyFilePath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch {}
}

// ─── Public API ────────────────────────────────────────────

/**
 * The engine that last succeeded for this URL's eTLD+1, or null if unknown or
 * stale. Fail-open (null) on malformed URLs — an unparseable domain is just
 * "no memory", never a hard error.
 */
export function rememberedEngine(url: string): Engine | null {
  try {
    const domain = eTldPlusOne(url);
    if (!domain) return null;
    const entry = loadStore().entries[domain];
    if (!entry) return null;
    if (Date.now() - entry.lastWin > ENTRY_TTL_MS) return null;
    return entry.engine;
  } catch {
    return null;
  }
}

/**
 * Record that `engine` successfully completed work on this URL's domain.
 * Bumps the win count on a repeat of the same engine; resets it to 1 when the
 * winning engine changes (so wins always reflect consecutive same-engine wins).
 */
export function recordWin(url: string, engine: Engine): void {
  try {
    const domain = eTldPlusOne(url);
    if (!domain) return;
    const store = loadStore();
    const existing = store.entries[domain];
    const wins = existing && existing.engine === engine ? existing.wins + 1 : 1;
    store.entries[domain] = { domain, engine, lastWin: Date.now(), wins };
    saveStore(store);
  } catch {}
}

/** Drop expired entries. Opportunistic — no scheduled job required. */
export function pruneStrategy(): void {
  try {
    const store = loadStore();
    const now = Date.now();
    let changed = false;
    for (const [domain, entry] of Object.entries(store.entries)) {
      if (now - entry.lastWin > ENTRY_TTL_MS) {
        delete store.entries[domain];
        changed = true;
      }
    }
    if (changed) saveStore(store);
  } catch {}
}

/** All entries (debug / status surface). */
export function listStrategy(): StrategyEntry[] {
  return Object.values(loadStore().entries);
}
