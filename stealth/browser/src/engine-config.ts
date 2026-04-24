/**
 * [INPUT]: Environment variables BROWSE_FINGERPRINT_SEED, BROWSE_HUMANIZE;
 *          persistent seed at ~/.nightcrawl/state/engine-seed.json
 * [OUTPUT]: Exports parseEngineConfig, EngineConfig type
 * [POS]: Configuration layer for browser engine selection within browser module
 *
 * CloakBrowser is the only engine. The stock Playwright path was removed
 * (see project memory `project_cloakbrowser_default_decision.md`) because
 * Chrome for Testing is detectable by every Tier-1+ bot-detection system.
 *
 * Fingerprint seed persistence is load-bearing: bot-managed sites (Cloudflare
 * Turnstile, DataDome, etc.) pin session cookies to the browser fingerprint
 * that solved the challenge. If the seed changes between headless sessions —
 * or between headless and headed handoff — cookies become invalid and the
 * user has to re-login every time. Persisting once per machine to
 * ~/.nightcrawl/state/engine-seed.json ensures every nightcrawl session on
 * this machine presents the same fingerprint.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Engine Config ─────────────────────────────────────────

export type BrowserEngine = 'cloakbrowser';

export interface EngineConfig {
  engine: BrowserEngine;
  fingerprintSeed?: number;
  humanize: boolean;
}

// Valid range per CloakBrowser docs: [10000, 99999].
const SEED_MIN = 10000;
const SEED_MAX = 99999;

const SEED_FILE = path.join(
  process.env.HOME || '/tmp',
  '.nightcrawl',
  'state',
  'engine-seed.json',
);

/**
 * Return a stable fingerprint seed for this machine. First call generates
 * and persists; subsequent calls (including from other processes) read
 * the same value. Safe under races — the worst case is two processes
 * both writing, last-write-wins, both agree on same seed afterwards.
 */
function getPersistentSeed(): number {
  try {
    const raw = fs.readFileSync(SEED_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.seed === 'number' &&
      Number.isInteger(parsed.seed) &&
      parsed.seed >= SEED_MIN &&
      parsed.seed <= SEED_MAX
    ) return parsed.seed;
  } catch {}

  const seed = Math.floor(SEED_MIN + Math.random() * (SEED_MAX - SEED_MIN + 1));
  try {
    fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
    fs.writeFileSync(SEED_FILE, JSON.stringify({ seed, generatedAt: Date.now() }));
  } catch {}
  return seed;
}

/**
 * Parse engine-related env vars into a typed config.
 * Invalid values fall back to safe defaults.
 *
 * Seed resolution order:
 *   1. BROWSE_FINGERPRINT_SEED env var (explicit override)
 *   2. ~/.nightcrawl/state/engine-seed.json (persistent per-machine)
 *   3. Generate and persist a new one
 */
export function parseEngineConfig(
  env: Record<string, string | undefined> = process.env,
): EngineConfig {
  const rawSeed = env.BROWSE_FINGERPRINT_SEED;
  const parsedSeed = rawSeed ? parseInt(rawSeed, 10) : NaN;
  const fingerprintSeed = Number.isFinite(parsedSeed)
    ? parsedSeed
    : getPersistentSeed();

  const humanize = env.BROWSE_HUMANIZE === '1';

  return { engine: 'cloakbrowser', fingerprintSeed, humanize };
}
