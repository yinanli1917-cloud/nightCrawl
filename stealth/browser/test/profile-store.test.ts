/**
 * [INPUT]: Depends on profile-store.ts (local non-secret profile vault).
 * [OUTPUT]: Verifies set/get/clear round-trip, allowlist rejection of unknown
 *           and secret keys, malformed-JSON resilience, atomic write, mode 0600.
 * [POS]: C2 autofill storage test. The vault holds ONLY non-secret data; this
 *        proves the allowlist can never admit a password/credential key.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-profile-'));
process.env.NIGHTCRAWL_PROFILE_FILE = path.join(TMP, 'profile.json');

import {
  readProfile, setField, getField, clearField, clearAll, listFields, profilePath,
} from '../src/profile-store';

function reset() { try { fs.unlinkSync(profilePath()); } catch {} }

describe('profile-store', () => {
  beforeEach(reset);

  test('set then get round-trips a value', () => {
    setField('email', 'jane@example.com');
    expect(getField('email')).toBe('jane@example.com');
  });

  test('rejects unknown and secret keys (allowlist is the protection)', () => {
    expect(() => setField('password' as any, 'hunter2')).toThrow();
    expect(() => setField('ccNumber' as any, '4111')).toThrow();
    expect(() => setField('nonsense' as any, 'x')).toThrow();
    // The store never persisted any of the rejected writes.
    expect(Object.keys(listFields())).toHaveLength(0);
  });

  test('clearField removes one field, clearAll wipes everything', () => {
    setField('givenName', 'Jane');
    setField('familyName', 'Doe');
    clearField('givenName');
    expect(getField('givenName')).toBeUndefined();
    expect(getField('familyName')).toBe('Doe');
    clearAll();
    expect(Object.keys(listFields())).toHaveLength(0);
  });

  test('malformed JSON reads as empty (no throw)', () => {
    fs.writeFileSync(profilePath(), '{ not valid json');
    expect(readProfile().fields).toEqual({});
  });

  test('missing file reads as empty', () => {
    reset();
    expect(getField('email')).toBeUndefined();
  });

  test('write is atomic — no leftover .tmp', () => {
    setField('city', 'Seattle');
    expect(fs.existsSync(profilePath())).toBe(true);
    expect(fs.existsSync(profilePath() + '.tmp')).toBe(false);
  });

  test('file is written 0600 (PII must not be world-readable)', () => {
    setField('phone', '+1 555 0100');
    expect(fs.statSync(profilePath()).mode & 0o777).toBe(0o600);
  });
});
