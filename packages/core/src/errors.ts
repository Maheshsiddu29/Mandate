/**
 * Structured validation errors for Mandate Core v1 objects.
 *
 * **Provisional.** The final Core reason-code registry is open question 9 of
 * the Phase 7A specification. These codes describe why a Core *object* is not
 * well formed; they are not decision reason codes (`LEDGER_LIMIT_EXCEEDED`,
 * `STATE_STALE`, ...), which belong to the decision pipeline of later phases.
 * They are stable within Phase 7B so tests and vectors can pin them, and may be
 * renamed when the registry is finalized.
 *
 * Every error carries a `path` naming the offending field, so a caller learns
 * which element of which list failed without parsing a message.
 */

import { err, type Result } from '@mandate/kernel';

export const CORE_ERROR_CODES_ARE_PROVISIONAL = true;

export const CORE_ERROR_CODES = [
  // Input shape
  'WRONG_TYPE',
  'MISSING_FIELD',
  'UNKNOWN_FIELD',
  'UNKNOWN_ENUM_VALUE',
  // Numbers
  'NUMBER_NOT_PERMITTED',
  'NON_FINITE_NUMBER',
  'NON_INTEGER',
  'UNSAFE_INTEGER',
  'NON_CANONICAL_INTEGER',
  'NON_CANONICAL_DECIMAL',
  'INTEGER_OUT_OF_RANGE',
  'INVALID_DECIMALS',
  // Identifiers, digests and bytes
  'MALFORMED_IDENTIFIER',
  'MALFORMED_UNIT',
  'MALFORMED_DIGEST',
  'ZERO_DIGEST',
  'MALFORMED_PARTY',
  'MALFORMED_BYTES',
  'RESOURCE_KIND_MISMATCH',
  // Collections
  'COLLECTION_TOO_LARGE',
  'COLLECTION_EMPTY',
  'DUPLICATE_SET_MEMBER',
  // Quantities
  'QUANTITY_NEGATIVE_UNSIGNED',
  'QUANTITY_OUT_OF_RANGE',
  'ASSET_REQUIRED',
  'ASSET_FORBIDDEN',
  'ASSET_FORM_INVALID',
  'VALUATION_REQUIRED',
  'VALUATION_FORBIDDEN',
  'VALUATION_BASIS_INVALID',
  'VALUATION_SOURCE_INVALID',
  'VALUATION_UNIT_MISMATCH',
  'COUNT_UNIT_REQUIRED',
  'QUANTITY_KIND_MISMATCH',
  'QUANTITY_UNIT_MISMATCH',
  'QUANTITY_ASSET_MISMATCH',
  'QUANTITY_DECIMALS_MISMATCH',
  'QUANTITY_VALUATION_MISMATCH',
  'INEXACT_RESCALE',
  // Authority terms
  'DUPLICATE_TERM',
  'INVALID_TIME_WINDOW',
  'DELEGATE_DEPTH_INVALID',
  'DIMENSION_KIND_NOT_LEDGER_TRACKABLE',
  'RESTORATION_ACCOUNTING_MISMATCH',
  'EPOCH_REQUIRED',
  'EPOCH_FORBIDDEN',
  'EPOCH_INVALID',
  'NET_SIGN_REQUIRES_SIGNED_KIND',
  // State
  'MIN_TRUST_NOT_ADMISSIBLE',
  'TRUST_CLASS_NOT_ADMISSIBLE',
  'EXECUTION_DEPENDENCE_INCOMPATIBLE',
  'STATE_VALIDITY_INVALID',
  // Authority objects
  'ROOT_ISSUER_NOT_PRINCIPAL',
  'PRINCIPAL_POLICY_GRANTS_AUTHORITY',
  'PRINCIPAL_POLICY_TERM_NOT_PERMITTED',
  // Actions
  'TARGET_REPEATED_IN_RESOURCES',
  // Reservations, execution and receipts
  'GENERATION_ZERO',
  'LINEAGE_REPEATS_NODE',
  'RESERVATION_ID_MISMATCH',
  'EXECUTION_BINDING_INCONSISTENT',
  'LEDGER_VERSION_NOT_ADVANCED',
  // Canonical decoding
  'ENCODING_MALFORMED',
  'ENCODING_TRAILING_BYTES',
  'ENCODING_WRONG_TAG',
  'ENCODING_UNSUPPORTED_VERSION',
  'ENCODING_NON_CANONICAL',
  'ENCODING_UNKNOWN_CODE',
  'ENCODING_INVALID_FLAG',
] as const;

export type CoreErrorCode = (typeof CORE_ERROR_CODES)[number];

export interface CoreError {
  readonly code: CoreErrorCode;
  /** The offending field, e.g. `grant.terms[2].limit.decimals`, or `bytes@17` for a decoding failure. */
  readonly path: string;
}

export type CoreResult<T> = Result<T, CoreError>;

export function fail(code: CoreErrorCode, path: string): CoreResult<never> {
  return err({ code, path });
}

/** Extend a field path: `at('grant', 'terms')` is `grant.terms`; `at('terms', 2)` is `terms[2]`. */
export function at(path: string, field: string | number): string {
  if (typeof field === 'number') return `${path}[${field}]`;
  return path === '' ? field : `${path}.${field}`;
}
