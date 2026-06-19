/**
 * [INPUT]: Depends on field-matcher.ts (pure form-field → profile-key mapping).
 * [OUTPUT]: Verifies the autocomplete-first cascade, the name/placeholder/type
 *           fallbacks, and — critically — that secret fields (password, card,
 *           cvv, ssn, otp) NEVER match a profile key.
 * [POS]: C2 autofill core. Pure logic, the highest-value test surface — autofill
 *        must never put data into a credential/payment field.
 */

import { describe, test, expect } from 'bun:test';
import {
  matchField,
  matchFields,
  PROFILE_KEYS,
  type AutofillField,
} from '../src/field-matcher';

function f(over: Partial<AutofillField>): AutofillField {
  return { tag: 'input', type: 'text', ...over };
}

describe('field-matcher — autocomplete tokens (gold standard)', () => {
  test('maps core tokens to profile keys with autocomplete confidence', () => {
    expect(matchField(f({ autocomplete: 'given-name' }))).toEqual({ profileKey: 'givenName', confidence: 'autocomplete' });
    expect(matchField(f({ autocomplete: 'family-name' }))?.profileKey).toBe('familyName');
    expect(matchField(f({ autocomplete: 'email' }))?.profileKey).toBe('email');
    expect(matchField(f({ autocomplete: 'tel' }))?.profileKey).toBe('phone');
    expect(matchField(f({ autocomplete: 'postal-code' }))?.profileKey).toBe('postalCode');
    expect(matchField(f({ autocomplete: 'street-address' }))?.profileKey).toBe('streetAddress');
  });

  test('strips section-* / shipping / billing prefixes', () => {
    expect(matchField(f({ autocomplete: 'shipping street-address' }))?.profileKey).toBe('streetAddress');
    expect(matchField(f({ autocomplete: 'billing postal-code' }))?.profileKey).toBe('postalCode');
    expect(matchField(f({ autocomplete: 'section-blue shipping email' }))?.profileKey).toBe('email');
  });

  test('credential/payment autocomplete tokens are explicitly skipped (null)', () => {
    expect(matchField(f({ autocomplete: 'cc-number' }))).toBeNull();
    expect(matchField(f({ autocomplete: 'new-password' }))).toBeNull();
    expect(matchField(f({ autocomplete: 'current-password' }))).toBeNull();
    expect(matchField(f({ autocomplete: 'one-time-code' }))).toBeNull();
  });
});

describe('field-matcher — name/id, placeholder, type fallbacks', () => {
  test('name/id keyword match (no autocomplete) has name confidence', () => {
    expect(matchField(f({ name: 'firstName' }))).toEqual({ profileKey: 'givenName', confidence: 'name' });
    expect(matchField(f({ name: 'lastName' }))?.profileKey).toBe('familyName');
    expect(matchField(f({ id: 'email_addr' }))?.profileKey).toBe('email');
    expect(matchField(f({ name: 'phone' }))?.profileKey).toBe('phone');
    expect(matchField(f({ name: 'zip' }))?.profileKey).toBe('postalCode');
    expect(matchField(f({ name: 'city' }))?.profileKey).toBe('city');
  });

  test('placeholder / aria-label match has placeholder confidence', () => {
    expect(matchField(f({ placeholder: 'Email address' }))).toEqual({ profileKey: 'email', confidence: 'placeholder' });
    expect(matchField(f({ ariaLabel: 'Phone number' }))?.profileKey).toBe('phone');
  });

  test('input type is the last resort for email/tel only', () => {
    expect(matchField(f({ type: 'email' }))).toEqual({ profileKey: 'email', confidence: 'type' });
    expect(matchField(f({ type: 'tel' }))?.profileKey).toBe('phone');
    expect(matchField(f({ type: 'text' }))).toBeNull(); // no signal → no guess
  });
});

describe('field-matcher — SECRET FIELDS NEVER MATCH (adversarial)', () => {
  test('password-type fields always return null, even with a friendly name', () => {
    expect(matchField(f({ type: 'password' }))).toBeNull();
    expect(matchField(f({ type: 'password', name: 'email' }))).toBeNull();
    expect(matchField(f({ type: 'password', autocomplete: 'email' }))).toBeNull();
  });

  test('card / cvv / ssn / otp / token fields return null even with weak keywords', () => {
    expect(matchField(f({ name: 'card_number' }))).toBeNull();
    expect(matchField(f({ name: 'cardNumber' }))).toBeNull();
    expect(matchField(f({ name: 'cvv' }))).toBeNull();
    expect(matchField(f({ name: 'cvc' }))).toBeNull();
    expect(matchField(f({ name: 'ssn' }))).toBeNull();
    expect(matchField(f({ name: 'social_security' }))).toBeNull();
    expect(matchField(f({ name: 'passport_no' }))).toBeNull();
    expect(matchField(f({ name: 'otp' }))).toBeNull();
    expect(matchField(f({ name: 'one_time_code' }))).toBeNull();
    expect(matchField(f({ id: 'api_token' }))).toBeNull();
  });
});

describe('field-matcher — matchFields against a populated profile', () => {
  const profile = { givenName: 'Jane', familyName: 'Doe', email: 'jane@example.com', country: 'United States', countryCode: 'US' };

  test('resolves profile values and reports each field', () => {
    const results = matchFields(
      [f({ autocomplete: 'given-name' }), f({ autocomplete: 'email' }), f({ name: 'referral' })],
      profile,
    );
    expect(results[0].profileValue).toBe('Jane');
    expect(results[1].profileValue).toBe('jane@example.com');
    expect(results[2].skip).toBe('no-match');
  });

  test('skips a field with no profile value', () => {
    const results = matchFields([f({ autocomplete: 'tel' })], profile);
    expect(results[0].skip).toBe('no-profile-value');
  });

  test('skips already-filled fields unless includeFilled', () => {
    const filled = f({ autocomplete: 'email', value: 'old@x.com' });
    expect(matchFields([filled], profile)[0].skip).toBe('already-filled');
    expect(matchFields([filled], profile, { includeFilled: true })[0].profileValue).toBe('jane@example.com');
  });

  test('select country fuzzy-matches an option value', () => {
    const sel = f({ tag: 'select', name: 'country', options: [{ value: 'US', text: 'United States' }, { value: 'CA', text: 'Canada' }] });
    const r = matchFields([sel], profile)[0];
    // countryCode 'US' resolves to the matching option value.
    expect(r.profileValue).toBe('US');
  });

  test('never fills a password field via matchFields', () => {
    const r = matchFields([f({ type: 'password', name: 'password', autocomplete: 'current-password' })], { ...profile });
    expect(r[0].skip).toBe('no-match');
    expect(r[0].profileValue).toBeUndefined();
  });
});

describe('field-matcher — schema', () => {
  test('PROFILE_KEYS excludes any secret/credential keys', () => {
    for (const bad of ['password', 'ccNumber', 'cc-number', 'cvv', 'ssn']) {
      expect(PROFILE_KEYS).not.toContain(bad as any);
    }
    expect(PROFILE_KEYS).toContain('email');
    expect(PROFILE_KEYS).toContain('givenName');
  });
});
