/**
 * Portfolio canonical encoding (portfolio-mandate.md §5).
 *
 * The repository's discipline, unchanged (ADR 0002, ADR 0020): a top-level
 * object is `str(tag) ‖ u16(schemaVersion) ‖ body`; integers are big-endian
 * and fixed-width; identifiers are `u16`-prefixed ASCII; nullable fields carry
 * a presence flag; sets are written in ascending order of their elements'
 * encoded bytes and must be strictly ascending when read; nothing may trail.
 * The digest is Keccak-256 of the whole encoding. No JSON is hashed.
 *
 * Tags follow the kernel's `MANDATE.<OBJECT>.V<n>` spelling but live in their
 * own `PORTFOLIO_*` namespace, so no portfolio object can be read as a kernel,
 * Core or control object, or the reverse.
 */

import { ByteWriter } from '@mandate/kernel';
import { CoreReader, DecodeFailure, fail, keccakDigest, type CoreResult, type Digest32 } from '@mandate/core';

/** Frozen: a tag never changes meaning; a new encoding is a new tag. */
export const PortfolioTag = {
  MANDATE: 'PORTFOLIO_MANDATE.V1',
  MANDATE_SIGNATURE: 'PORTFOLIO_MANDATE_SIGNATURE.V1',
  ACTION_CANDIDATE: 'PORTFOLIO_ACTION_CANDIDATE.V1',
  PROPOSAL: 'PORTFOLIO_PROPOSAL.V1',
  PROPOSAL_SIGNATURE: 'PORTFOLIO_PROPOSAL_SIGNATURE.V1',
  CHILD_AUTHORIZATION: 'PORTFOLIO_CHILD_AUTHORIZATION.V1',
  PORTFOLIO_CANDIDATE: 'PORTFOLIO_CANDIDATE.V1',
  RECEIPT: 'PORTFOLIO_RECEIPT.V1',
} as const;
export type PortfolioTag = (typeof PortfolioTag)[keyof typeof PortfolioTag];

export const PORTFOLIO_SCHEMA_VERSION = 1;

export function portfolioWriter(tag: PortfolioTag): ByteWriter {
  return new ByteWriter().str(tag).u16(PORTFOLIO_SCHEMA_VERSION);
}

export function portfolioDigest<T extends Digest32>(bytes: Uint8Array): T {
  return keccakDigest<T>(bytes);
}

/**
 * Decode a tagged portfolio object: tag, schema version, body, no trailing
 * bytes, then the same validator a directly constructed object goes through.
 * A reader failure is a structural error value, never an exception.
 */
export function decodePortfolio<I, T>(
  bytes: Uint8Array,
  tag: PortfolioTag,
  read: (r: CoreReader) => I,
  validate: (input: I) => CoreResult<T>,
): CoreResult<T> {
  if (!(bytes instanceof Uint8Array)) return fail('WRONG_TYPE', 'bytes');
  const r = new CoreReader(bytes);
  let input: I;
  try {
    if (r.str() !== tag) return fail('ENCODING_WRONG_TAG', 'bytes@0');
    if (r.u16() !== PORTFOLIO_SCHEMA_VERSION) return fail('ENCODING_UNSUPPORTED_VERSION', `bytes@${r.offset - 2}`);
    input = read(r);
    r.finish();
  } catch (e) {
    if (e instanceof DecodeFailure) return fail(e.code, `bytes@${r.offset}`);
    // A reader that throws anything else met bytes it cannot represent: still a refusal, never a crash.
    return fail('ENCODING_MALFORMED', `bytes@${r.offset}`);
  }
  return validate(input);
}

/** Encode, decode and compare: the canonical round trip every accepted encoding satisfies. */
export function isCanonical<T>(bytes: Uint8Array, decode: (b: Uint8Array) => CoreResult<T>, encode: (v: T) => Uint8Array): boolean {
  const d = decode(bytes);
  if (!d.ok) return false;
  const again = encode(d.value);
  if (again.length !== bytes.length) return false;
  for (let i = 0; i < again.length; i += 1) if (again[i] !== bytes[i]) return false;
  return true;
}
