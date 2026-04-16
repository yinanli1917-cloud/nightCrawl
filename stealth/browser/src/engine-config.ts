/**
 * [INPUT]: Environment variables BROWSE_ENGINE, BROWSE_FINGERPRINT_SEED, BROWSE_HUMANIZE
 * [OUTPUT]: Exports parseEngineConfig, EngineConfig type
 * [POS]: Configuration layer for browser engine selection within browser module
 */

// ─── Engine Config ─────────────────────────────────────────

export type BrowserEngine = 'playwright' | 'cloakbrowser';

export interface EngineConfig {
  engine: BrowserEngine;
  fingerprintSeed?: number;
  humanize: boolean;
}

const VALID_ENGINES: ReadonlySet<string> = new Set(['playwright', 'cloakbrowser']);

/**
 * Parse engine-related env vars into a typed config.
 * Invalid values fall back to safe defaults.
 */
export function parseEngineConfig(
  env: Record<string, string | undefined> = process.env,
): EngineConfig {
  const rawEngine = env.BROWSE_ENGINE || 'cloakbrowser';
  const engine: BrowserEngine = VALID_ENGINES.has(rawEngine)
    ? (rawEngine as BrowserEngine)
    : 'cloakbrowser';

  const rawSeed = env.BROWSE_FINGERPRINT_SEED;
  const parsedSeed = rawSeed ? parseInt(rawSeed, 10) : NaN;
  const fingerprintSeed = Number.isFinite(parsedSeed) ? parsedSeed : undefined;

  const humanize = env.BROWSE_HUMANIZE === '1';

  return { engine, fingerprintSeed, humanize };
}
