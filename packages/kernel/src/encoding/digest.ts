/**
 * Digests over canonically encoded objects (ADR 0002).
 *
 * keccak-256 rather than SHA-256 because the execution gate is EVM: keccak is a
 * single opcode there, while SHA-256 is a precompile call with different cost
 * and padding semantics. The mandate digest is what a principal signs, what
 * replay protection is keyed on, and what an audit record is anchored to.
 *
 * Per-object-type domain tags live inside the encodings themselves, so a digest
 * over one object type can never collide with or be replayed as another.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, type Bytes32 } from '../bytes.ts';
import type { CanonicalMandate } from '../mandate.ts';
import type { ExecutionCandidate } from '../candidate.ts';
import type { TrustedState } from '../state.ts';
import { encodeCandidate, encodeMandate, encodeTrustedState } from './codec.ts';

export function keccak256(bytes: Uint8Array): Bytes32 {
  return bytesToHex(keccak_256(bytes)) as Bytes32;
}

export function mandateDigest(m: CanonicalMandate): Bytes32 {
  return keccak256(encodeMandate(m));
}

export function candidateDigest(c: ExecutionCandidate): Bytes32 {
  return keccak256(encodeCandidate(c));
}

export function trustedStateDigest(s: TrustedState): Bytes32 {
  return keccak256(encodeTrustedState(s));
}
