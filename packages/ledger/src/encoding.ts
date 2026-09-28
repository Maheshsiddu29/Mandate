/**
 * Ledger encoding helpers, on Core's canonical encoding (ADR 0020, ADR 0021).
 *
 * The same discipline as Core: `str(tag) ‖ u16(schemaVersion) ‖ body`,
 * length-prefixed domain tags in the `mandate-core/v1/` namespace, big-endian
 * fixed-width integers, `u8` presence flags, explicit enum wire codes and
 * keccak-256 over the tagged encoding. Nothing is hashed as JSON.
 *
 * The ledger's tags are new tags; none reuses a Core tag, and the one Core
 * reserved for this phase — `mandate-core/v1/revocation` — is used for exactly
 * the object it was reserved for.
 */

import { ByteWriter } from '@mandate/kernel';
import {
  CORE_SCHEMA_VERSION,
  CoreReader,
  DecodeFailure,
  fail,
  keccakDigest,
  type CoreResult,
  type Digest32,
} from '@mandate/core';
import { MAX_EMBEDDED_BYTES } from './limits.ts';

export const LedgerTag = {
  /** Reserved by Phase 7B for the revocation object (ADR 0020). */
  REVOCATION: 'mandate-core/v1/revocation',
  LEDGER_GENESIS: 'mandate-core/v1/ledger-genesis',
  LEDGER_BATCH: 'mandate-core/v1/ledger-batch',
  LEDGER_EVENT: 'mandate-core/v1/ledger-event',
  LEDGER_STATE: 'mandate-core/v1/ledger-state',
  POLICY_DIMENSION: 'mandate-core/v1/policy-dimension',
  /** 7D.2: an invariant definition's exact identity, and one committed narrowing (semantic.ts). */
  SEMANTIC_INVARIANT: 'mandate-core/v1/semantic-invariant',
  SEMANTIC_PROOF: 'mandate-core/v1/semantic-proof',
  /** 7D.3: the exact definition one registered term is interpreted under (semantic.ts). */
  SEMANTIC_BINDING: 'mandate-core/v1/semantic-binding',
  /** 7E.1: an issuance attempt's derived identity (attempt.ts). */
  ATTEMPT: 'mandate-core/v1/attempt',
} as const;
export type LedgerTag = (typeof LedgerTag)[keyof typeof LedgerTag];

export function ledgerWriter(tag: LedgerTag): ByteWriter {
  return new ByteWriter().str(tag).u16(CORE_SCHEMA_VERSION);
}

export function ledgerDigest<T extends Digest32>(w: ByteWriter): T {
  return keccakDigest<T>(w.finish());
}

/** An embedded tagged Core object: `u32(length) ‖ bytes`, so it decodes with its own validator. */
export function writeSegment(w: ByteWriter, bytes: Uint8Array): void {
  w.u32(bytes.length).raw(bytes);
}

export function readSegment(r: CoreReader): Uint8Array {
  const length = r.u32();
  if (length > MAX_EMBEDDED_BYTES) throw new DecodeFailure('COLLECTION_TOO_LARGE');
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = r.u8();
  return out;
}

/**
 * Decode a tagged ledger object: tag, schema version, body, no trailing
 * bytes, then the object's validator. Mirrors Core's `decodeTagged`, whose tag
 * parameter is Core's closed tag set.
 */
export function decodeLedgerTagged<I, T>(
  bytes: Uint8Array,
  tag: LedgerTag,
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

/** Exact base-10 rescale of `atoms` from `from` decimals to `to` decimals, or `null` when a non-zero digit would be dropped. */
export function rescaleExact(atoms: bigint, from: number, to: number): bigint | null {
  if (to >= from) return atoms * 10n ** BigInt(to - from);
  const divisor = 10n ** BigInt(from - to);
  return atoms % divisor === 0n ? atoms / divisor : null;
}

/** Exact comparison of two scaled values by cross-multiplication. */
export function compareScaled(a: bigint, aDecimals: number, b: bigint, bDecimals: number): -1 | 0 | 1 {
  const left = a * 10n ** BigInt(bDecimals);
  const right = b * 10n ** BigInt(aDecimals);
  return left < right ? -1 : left > right ? 1 : 0;
}

