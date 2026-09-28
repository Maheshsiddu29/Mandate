/**
 * Core Canonical Encoding (ADR 0020, extending ADR 0002's MCE discipline).
 *
 * Primitives are ADR 0002's: big-endian fixed-width integers, `u16`-prefixed
 * ASCII identifier strings, 32-byte digests, `u16` counts. Core adds:
 *
 * - `i256`: two's complement, 32 bytes, for signed quantity kinds;
 * - a presence flag, `u8` 0 or 1, before every nullable field. Any other flag
 *   value is malformed, so absence has one encoding;
 * - **length-prefixed domain tags.** A top-level object is
 *   `str(tag) ‖ u16(schemaVersion) ‖ body`. Prefixing the tag makes the tag
 *   space prefix-free by construction (`mandate-core/v1/state` cannot be read
 *   as the start of `mandate-core/v1/state-binding`), and the tag names the
 *   Core version and the object type, so no two object types share a hash
 *   namespace.
 *
 * A component embedded in another object (a `ModuleRef` inside an action, a
 * quantity inside a term) is written as its body only. Its standalone,
 * tagged encoding exists where the component has an identity of its own.
 *
 * Sets are written sorted by their elements' encoded bytes and must be
 * strictly ascending when read, so duplicates and misordering both reject and
 * `encode(decode(b)) == b` holds for every accepted `b`.
 *
 * Writers assert (they are reached only through validators, so a violation is
 * a bug in this package). Readers never throw to callers: a malformed buffer
 * is a `CoreError` value.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { ByteReader, ByteWriter, ok } from '@mandate/kernel';
import { fail, type CoreErrorCode, type CoreResult } from './errors.ts';
import type { Digest32, OpaqueBytes } from './primitives.ts';

/** Domain tags. Frozen: a tag never changes meaning; a new encoding is a new tag or schema version. */
export const CoreTag = {
  AUTHORITY: 'mandate-core/v1/authority',
  PRINCIPAL_POLICY: 'mandate-core/v1/principal-policy',
  ACTION: 'mandate-core/v1/action',
  ACTION_PAYLOAD: 'mandate-core/v1/payload/',
  STATE: 'mandate-core/v1/state',
  STATE_BINDING: 'mandate-core/v1/state-binding',
  MODULE_REF: 'mandate-core/v1/module-ref',
  ADAPTER_REF: 'mandate-core/v1/adapter-ref',
  QUANTITY: 'mandate-core/v1/quantity',
  RESERVATION: 'mandate-core/v1/reservation',
  RESERVATION_REF: 'mandate-core/v1/reservation-ref',
  AUTHORIZATION: 'mandate-core/v1/authorization',
  EXECUTION_BINDING: 'mandate-core/v1/execution-binding',
  RECEIPT_HEADER: 'mandate-core/v1/receipt-header',
  RECEIPT_REFERENCES: 'mandate-core/v1/receipt-references',
} as const;
export type CoreTag = (typeof CoreTag)[keyof typeof CoreTag];

/**
 * Tags the specification names for objects later phases build (the module
 * manifest, revocations, observations, per-kind receipts). Reserved so no 7B
 * object can take them.
 */
export const RESERVED_CORE_TAGS = [
  'mandate-core/v1/module',
  'mandate-core/v1/revocation',
  'mandate-core/v1/observation',
  'mandate-core/v1/receipt/',
] as const;

export const CORE_SCHEMA_VERSION = 1;

// --- Hex -----------------------------------------------------------------------

const HEX_DIGITS = '0123456789abcdef';

/** Input is a validated lowercase `0x` hex string of even length. */
export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (HEX_DIGITS.indexOf(hex[2 + i * 2] as string) << 4) | HEX_DIGITS.indexOf(hex[3 + i * 2] as string);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '0x';
  for (const b of bytes) s += (HEX_DIGITS[b >> 4] as string) + (HEX_DIGITS[b & 15] as string);
  return s;
}

export function keccakDigest<T extends Digest32>(bytes: Uint8Array): T {
  return bytesToHex(keccak_256(bytes)) as T;
}

// --- Writing -------------------------------------------------------------------

export function taggedWriter(tag: CoreTag): ByteWriter {
  return new ByteWriter().str(tag).u16(CORE_SCHEMA_VERSION);
}

export function writeDigest(w: ByteWriter, digest: Digest32): void {
  w.bytes32(hexToBytes(digest));
}

export function writeI256(w: ByteWriter, value: bigint): void {
  if (value < -(2n ** 255n) || value >= 2n ** 255n) throw new Error(`value ${value} outside int256`);
  w.u256(value < 0n ? value + (1n << 256n) : value);
}

export function writeFlag(w: ByteWriter, present: boolean): void {
  w.u8(present ? 1 : 0);
}

export function writeOpaqueBytes(w: ByteWriter, hex: OpaqueBytes): void {
  const bytes = hexToBytes(hex);
  w.u16(bytes.length).raw(bytes);
}

export function writeList<T>(w: ByteWriter, items: readonly T[], write: (w: ByteWriter, item: T) => void): void {
  w.u16(items.length);
  for (const item of items) write(w, item);
}

export function encodeWith<T>(write: (w: ByteWriter, item: T) => void, item: T): Uint8Array {
  const w = new ByteWriter();
  write(w, item);
  return w.finish();
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return compareBytes(a, b) === 0;
}

/**
 * Canonical set order: ascending by encoded bytes. Duplicates are refused,
 * never collapsed (ADR 0002): a caller that supplied one did not build the
 * object it thought it did.
 */
