/**
 * Primitive parsers shared by every Core validator.
 *
 * Nothing here repairs input. A value outside its canonical form is rejected;
 * it is never trimmed, case-folded, rounded or truncated, because
 * auto-correcting a security-relevant value hides that the caller did not
 * build the object it believed it built (ADR 0002).
 *
 * Economic values and every 64-bit or wider integer are `bigint`. They are
 * accepted as a `bigint` or as a canonical decimal string, never as a
 * JavaScript `number`: accepting one would make the boundary between safe and
 * unsafe input depend on magnitude. Small fixed-width fields (decimals,
 * versions, depths) are `number`, and are rejected when not a finite, safe,
 * in-range integer.
 */

import { ok, parseIdentifier, type Identifier } from '@mandate/kernel';
import type { Tagged } from './brand.ts';
import { at, fail, type CoreResult } from './errors.ts';

export type IntegerInput = bigint | string;

export const UINT8_MAX = 255;
export const UINT16_MAX = 65_535;
export const UINT32_MAX = 4_294_967_295;
export const UINT64_MAX = 2n ** 64n - 1n;
export const UINT256_MAX = 2n ** 256n - 1n;
export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;
export const INT256_MIN = -(2n ** 255n);
export const INT256_MAX = 2n ** 255n - 1n;

/** No leading zeros, no plus sign, no `-0`, no exponent, no fraction. */
const CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/;
/** Longer than any int256 needs; bounds the cost of `BigInt()` on hostile input. */
const MAX_INTEGER_STRING_LENGTH = 80;

export function parseInteger(raw: IntegerInput, path: string): CoreResult<bigint> {
  if (typeof raw === 'bigint') return ok(raw);
  if (typeof raw === 'string') {
    if (raw.length > MAX_INTEGER_STRING_LENGTH) return fail('INTEGER_OUT_OF_RANGE', path);
    if (!CANONICAL_INTEGER.test(raw)) return fail('NON_CANONICAL_INTEGER', path);
    return ok(BigInt(raw));
  }
  if (typeof raw === 'number') return fail('NUMBER_NOT_PERMITTED', path);
  return fail('WRONG_TYPE', path);
}

export function parseIntegerInRange(raw: IntegerInput, min: bigint, max: bigint, path: string): CoreResult<bigint> {
  const v = parseInteger(raw, path);
  if (!v.ok) return v;
  if (v.value < min || v.value > max) return fail('INTEGER_OUT_OF_RANGE', path);
  return v;
}

export function parseUint64(raw: IntegerInput, path: string): CoreResult<bigint> {
  return parseIntegerInRange(raw, 0n, UINT64_MAX, path);
}

/** Unix seconds: signed 64-bit, as the kernel's `UnixSeconds`. */
export function parseUnixSeconds(raw: IntegerInput, path: string): CoreResult<bigint> {
  return parseIntegerInRange(raw, INT64_MIN, INT64_MAX, path);
}

/** A small unsigned field carried as a `number`: decimals, versions, depths. */
export function parseSmallUint(raw: number, max: number, path: string): CoreResult<number> {
  if (typeof raw !== 'number') return fail('WRONG_TYPE', path);
  if (!Number.isFinite(raw)) return fail('NON_FINITE_NUMBER', path);
  if (!Number.isInteger(raw)) return fail('NON_INTEGER', path);
  if (!Number.isSafeInteger(raw)) return fail('UNSAFE_INTEGER', path);
  if (raw < 0 || raw > max) return fail('INTEGER_OUT_OF_RANGE', path);
  return ok(raw);
}

export function parseEnum<T extends string>(raw: string, values: readonly T[], path: string): CoreResult<T> {
  if (typeof raw !== 'string') return fail('WRONG_TYPE', path);
  const found = values.find((v) => v === raw);
  return found === undefined ? fail('UNKNOWN_ENUM_VALUE', path) : ok(found);
}

/**
 * Closed-world object shape. Every listed field must be present and not
 * `undefined`; no other own field may exist. Optional Core fields are
 * therefore written as an explicit `null`, never omitted, so absence has
 * exactly one spelling (no optional-field ambiguity).
 */
export function checkFields(input: object, fields: readonly string[], path: string): CoreResult<true> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('WRONG_TYPE', path);
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) return fail('UNKNOWN_FIELD', at(path, key));
  }
  for (const field of fields) {
    if (!Object.hasOwn(input, field) || Object.getOwnPropertyDescriptor(input, field)?.value === undefined) {
      return fail('MISSING_FIELD', at(path, field));
    }
  }
  return ok(true);
}

export function checkArray(input: readonly object[] | readonly string[], max: number, path: string): CoreResult<true> {
  if (!Array.isArray(input)) return fail('WRONG_TYPE', path);
  if (input.length > max) return fail('COLLECTION_TOO_LARGE', path);
  return ok(true);
}

export function parseIdentifierAs<T extends Identifier>(raw: string, path: string): CoreResult<T> {
  if (typeof raw !== 'string') return fail('WRONG_TYPE', path);
  const id = parseIdentifier(raw);
  return id.ok ? ok(id.value as T) : fail('MALFORMED_IDENTIFIER', path);
}

/**
 * A 32-byte digest: `0x` and 64 lowercase hex digits, nothing else. Uppercase
 * and mixed case are rejected rather than normalized, so two spellings of one
 * digest can never both be accepted and then disagree about equality.
 */
export type Digest32 = Tagged<string, 'Digest32'>;

const DIGEST32 = /^0x[0-9a-f]{64}$/;
export const ZERO_DIGEST = `0x${'0'.repeat(64)}`;

export function parseDigest<T extends Digest32>(raw: string, path: string): CoreResult<T> {
  if (typeof raw !== 'string') return fail('WRONG_TYPE', path);
  return DIGEST32.test(raw) ? ok(raw as T) : fail('MALFORMED_DIGEST', path);
}

/**
 * A digest that must name real content. The all-zero digest is what an
 * uninitialized field looks like; for a mandatory identity such as a module
 * or adapter digest it is refused rather than accepted as a placeholder.
 */
export function parseNonZeroDigest<T extends Digest32>(raw: string, path: string): CoreResult<T> {
  const d = parseDigest<T>(raw, path);
  if (!d.ok) return d;
  return d.value === ZERO_DIGEST ? fail('ZERO_DIGEST', path) : d;
}

/** Opaque bytes owned by a domain module, carried as lowercase `0x` hex. Core never interprets them. */
export type OpaqueBytes = Tagged<string, 'OpaqueBytes'>;

const HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/;

export function parseOpaqueBytes(raw: string, maxBytes: number, path: string): CoreResult<OpaqueBytes> {
  if (typeof raw !== 'string') return fail('WRONG_TYPE', path);
  if ((raw.length - 2) / 2 > maxBytes) return fail('COLLECTION_TOO_LARGE', path);
  return HEX_BYTES.test(raw) ? ok(raw as OpaqueBytes) : fail('MALFORMED_BYTES', path);
}
