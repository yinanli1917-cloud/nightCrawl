/**
 * [INPUT]: Identity name string, base directory path
 * [OUTPUT]: Exports getOrCreateSeed, listIdentities, deleteIdentity
 * [POS]: Fingerprint identity persistence within browser module
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

// ─── Seed Range ────────────────────────────────────────────
// CloakBrowser uses 5-digit seeds (10000-99999) for deterministic fingerprints.
const SEED_MIN = 10000;
const SEED_MAX = 99999;

/**
 * Default identities directory: ~/.nightcrawl/identities/
 */
export function defaultIdentitiesDir(): string {
  return path.join(process.env.HOME || '/tmp', '.nightcrawl', 'identities');
}

/**
 * Derive a deterministic seed from an identity name.
 * Uses SHA-256 hash to map name -> number in [10000, 99999].
 */
function deriveSeed(name: string): number {
  const hash = createHash('sha256').update(name).digest();
  const raw = hash.readUInt32BE(0);
  return SEED_MIN + (raw % (SEED_MAX - SEED_MIN + 1));
}

/**
 * Get or create a fingerprint seed for the given identity.
 * Persists to disk so the same identity always gets the same seed.
 */
export function getOrCreateSeed(
  identityName: string,
  baseDir: string = defaultIdentitiesDir(),
): number {
  fs.mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, `${identityName}.json`);

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (typeof data.seed === 'number') return data.seed;
  } catch {}

  const seed = deriveSeed(identityName);
  fs.writeFileSync(filePath, JSON.stringify({ seed, created: new Date().toISOString() }), 'utf-8');
  return seed;
}

/**
 * List all stored identity names.
 */
export function listIdentities(baseDir: string = defaultIdentitiesDir()): string[] {
  try {
    return fs.readdirSync(baseDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/**
 * Delete a stored identity. No-op if it doesn't exist.
 */
export function deleteIdentity(
  identityName: string,
  baseDir: string = defaultIdentitiesDir(),
): void {
  const filePath = path.join(baseDir, `${identityName}.json`);
  try {
    fs.unlinkSync(filePath);
  } catch {}
}
