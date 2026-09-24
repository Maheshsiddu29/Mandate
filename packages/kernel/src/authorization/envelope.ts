/**
 * Authorization envelopes: how a signer committed to a mandate digest
 * (ADR 0001).
 *
 * The envelope is resolved through a scheme registry. An unrecognized scheme is
 * `AUTHORIZATION_SCHEME_UNSUPPORTED` — a rejection, never a skipped check,
 * because a verifier that quietly ignores an authorization it does not
 * understand has authorized without checking.
 *
 * One scheme is implemented: `eip712-secp256k1`. The registry exists so that a
 * second is an addition rather than a redesign; no second scheme is built
 * speculatively.
 *
 * This module answers only "did this signer commit to this digest". Whether
 * that signer is the mandate's principal is a separate question, answered by
 * the verifier, because authentication and authorization are distinct checks
 * (design section 8.1).
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { type Result, ok, err } from '../result.ts';
import type { ReasonCodeName } from '../reason-codes.ts';
import { bytesToHex, hexToBytes, type Bytes32 } from '../bytes.ts';
import { PARTY_KIND_EIP155_ADDRESS, parsePartyId, type PartyId } from '../mandate.ts';
import { eip712SigningHash, eip712DomainEquals, parseEip712Domain, type Eip712Domain } from './eip712.ts';

export const AuthorizationScheme = { EIP712_SECP256K1: 'eip712-secp256k1' } as const;
export type AuthorizationScheme = (typeof AuthorizationScheme)[keyof typeof AuthorizationScheme];

export interface AuthorizationEnvelope {
  readonly scheme: AuthorizationScheme;
  /** The party the envelope claims signed. The recovered signer must equal it. */
  readonly signer: PartyId;
  /** 65 bytes: r ‖ s ‖ v, lowercase hex. */
  readonly signature: string;
  readonly domain: Eip712Domain;
}

const SIGNATURE_RE = /^0x[0-9a-f]{130}$/;

export function parseAuthorizationEnvelope(raw: unknown): Result<AuthorizationEnvelope, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_AUTHORIZATION');
  const r = raw as Record<string, unknown>;

  const scheme = r['scheme'];
  if (typeof scheme !== 'string') return err('MALFORMED_AUTHORIZATION');
  // An unknown scheme is reported as unsupported rather than malformed: the
  // envelope may be perfectly well-formed for a scheme this verifier does not
  // implement, and conflating the two would hide a genuine upgrade need.
  if (scheme !== AuthorizationScheme.EIP712_SECP256K1) return err('AUTHORIZATION_SCHEME_UNSUPPORTED');

  const signer = parsePartyId(r['signer'], 'MALFORMED_AUTHORIZATION');
  if (!signer.ok) return err('MALFORMED_AUTHORIZATION');
  if (signer.value.kind !== PARTY_KIND_EIP155_ADDRESS) return err('MALFORMED_AUTHORIZATION');

  const signature = r['signature'];
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) return err('MALFORMED_AUTHORIZATION');

  const domain = parseEip712Domain(r['domain']);
  if (!domain.ok) return domain;

  return ok({
    scheme: AuthorizationScheme.EIP712_SECP256K1,
    signer: signer.value,
    signature,
    domain: domain.value,
  });
}

/** Half the curve order. Signatures above it are the malleable twin of a valid one. */
const SECP256K1_HALF_N = secp256k1.Point.Fn.ORDER / 2n;

function addressFromPublicKey(uncompressed: Uint8Array): string {
  // Drop the 0x04 prefix; the address is the low 20 bytes of keccak256(x ‖ y).
  return bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(12));
}

/**
 * Verify that `envelope.signer` committed to `mandateDigest`.
 *
 * `expectedDomain` is supplied by the caller's deployment configuration and is
 * required. The verifier never accepts whatever domain an envelope claims: a
 * signature made for one application or network must not authorize an execution
 * under another.
 */
export function verifyAuthorization(
  envelope: AuthorizationEnvelope,
  mandateDigest: Bytes32,
  expectedDomain: Eip712Domain,
): Result<PartyId, ReasonCodeName> {
  if (!eip712DomainEquals(envelope.domain, expectedDomain)) return err('AUTHORIZATION_DOMAIN_MISMATCH');

  const sigBytes = hexToBytes(envelope.signature);
  if (sigBytes === undefined || sigBytes.length !== 65) return err('MALFORMED_AUTHORIZATION');

  const v = sigBytes[64] as number;
  // Accept only canonical 27/28. Accepting 0/1 as well would let one signature
  // be presented in two forms, which is a distinctness problem for anything
  // keyed on the envelope.
  if (v !== 27 && v !== 28) return err('SIGNATURE_INVALID');

  let r = 0n;
  let s = 0n;
  for (let i = 0; i < 32; i += 1) r = (r << 8n) | BigInt(sigBytes[i] as number);
  for (let i = 32; i < 64; i += 1) s = (s << 8n) | BigInt(sigBytes[i] as number);

  const n = secp256k1.Point.Fn.ORDER;
  if (r === 0n || r >= n || s === 0n || s >= n) return err('SIGNATURE_INVALID');
  // EIP-2 low-s. The high-s twin verifies against the same key, so accepting it
  // would make one authorization presentable as two distinct envelopes.
  if (s > SECP256K1_HALF_N) return err('SIGNATURE_INVALID');

  const hash = eip712SigningHash(expectedDomain, mandateDigest);

  let recovered: string;
  try {
    // `toBytes(false)` is noble's uncompressed (0x04-prefixed) SEC1 form.
    const signature = secp256k1.Signature.fromBytes(sigBytes.subarray(0, 64)).addRecoveryBit(v - 27);
    recovered = addressFromPublicKey(signature.recoverPublicKey(hash).toBytes(false));
  } catch {
    // A point that does not recover is an invalid signature, not a crash.
    return err('SIGNATURE_INVALID');
  }

  if (recovered !== envelope.signer.value) return err('SIGNATURE_INVALID');
  return ok(envelope.signer);
}
