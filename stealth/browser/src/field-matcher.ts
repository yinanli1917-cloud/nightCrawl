/**
 * [INPUT]: None — pure logic over plain field descriptors (the shape `forms`
 *          already produces, plus autocomplete + ariaLabel).
 * [OUTPUT]: Exports ProfileKey, PROFILE_KEYS, AutofillField, FieldMatch,
 *           FieldMatchResult, AUTOCOMPLETE_MAP, matchField, matchFields.
 * [POS]: C2 autofill core. Maps a discovered form field to a NON-SECRET profile
 *        key. This module is also the schema owner (ProfileKey) so the I/O store
 *        (profile-store.ts) depends on it, never the reverse.
 *
 * Safety invariant: a credential/payment/identity-secret field (password, card,
 * cvv, ssn, passport, otp, token) must ALWAYS return null. autofill only ever
 * touches non-secret profile data; the vault has no key for secrets, and even a
 * misleading name/label can never route a secret field to a value.
 */

// ─── Schema (the profile vault's non-secret keys) ───────────

export type ProfileKey =
  | 'fullName' | 'givenName' | 'additionalName' | 'familyName'
  | 'email' | 'phone'
  | 'organization' | 'jobTitle'
  | 'streetAddress' | 'addressLine1' | 'addressLine2'
  | 'city' | 'state' | 'postalCode' | 'country' | 'countryCode'
  | 'url' | 'username' | 'birthday';

export const PROFILE_KEYS: readonly ProfileKey[] = [
  'fullName', 'givenName', 'additionalName', 'familyName',
  'email', 'phone', 'organization', 'jobTitle',
  'streetAddress', 'addressLine1', 'addressLine2',
  'city', 'state', 'postalCode', 'country', 'countryCode',
  'url', 'username', 'birthday',
];

// ─── Field descriptor ───────────────────────────────────────

export interface AutofillField {
  tag: string;                 // 'input' | 'select' | 'textarea'
  type?: string;               // input type (text, email, password, …)
  name?: string;
  id?: string;
  placeholder?: string;
  autocomplete?: string;
  ariaLabel?: string;
  required?: boolean;
  value?: string;
  options?: { value: string; text: string }[];
}

export type MatchConfidence = 'autocomplete' | 'name' | 'placeholder' | 'type';

export interface FieldMatch {
  profileKey: ProfileKey;
  confidence: MatchConfidence;
}

export interface FieldMatchResult {
  field: AutofillField;
  match: FieldMatch | null;
  profileValue?: string;
  skip?: 'no-match' | 'no-profile-value' | 'already-filled' | 'no-option';
}

// ─── Secret-field guard (never autofill these) ──────────────

// Field input types we never write to.
const NON_FILLABLE_TYPES = new Set([
  'password', 'hidden', 'file', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio',
]);

// name/id/autocomplete tokens that mark a credential/payment/secret field.
const SECRET_RE = /\b(card|cc[-_ ]?num|cardnumber|cvv|cvc|csc|ssn|social[-_ ]?security|passport|secret|api[-_ ]?token|token|otp|2fa|one[-_ ]?time|password)\b/i;

// ─── Tier 1: autocomplete tokens ────────────────────────────

export const AUTOCOMPLETE_MAP: Record<string, ProfileKey> = {
  'name': 'fullName',
  'given-name': 'givenName',
  'additional-name': 'additionalName',
  'family-name': 'familyName',
  'email': 'email',
  'tel': 'phone',
  'tel-national': 'phone',
  'organization': 'organization',
  'organization-title': 'jobTitle',
  'street-address': 'streetAddress',
  'address-line1': 'addressLine1',
  'address-line2': 'addressLine2',
  'address-level2': 'city',
  'address-level1': 'state',
  'postal-code': 'postalCode',
  'country-name': 'country',
  'country': 'countryCode',
  'url': 'url',
  'username': 'username',
  'bday': 'birthday',
};

// Strip section-*, shipping/billing scope prefixes; return the base token.
function baseAutocompleteToken(ac: string): string {
  return ac
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('section-') && t !== 'shipping' && t !== 'billing' && t !== 'home' && t !== 'work')
    .pop() || '';
}

// ─── Tier 2/3: keyword regex table ──────────────────────────

