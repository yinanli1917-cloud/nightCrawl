/**
 * [INPUT]: Depends on fs + field-matcher (ProfileKey, PROFILE_KEYS allowlist).
 * [OUTPUT]: Exports ProfileStore, readProfile, writeProfile, setField, getField,
 *           clearField, clearAll, listFields, isProfileKey, profilePath.
 * [POS]: C2 autofill storage — the local, user-populated, NON-SECRET profile
 *        vault. Modeled on handoff-consent.ts (atomic write, never-throw read).
 *
 * Privacy: this vault holds ONLY non-secret data (name/email/phone/address). The
 * PROFILE_KEYS allowlist IS the protection — a password/credential key can never
 * be stored because it isn't in the schema. nightCrawl still never reads the
 * browser's password DB; real credentials stay with the browser (see C1).
 *
 * Location is per-USER (not per-project): ~/.nightcrawl/state/profile.json, so
 * the profile follows the user across projects. Overridable via
 * NIGHTCRAWL_PROFILE_FILE (used by tests).
 */

import * as fs from 'fs';
import * as path from 'path';
import { type ProfileKey, PROFILE_KEYS } from './field-matcher';

export interface ProfileStore {
  version: 1;
  fields: Partial<Record<ProfileKey, string>>;
  updatedAt: string;
}

const KNOWN = new Set<string>(PROFILE_KEYS);

// ─── Path ──────────────────────────────────────────────────

export function profilePath(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.NIGHTCRAWL_PROFILE_FILE) return env.NIGHTCRAWL_PROFILE_FILE;
  const home = env.HOME || process.env.HOME || '/tmp';
  return path.join(home, '.nightcrawl', 'state', 'profile.json');
}

// ─── Persistence ───────────────────────────────────────────

function emptyProfile(): ProfileStore {
  return { version: 1, fields: {}, updatedAt: '' };
}

/** Read the vault. Malformed/missing → empty. Never throws. */
export function readProfile(
  env: Record<string, string | undefined> = process.env,
): ProfileStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath(env), 'utf-8'));
    if (parsed?.version === 1 && parsed.fields && typeof parsed.fields === 'object') {
      return { version: 1, fields: parsed.fields, updatedAt: parsed.updatedAt || '' };
    }
  } catch {}
  return emptyProfile();
}

/** Atomic write, mode 0600 (PII must not be world-readable). */
export function writeProfile(
  store: ProfileStore,
  env: Record<string, string | undefined> = process.env,
): void {
  const dest = profilePath(env);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...store, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, dest);
}

// ─── Public API ────────────────────────────────────────────

export function isProfileKey(key: string): key is ProfileKey {
  return KNOWN.has(key);
}

export function getField(
  key: ProfileKey,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return readProfile(env).fields[key];
}

export function listFields(
  env: Record<string, string | undefined> = process.env,
): Partial<Record<ProfileKey, string>> {
  return readProfile(env).fields;
}

/**
 * Set a non-secret profile field. Throws on any key not in the allowlist — this
 * is the bright line that keeps passwords/cards/secrets out of the vault.
 */
export function setField(
  key: ProfileKey,
  value: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!isProfileKey(key)) {
    throw new Error(
      `'${key}' is not a profile field. nightCrawl stores only non-secret data ` +
      `(${PROFILE_KEYS.join(', ')}); it never stores passwords or card numbers.`,
    );
  }
  const store = readProfile(env);
  store.fields[key] = value;
  writeProfile(store, env);
}

export function clearField(
  key: ProfileKey,
  env: Record<string, string | undefined> = process.env,
): void {
  const store = readProfile(env);
  delete store.fields[key];
  writeProfile(store, env);
}

export function clearAll(
  env: Record<string, string | undefined> = process.env,
): void {
  writeProfile(emptyProfile(), env);
}
