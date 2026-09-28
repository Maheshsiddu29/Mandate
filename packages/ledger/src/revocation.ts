/**
 * The revocation object (authority-model.md §7).
 *
 * ```text
 * Revocation { target: AuthorityId, issuer: PartyId, effectiveAt: UnixSeconds, nonce: u64 }
 * RevocationId = H("mandate-core/v1/revocation", Revocation)
 * ```
 *
 * The tag is the one Phase 7B reserved for it. Structural validity is checked
 * here; whether the issuer may revoke the target (the issuer of the target or
 * of any ancestor) and whether `effectiveAt` is not in the future are ledger
 * facts, checked when the revocation is registered. Signatures are not
 * implemented, as for grants: `revocationId` is the signable digest.
 */

import { ok, type ByteWriter } from '@mandate/kernel';
import {
  at,
  checkFields,
  parseDigest,
  parseUint64,
  parseUnixSeconds,
  partyIdInputOf,
  readPartyInput,
  validatePartyId,
  writeDigest,
  writeParty,
  type AuthorityId,
  type CoreReader,
  type CoreResult,
  type Digest32,
  type IntegerInput,
  type Nonce,
  type PartyId,
  type PartyIdInput,
  type Tagged,
} from '@mandate/core';
import { LedgerTag, decodeLedgerTagged, ledgerDigest, ledgerWriter } from './encoding.ts';

export type RevocationId = Tagged<Digest32, 'RevocationId'>;

export interface RevocationInput {
  readonly target: string;
  readonly issuer: PartyIdInput;
  readonly effectiveAt: IntegerInput;
  readonly nonce: IntegerInput;
}

export type Revocation = Tagged<
  {
    readonly target: AuthorityId;
    /** A principal (issuer of a root) or an agent (issuer of a delegation); which, is decided against the graph. */
    readonly issuer: PartyId;
    /** In v1 never later than the registration time: revocation is not scheduled. */
    readonly effectiveAt: bigint;
    readonly nonce: Nonce;
  },
  'Revocation'
>;

export function validateRevocation(input: RevocationInput, path = 'revocation'): CoreResult<Revocation> {
  const shape = checkFields(input, ['target', 'issuer', 'effectiveAt', 'nonce'], path);
  if (!shape.ok) return shape;
  const target = parseDigest<AuthorityId>(input.target, at(path, 'target'));
  if (!target.ok) return target;
  const issuer = validatePartyId(input.issuer, at(path, 'issuer'));
  if (!issuer.ok) return issuer;
  const effectiveAt = parseUnixSeconds(input.effectiveAt, at(path, 'effectiveAt'));
  if (!effectiveAt.ok) return effectiveAt;
  const nonce = parseUint64(input.nonce, at(path, 'nonce'));
  if (!nonce.ok) return nonce;
  return ok({ target: target.value, issuer: issuer.value, effectiveAt: effectiveAt.value, nonce: nonce.value as Nonce } as Revocation);
}

function writeRevocationBody(w: ByteWriter, r: Revocation): void {
  writeDigest(w, r.target);
  writeParty(w, r.issuer);
  w.i64(r.effectiveAt).u64(r.nonce);
}

function readRevocationInput(r: CoreReader): RevocationInput {
  const target = r.digest();
  const issuer = readPartyInput(r);
  const effectiveAt = r.i64();
  const nonce = r.u64();
  return { target, issuer, effectiveAt, nonce };
}

export function encodeRevocation(r: Revocation): Uint8Array {
  const w = ledgerWriter(LedgerTag.REVOCATION);
  writeRevocationBody(w, r);
  return w.finish();
}

export function decodeRevocation(bytes: Uint8Array): CoreResult<Revocation> {
  return decodeLedgerTagged(bytes, LedgerTag.REVOCATION, readRevocationInput, (input) => validateRevocation(input));
}

export function revocationId(r: Revocation): RevocationId {
  const w = ledgerWriter(LedgerTag.REVOCATION);
  writeRevocationBody(w, r);
  return ledgerDigest<RevocationId>(w);
}

export function revocationInputOf(r: Revocation): RevocationInput {
  return { target: r.target, issuer: partyIdInputOf(r.issuer), effectiveAt: r.effectiveAt, nonce: r.nonce };
}