const KEYWORD_RULES: { re: RegExp; key: ProfileKey }[] = [
  { re: /\bfull[-_ ]?name\b/, key: 'fullName' },
  { re: /\b(first[-_ ]?name|fname|given[-_ ]?name|givenname|firstname)\b/, key: 'givenName' },
  { re: /\b(last[-_ ]?name|lname|surname|family[-_ ]?name|lastname)\b/, key: 'familyName' },
  { re: /\b(e[-_ ]?mail|email[-_ ]?addr(ess)?|emailaddr)\b/, key: 'email' },
  { re: /\b(phone|tel|mobile|cell)\b/, key: 'phone' },
  { re: /\b(company|organization|organisation|org)\b/, key: 'organization' },
  { re: /\b(job[-_ ]?title|title)\b/, key: 'jobTitle' },
  { re: /\b(address[-_ ]?line[-_ ]?2|addr2|apt|suite|unit)\b/, key: 'addressLine2' },
  { re: /\b(street[-_ ]?address|address[-_ ]?line[-_ ]?1|addr1|street)\b/, key: 'addressLine1' },
  { re: /\b(city|town|locality)\b/, key: 'city' },
  { re: /\b(state|province|region)\b/, key: 'state' },
  { re: /\b(zip|postal|postcode|post[-_ ]?code)\b/, key: 'postalCode' },
  { re: /\b(country)\b/, key: 'country' },
  { re: /\b(user[-_ ]?name|username)\b/, key: 'username' },
];

function keywordMatch(hint: string): ProfileKey | null {
  for (const { re, key } of KEYWORD_RULES) if (re.test(hint)) return key;
  return null;
}

// ─── Public: single-field match ─────────────────────────────

/**
 * Map one field to a profile key, or null if it has no clear non-secret meaning
 * (or is a secret/non-fillable field). Cascade by descending trust:
 * autocomplete → name/id → placeholder/aria → input type.
 */
export function matchField(field: AutofillField): FieldMatch | null {
  const type = (field.type || '').toLowerCase();
  if (NON_FILLABLE_TYPES.has(type)) return null;

  const nameId = `${field.name || ''} ${field.id || ''}`.toLowerCase();
  const ac = (field.autocomplete || '').toLowerCase();
  // Any whiff of a secret in the identifying attributes → refuse outright.
  if (SECRET_RE.test(nameId) || SECRET_RE.test(ac)) return null;

  // Tier 1: autocomplete token.
  if (ac) {
    const base = baseAutocompleteToken(ac);
    if (base in AUTOCOMPLETE_MAP) return { profileKey: AUTOCOMPLETE_MAP[base], confidence: 'autocomplete' };
  }

  // Tier 2: name/id keyword.
  const byName = keywordMatch(nameId);
  if (byName) return { profileKey: resolveCountryKey(byName, field), confidence: 'name' };

  // Tier 3: placeholder / aria-label keyword.
  const ph = `${field.placeholder || ''} ${field.ariaLabel || ''}`.toLowerCase();
  if (SECRET_RE.test(ph)) return null;
  const byPlaceholder = keywordMatch(ph);
  if (byPlaceholder) return { profileKey: resolveCountryKey(byPlaceholder, field), confidence: 'placeholder' };

  // Tier 4: unambiguous input type.
  if (type === 'email') return { profileKey: 'email', confidence: 'type' };
  if (type === 'tel') return { profileKey: 'phone', confidence: 'type' };

  return null;
}

// A <select> for country wants the code; a free-text input wants the full name.
function resolveCountryKey(key: ProfileKey, field: AutofillField): ProfileKey {
  if (key === 'country' && field.tag === 'select') return 'countryCode';
  return key;
}

// ─── Public: match a form against a profile ─────────────────

/**
 * Match every field against the stored profile, resolving the value to fill (and
 * the reason a field was skipped). For <select>, fuzzy-match the profile value to
 * an option and fill the option's value. Already-filled fields are skipped unless
 * includeFilled is set (autofill targets BLANK fields by default).
 */
export function matchFields(
  fields: AutofillField[],
  profile: Partial<Record<ProfileKey, string>>,
  opts: { includeFilled?: boolean } = {},
): FieldMatchResult[] {
  return fields.map((field) => {
    const match = matchField(field);
    if (!match) return { field, match: null, skip: 'no-match' };

    if (field.value && field.value.trim() && !opts.includeFilled) {
      return { field, match, skip: 'already-filled' };
    }

    const raw = profile[match.profileKey];
    if (raw == null || raw === '') return { field, match, skip: 'no-profile-value' };

    if (field.tag === 'select' && field.options && field.options.length) {
      const opt = selectOptionFor(raw, field.options);
      if (!opt) return { field, match, skip: 'no-option' };
      return { field, match, profileValue: opt };
    }

    return { field, match, profileValue: raw };
  });
}

// Case-insensitive contains match against an option's value or visible text.
function selectOptionFor(value: string, options: { value: string; text: string }[]): string | null {
  const v = value.toLowerCase();
  for (const o of options) {
    if (o.value.toLowerCase() === v || o.text.toLowerCase() === v) return o.value;
  }
  for (const o of options) {
    if (o.value.toLowerCase().includes(v) || o.text.toLowerCase().includes(v) || v.includes(o.text.toLowerCase())) {
      return o.value;
    }
  }
  return null;
}
