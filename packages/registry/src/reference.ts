/**
 * Human references, and turning one into a lookup (ADR 0005).
 *
 * ```
 * human reference  ->  resolution candidates  ->  canonical asset
 * ```
 *
 * A human reference is not authoritative identity. It is an input to a lookup,
 * and the step that turns it into an identity is explicit, auditable and allowed
 * to fail.
 *
 * Two rules do the work here:
 *
 * - **Matching is exact over a normalized key.** No fuzzy matching, no edit
 *   distance, no model. Resolution must be reproducible from a snapshot forever,
 *   which a similarity score is not.
 * - **Normalization applies to the lookup key only.** Nothing stored is ever
 *   rewritten, and a resolved identifier is returned exactly as the registry
 *   holds it. This is the same rule the kernel applies to identifiers, with the
 *   one difference that a *reference* may be case-folded because it was never
 *   identity in the first place.
 */

import { err, ok, type Result } from '@mandate/kernel';
import type { RegistryReasonCodeName } from './reason-codes.ts';
import {
  isAssetIdScheme,
  isValidSchemeValue,
  validateCanonicalAssetId,
  type ValidatedCanonicalAssetId,
} from './asset-id.ts';

export const REFERENCE_MAX_LENGTH = 128;

/**
 * How a reference will be looked up.
 *
 * `QUALIFIED` covers both `MIC:TICKER` and a curator-registered
 * exchange-name-qualified alias, and searches both indexes. Collapsing them
 * removes a class of "which did the user mean" ambiguity from the *parser*: any
 * genuine ambiguity then surfaces as `AMBIGUOUS` from the resolver, where it
 * belongs.
 */
export const ReferenceKind = {
  /** A complete canonical asset identity, structured or as its `mandate:asset:...` string. */
  CANONICAL_ID: 'CANONICAL_ID',
  /** `figi:BBG000BBJQV0` — a scheme and value, with no asset class, so it is a lookup. */
  SCHEME_VALUE: 'SCHEME_VALUE',
  /** `XNAS:NVDA`, or a registered `NASDAQ:NVDA`-style alias. */
  QUALIFIED: 'QUALIFIED',
  /** A bare ticker, company name or alias. */
  PLAIN: 'PLAIN',
} as const;
export type ReferenceKind = (typeof ReferenceKind)[keyof typeof ReferenceKind];

export type ParsedReference =
  | { readonly kind: 'CANONICAL_ID'; readonly id: ValidatedCanonicalAssetId }
  | { readonly kind: 'SCHEME_VALUE'; readonly scheme: string; readonly value: string }
  | { readonly kind: 'QUALIFIED'; readonly qualifier: string; readonly symbol: string; readonly key: string }
  | { readonly kind: 'PLAIN'; readonly key: string };

const CANONICAL_ID_PREFIX = 'mandate:asset:';
const ASCII_PRINTABLE = /^[\x20-\x7E]+$/;

/**
 * The normalized lookup key for a display string.
 *
 * Trim surrounding ASCII whitespace, collapse internal runs to one space,
 * upper-case. Nothing else: no accent folding, no punctuation stripping, no
 * abbreviation expansion. Each of those would merge two references a curator
 * distinguished.
 */
export function normalizeLookupKey(raw: string): string {
  return raw.trim().replace(/[ \t\n\r\f\v]+/g, ' ').toUpperCase();
}

/**
 * Parse a reference into the lookup it implies.
 *
 * Total: every input yields a `Result`. A structured object is taken as a
 * canonical identity; a string is classified by shape, in a fixed order, so
 * classification never depends on registry contents.
 */
export function parseReference(raw: unknown): Result<ParsedReference, RegistryReasonCodeName> {
  // A structured reference is a canonical identity claim and is validated as one.
  if (typeof raw === 'object' && raw !== null) {
    const id = validateCanonicalAssetId(raw);
    if (!id.ok) return id;
    return ok({ kind: ReferenceKind.CANONICAL_ID, id: id.value });
  }

  if (typeof raw !== 'string') return err('REFERENCE_MALFORMED');
  if (raw.length === 0 || raw.length > REFERENCE_MAX_LENGTH) return err('REFERENCE_MALFORMED');
  // Non-ASCII rejects rather than being transliterated: two Unicode strings that
  // fold together are exactly the ambiguity ADR 0002 removed from identifiers
  // rather than resolved, and guessing here would reintroduce it.
  if (!ASCII_PRINTABLE.test(raw)) return err('REFERENCE_MALFORMED');

  const trimmed = raw.trim();
  if (trimmed.length === 0) return err('REFERENCE_MALFORMED');

  // 1. A full canonical id string.
  if (trimmed.toLowerCase().startsWith(CANONICAL_ID_PREFIX)) {
    const segments = trimmed.split(':');
    // `mandate` `asset` `<class>` `<scheme>` `<value>`
    if (segments.length !== 5) return err('REFERENCE_MALFORMED');
    const assetClass = segments[2] ?? '';
    const idScheme = segments[3] ?? '';
    const value = segments[4] ?? '';
    if (assetClass === '' || idScheme === '' || value === '') return err('REFERENCE_MALFORMED');
    const id = validateCanonicalAssetId({ assetClass, idScheme, value });
    if (!id.ok) return id;
    return ok({ kind: ReferenceKind.CANONICAL_ID, id: id.value });
  }

  const colonCount = trimmed.split(':').length - 1;

  if (colonCount === 0) {
    return ok({ kind: ReferenceKind.PLAIN, key: normalizeLookupKey(trimmed) });
  }

  if (colonCount > 1) {
    // An exchange-qualified reference with an excess segment. Rejected rather
    // than having a segment discarded to make it parse.
    return err('REFERENCE_MALFORMED');
  }

  const parts = trimmed.split(':');
  const left = (parts[0] ?? '').trim();
  const right = (parts[1] ?? '').trim();
  if (left === '' || right === '') return err('REFERENCE_MALFORMED');

  // 2. A scheme-qualified value. The scheme name is matched case-insensitively;
  //    the value is not, because scheme values are upper-case by definition and
  //    case-folding one would be repairing an identifier.
  const lowerLeft = left.toLowerCase();
  if (isAssetIdScheme(lowerLeft)) {
    // Validated here rather than left to the index lookup. A value whose check
    // digit does not verify is a malformed *identifier*, and reporting it as
    // "unknown asset" would tell a caller to go looking for a registry entry
    // when the real fault is the identifier they supplied.
    if (!isValidSchemeValue(lowerLeft, right)) return err('ASSET_IDENTIFIER_INVALID');
    return ok({ kind: ReferenceKind.SCHEME_VALUE, scheme: lowerLeft, value: right });
  }

  // 3. Everything else with one colon is a qualified symbol lookup: a MIC, or an
  //    exchange name a curator registered as an alias.
  return ok({
    kind: ReferenceKind.QUALIFIED,
    qualifier: normalizeLookupKey(left),
    symbol: normalizeLookupKey(right),
    key: `${normalizeLookupKey(left)}:${normalizeLookupKey(right)}`,
  });
}
