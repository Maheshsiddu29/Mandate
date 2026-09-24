/**
 * Canonical asset identifier schemes, and their validation (ADR 0005).
 *
 * The kernel holds `CanonicalAssetId { assetClass, idScheme, value }` and keeps
 * `value` opaque: it compares identifiers, it does not interpret them. This
 * module is where a scheme value is actually checked, because Phase 2 is where a
 * curator-supplied string first becomes a financial identity.
 *
 * Check digits are verified rather than stored. The cheaper option — accept
 * whatever string arrives — is what lets a one-character typo become a
 * *different canonical asset* that resolves to nothing, or worse, to something.
 * A check digit is the one piece of self-verification these identifier systems
 * give away for free, and declining to use it in a system whose premise is that
 * financial identity must be exact would be indefensible.
 *
 * No floating point and no `Math` arithmetic: the check-digit routines use exact
 * integer operations, and a structural test enforces that across this package.
 */

import {
  canonicalAssetIdEquals,
  err,
  ok,
  parseCanonicalAssetId,
  type CanonicalAssetId,
  type Result,
} from '@mandate/kernel';
import type { RegistryReasonCodeName } from './reason-codes.ts';

/**
 * The closed scheme vocabulary.
 *
 * FIGI is preferred where available: it is issued per security per venue and is
 * not reassigned. ISIN and CUSIP are accepted because they are the authorities
 * for instruments and asset classes FIGI coverage does not reach. Adding a
 * scheme is a deliberate code change with its own validator and tests.
 */
export const AssetIdScheme = {
  FIGI: 'figi',
  ISIN: 'isin',
  CUSIP: 'cusip',
} as const;
export type AssetIdScheme = (typeof AssetIdScheme)[keyof typeof AssetIdScheme];

/**
 * The closed asset-class vocabulary.
 *
 * Closed rather than free-form because `assetClass` is part of canonical
 * identity: a free-form identity field is how a phantom asset gets created, and
 * an unrecognized class is one whose applicable semantics the registry does not
 * know. Extending beyond equities is the point of the segment existing
 * (design section 23); doing so is a one-line change plus tests.
 */
export const AssetClass = {
  EQUITY: 'equity',
  FUND: 'fund',
  TREASURY: 'treasury',
  BOND: 'bond',
  COMMODITY: 'commodity',
} as const;
export type AssetClass = (typeof AssetClass)[keyof typeof AssetClass];

const SCHEMES = new Set<string>(Object.values(AssetIdScheme));
const CLASSES = new Set<string>(Object.values(AssetClass));

export function isAssetIdScheme(v: string): v is AssetIdScheme {
  return SCHEMES.has(v);
}

export function isAssetClass(v: string): v is AssetClass {
  return CLASSES.has(v);
}

// --- Check-digit primitives -------------------------------------------------

/** `0-9` -> 0..9, `A-Z` -> 10..35. Anything else returns -1. */
function ordinal(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 90) return code - 55;
  return -1;
}

/**
 * Sum of the decimal digits of `v`, for `0 <= v <= 99`.
 *
 * The doubled values these routines produce never exceed 70, so two digits is
 * the whole domain and the division below is exact integer arithmetic.
 */
function digitSum(v: number): number {
  const units = v % 10;
  return units + (v - units) / 10;
}

const UPPER_ALNUM = /^[0-9A-Z]+$/;

/**
 * FIGI, 12 characters (OpenFIGI).
 *
 * Positions are 1-based from the left. Position 3 is always `G`; positions 1-2
 * carry a prefix that must not be one of the reserved country-code-like values;
 * every other position is a consonant or a digit, because vowels are excluded
 * from the alphabet by construction. Position 12 is a modulus-10
 * double-add-double check digit over the first 11 characters.
 */
const FIGI_CONSONANTS = new Set('BCDFGHJKLMNPQRSTVWXYZ0123456789'.split(''));
const FIGI_RESERVED_PREFIXES = new Set(['BS', 'BM', 'GG', 'GB', 'GH', 'KY', 'VG']);

function figiCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < 11; i += 1) {
    const v = ordinal(body[i] as string);
    // Doubling applies at even 1-based positions, which over 11 characters is
    // the second-from-the-right and every other one moving left.
    sum += digitSum((i + 1) % 2 === 0 ? v * 2 : v);
  }
  return (10 - (sum % 10)) % 10;
}

