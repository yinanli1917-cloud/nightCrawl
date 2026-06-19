/**
 * [INPUT]: Depends on profile-store (the vault) and field-matcher (PROFILE_KEYS).
 * [OUTPUT]: Exports handleProfileCommand — the `profile` meta command.
 * [POS]: C2 CLI surface for managing the local non-secret autofill profile.
 *        Touches no page; only local state. Rejects any non-allowlisted key.
 */

import { setField, getField, clearField, clearAll, listFields, isProfileKey } from './profile-store';
import { PROFILE_KEYS, type ProfileKey } from './field-matcher';

export function handleProfileCommand(args: string[]): string {
  const sub = (args[0] || '').toLowerCase();
  switch (sub) {
    case 'set': {
      const key = args[1];
      const value = args.slice(2).join(' ');
      if (!key || !value) return 'Usage: profile set <key> <value>';
      try {
        setField(key as ProfileKey, value);
      } catch (e: any) {
        return e?.message ?? String(e);
      }
      return `Set ${key}.`;
    }
    case 'get': {
      const key = args[1];
      if (!key) return 'Usage: profile get <key>';
      const v = getField(key as ProfileKey);
      return v == null ? `(${key} not set)` : `${key}: ${v}`;
    }
    case 'list': {
      const fields = listFields();
      const keys = Object.keys(fields);
      if (!keys.length) return 'Profile is empty. Set fields with: profile set <key> <value>';
      return keys.map((k) => `${k}: ${fields[k as ProfileKey]}`).join('\n');
    }
    case 'clear': {
      const key = args[1];
      if (key) {
        if (!isProfileKey(key)) return `Unknown field: ${key}`;
        clearField(key);
        return `Cleared ${key}.`;
      }
      clearAll();
      return 'Profile cleared.';
    }
    default:
      return `Usage: profile set <key> <value> | get <key> | list | clear [key]\n` +
        `Non-secret keys: ${PROFILE_KEYS.join(', ')}\n` +
        `(nightCrawl never stores passwords — saved logins stay in your real browser.)`;
  }
}