export function canonicalSet<T>(
  items: readonly T[],
  write: (w: ByteWriter, item: T) => void,
  path: string,
): CoreResult<readonly T[]> {
  const keyed = items.map((item) => ({ item, bytes: encodeWith(write, item) }));
  keyed.sort((a, b) => compareBytes(a.bytes, b.bytes));
  for (let i = 1; i < keyed.length; i += 1) {
    if (compareBytes((keyed[i - 1] as { bytes: Uint8Array }).bytes, (keyed[i] as { bytes: Uint8Array }).bytes) === 0) {
      return fail('DUPLICATE_SET_MEMBER', path);
    }
  }
  return ok(keyed.map((k) => k.item));
}

// --- Reading -------------------------------------------------------------------

/** Internal control flow for decoders; converted to a `CoreError` at the decode boundary and never escapes it. */
export class DecodeFailure extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode) {
    super(code);
    this.code = code;
  }
}

export class CoreReader {
  readonly #reader: ByteReader;
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#reader = new ByteReader(bytes);
  }

  get offset(): number {
    return this.#reader.offset;
  }

  #need<T>(value: T | undefined): T {
    if (value === undefined) throw new DecodeFailure('ENCODING_MALFORMED');
    return value;
  }

  u8(): number {
    return Number(this.#need(this.#reader.u8()));
  }

  u16(): number {
    return Number(this.#need(this.#reader.u16()));
  }

  u32(): number {
    return Number(this.#need(this.#reader.u32()));
  }

  u64(): bigint {
    return this.#need(this.#reader.u64());
  }

  u256(): bigint {
    return this.#need(this.#reader.u256());
  }

  i64(): bigint {
    return this.#need(this.#reader.i64());
  }

  i256(): bigint {
    const raw = this.u256();
    return raw >= 1n << 255n ? raw - (1n << 256n) : raw;
  }

  /** Identifier text. Invalid UTF-8 rejects; the charset is enforced by the validator the input is handed to. */
  str(): string {
    return this.#need(this.#reader.str());
  }

  digest(): string {
    return bytesToHex(this.#need(this.#reader.bytes32()));
  }

  opaqueBytes(): string {
    const length = this.u16();
    return bytesToHex(this.#need(this.#reader.raw(length)));
  }

  flag(): boolean {
    const v = this.u8();
    if (v === 0) return false;
    if (v === 1) return true;
    throw new DecodeFailure('ENCODING_INVALID_FLAG');
  }

  /** `u16` count, bounded, then elements whose encodings must be strictly ascending when `set` is true. */
  list<T>(max: number, read: (r: CoreReader) => T, set: boolean): T[] {
    const count = this.u16();
    if (count > max) throw new DecodeFailure('COLLECTION_TOO_LARGE');
    const out: T[] = [];
    let previous: Uint8Array | undefined;
    for (let i = 0; i < count; i += 1) {
      const start = this.offset;
      out.push(read(this));
      if (set) {
        const span = this.#bytes.subarray(start, this.offset);
        if (previous !== undefined && compareBytes(previous, span) >= 0) throw new DecodeFailure('ENCODING_NON_CANONICAL');
        previous = span;
      }
    }
    return out;
  }

  finish(): void {
    if (!this.#reader.exhausted) throw new DecodeFailure('ENCODING_TRAILING_BYTES');
  }
}

/** Frozen enum wire codes, written out explicitly so reordering a declaration never changes a signed digest. */
export type WireCodes<T extends string> = { readonly [K in T]: number };

export function readCode<T extends string>(r: CoreReader, codes: WireCodes<T>): T {
  const code = r.u8();
  for (const key of Object.keys(codes) as T[]) {
    if (codes[key] === code) return key;
  }
  throw new DecodeFailure('ENCODING_UNKNOWN_CODE');
}

export function writeCode<T extends string>(w: ByteWriter, codes: WireCodes<T>, value: T): void {
  const code = codes[value];
  if (code === undefined) throw new Error(`no wire code for ${value}`);
  w.u8(code);
}

export function readNullable<T>(r: CoreReader, read: (r: CoreReader) => T): T | null {
  return r.flag() ? read(r) : null;
}

export function writeNullable<T>(w: ByteWriter, value: T | null, write: (w: ByteWriter, item: T) => void): void {
  writeFlag(w, value !== null);
  if (value !== null) write(w, value);
}

/**
 * Decode a tagged top-level object: tag, schema version, body, no trailing
 * bytes, then the same validator a directly constructed object goes through.
 * There is no second, weaker validation path.
 */
export function decodeTagged<I, T>(
  bytes: Uint8Array,
  tag: CoreTag,
  read: (r: CoreReader) => I,
  validate: (input: I) => CoreResult<T>,
): CoreResult<T> {
  if (!(bytes instanceof Uint8Array)) return fail('WRONG_TYPE', 'bytes');
  const r = new CoreReader(bytes);
  let input: I;
  try {
    if (r.str() !== tag) return fail('ENCODING_WRONG_TAG', 'bytes@0');
    if (r.u16() !== CORE_SCHEMA_VERSION) return fail('ENCODING_UNSUPPORTED_VERSION', `bytes@${r.offset - 2}`);
    input = read(r);
    r.finish();
  } catch (e) {
    if (e instanceof DecodeFailure) return fail(e.code, `bytes@${r.offset}`);
    throw e;
  }
  return validate(input);
}