function validateFigi(value: string): boolean {
  if (value.length !== 12 || !UPPER_ALNUM.test(value)) return false;
  if (value[2] !== 'G') return false;
  if (FIGI_RESERVED_PREFIXES.has(value.slice(0, 2))) return false;
  for (let i = 0; i < 11; i += 1) {
    if (i === 2) continue;
    if (!FIGI_CONSONANTS.has(value[i] as string)) return false;
  }
  const expected = figiCheckDigit(value.slice(0, 11));
  return ordinal(value[11] as string) === expected;
}

/**
 * ISIN, 12 characters (ISO 6166): two-letter country code, nine alphanumeric
 * characters, then a Luhn check digit computed over the body with every letter
 * expanded to its two-digit ordinal.
 */
function luhnCheckDigit(digits: string): number {
  let sum = 0;
  let double = true; // the rightmost body digit is doubled
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let v = digits.charCodeAt(i) - 48;
    if (double) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

function validateIsin(value: string): boolean {
  if (value.length !== 12 || !UPPER_ALNUM.test(value)) return false;
  if (!/^[A-Z]{2}/.test(value)) return false;
  // Letters expand to their two-digit ordinal, so the Luhn pass runs over digits.
  let expanded = '';
  for (const c of value.slice(0, 11)) {
    const v = ordinal(c);
    if (v < 0) return false;
    expanded += String(v);
  }
  return ordinal(value[11] as string) === luhnCheckDigit(expanded);
}

/**
 * CUSIP, 9 characters: an 8-character body and a modulus-10 double-add-double
 * check digit. `*`, `@` and `#` are the documented non-alphanumeric body
 * characters used for private placements and are accepted.
 */
function cusipOrdinal(c: string): number {
  if (c === '*') return 36;
  if (c === '@') return 37;
  if (c === '#') return 38;
  // Digits are their own value; letters are 10..35, as `ordinal` computes.
  return ordinal(c);
}

function cusipCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    const base = cusipOrdinal(body[i] as string);
    if (base < 0) return -1;
    const v = i % 2 === 1 ? base * 2 : base;
    sum += digitSum(v);
  }
  return (10 - (sum % 10)) % 10;
}

function validateCusip(value: string): boolean {
  if (value.length !== 9) return false;
  if (!/^[0-9A-Z*@#]{8}[0-9]$/.test(value)) return false;
  const expected = cusipCheckDigit(value.slice(0, 8));
  if (expected < 0) return false;
  return value.charCodeAt(8) - 48 === expected;
}

/** Whether `value` is valid under `scheme`. Case-sensitive: scheme values are upper-case. */
export function isValidSchemeValue(scheme: AssetIdScheme, value: string): boolean {
  switch (scheme) {
    case AssetIdScheme.FIGI:
      return validateFigi(value);
    case AssetIdScheme.ISIN:
      return validateIsin(value);
    case AssetIdScheme.CUSIP:
      return validateCusip(value);
  }
}

// --- Validated canonical asset identity -------------------------------------

declare const ValidatedBrand: unique symbol;

/**
 * A `CanonicalAssetId` whose class and scheme are in the closed vocabularies and
 * whose value verifies under its scheme.
 *
 * The brand is a compile-time aid only — TypeScript types are erased at run time
 * (ADR 0003) — so every entry point re-validates rather than trusting the type.
 */
export type ValidatedCanonicalAssetId = CanonicalAssetId & { readonly [ValidatedBrand]: true };

export function validateCanonicalAssetId(
  raw: unknown,
): Result<ValidatedCanonicalAssetId, RegistryReasonCodeName> {
  const parsed = parseCanonicalAssetId(raw);
  // The kernel's own charset and shape rules first; anything it refuses is not
  // an identifier at all, whatever scheme it claims.
  if (!parsed.ok) return err('ASSET_IDENTIFIER_INVALID');
  const id = parsed.value;
  if (!isAssetClass(id.assetClass)) return err('ASSET_CLASS_UNSUPPORTED');
  if (!isAssetIdScheme(id.idScheme)) return err('ASSET_IDENTIFIER_SCHEME_UNSUPPORTED');
  if (!isValidSchemeValue(id.idScheme, id.value)) return err('ASSET_IDENTIFIER_INVALID');
  return ok(id as ValidatedCanonicalAssetId);
}

/**
 * Index key for a canonical asset id.
 *
 * `\u0000` separators rather than a printable one, because the identifier
 * charset excludes it: no combination of segment contents can produce the key of
 * a different id. This is a map key, never an identity, and nothing parses it.
 */
export function canonicalAssetKey(id: CanonicalAssetId): string {
  return `${id.assetClass}\u0000${id.idScheme}\u0000${id.value}`;
}

export { canonicalAssetIdEquals };
