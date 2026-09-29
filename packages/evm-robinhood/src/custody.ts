/**
 * Key custody for the Robinhood gate signer (Phase 7E.3).
 *
 * Two keys take part in a gate execution (execution-gate.md §4):
 *
 * - the **principal** key signs `MandateAuthorization(mandateDigest)`. It is
 *   the account whose funds the gate can move, so it is held here, by
 *   Mandate's custody, and never by the agent. Custody signs a gate mandate
 *   only after verifying, itself, that the committed ledger holds the
 *   `ADMIT_ATTEMPT` for exactly that artifact (`verifyAdmitted`) — the 7E.2
 *   rule, applied to an EVM artifact. It is given an attempt id and the
 *   artifact, never a hash to sign.
 * - the **agent** key signs the execution commitment. Authentication of the
 *   agent is never principal authority (Phase 6): the agent key alone moves
 *   nothing, because nothing settles without the principal's signature.
 *
 * There is no `sign(bytes)` here. `LocalGateCustody.signMandate` signs only a
 * gate mandate it re-derived and found admitted; `LocalAgentSigner` signs only
 * an execution commitment under a gate domain.
 *
 * **Reference separation.** In 7E.3 custody runs in the signer's process and
 * reads the ledger through the store's committed view. The Lighter custody's
 * separate process and read-only SQLite handle (7E.2) are the stronger
 * deployment; this one is testnet-only and says so.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { AdapterRef, ModuleRef, ReservationGeneration, ReservationId, ActionId } from '@mandate/core';
import type { AttemptId, AttemptRecord, LedgerState } from '@mandate/ledger';
import { recoverSigner } from '@mandate/execution-gate';
import { ARTIFACT_KIND } from './adapter.ts';
import { agentSigningHash, checkGateArtifact, principalSigningHash, slotScope, type ArtifactTerms, type GateArtifact } from './gate.ts';
import { hexBytes, toHex } from './abi.ts';
import { accountResource, type Address } from './vocabulary.ts';

export type CustodyResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** What the signer claims; custody checks every part of it against the committed ledger. */
export interface GateClaim {
  readonly attempt: AttemptId;
  readonly reservation: ReservationId;
  readonly generation: ReservationGeneration;
  readonly action: ActionId;
}

export interface GateKeyCustody {
  /** The principal address this custody signs for. */
  principal(): Address;
  /** Sign `artifact`'s mandate for the principal, only if `claim` is a committed, live, unissued attempt for exactly it. */
  signMandate(artifact: GateArtifact, terms: ArtifactTerms, claim: GateClaim): CustodyResult<string>;
}

export interface AgentSigner {
  address(): Address;
  /** Sign `artifact`'s execution commitment under its gate domain. */
  signExecution(artifact: GateArtifact): CustodyResult<string>;
}

/** What custody reads to verify an attempt: the committed ledger, the issuance journal, the lifecycle rows, its own clock. */
export interface CustodyView {
  readonly ledger: () => LedgerState;
  readonly issued: (attempt: AttemptId) => boolean;
  readonly lifecycle: (kind: 'MODULE' | 'ADAPTER', name: string, version: number) => { readonly status: string; readonly digest: string } | null;
  /** Unix seconds: chain time as custody observes it. */
  readonly now: () => bigint;
}

export interface CustodyBinding {
  readonly module: ModuleRef;
  readonly adapter: AdapterRef;
}

function addressOfKey(key: Uint8Array): Address {
  const pub = secp256k1.getPublicKey(key, false);
  return toHex(keccak_256(pub.subarray(1)).subarray(12));
}

/** 65-byte `r ‖ s ‖ v`, `v ∈ {27, 28}`, low `s` — the only form the gate accepts. */
function signPrehashed(hash: Uint8Array, key: Uint8Array): string {
  const sig = secp256k1.sign(hash, key, { prehash: false, format: 'recovered', lowS: true });
  const out = new Uint8Array(65);
  out.set(sig.subarray(1), 0);
  out[64] = (sig[0] as number) + 27;
  return toHex(out);
}

function parseKey(privateKeyHex: string): Uint8Array {
  if (!/^0x[0-9a-f]{64}$/.test(privateKeyHex)) throw new Error('private key must be 32 bytes of lowercase 0x hex');
  return hexBytes(privateKeyHex);
}

/**
 * Custody's own check, before the principal key is touched. Refusal codes
 * mirror the Lighter custody's (implementation-7e2.md §2) where the check is
 * the same.
 */
export function verifyAdmitted(view: CustodyView, binding: CustodyBinding, principal: Address, artifact: GateArtifact, terms: ArtifactTerms, claim: GateClaim): string | null {
  if (!/^0x[0-9a-f]{64}$/.test(claim.attempt)) return 'ATTEMPT_ID_MISSING';
  const state = view.ledger();
  const a: AttemptRecord | undefined = state.attempts.get(claim.attempt);
  if (a === undefined) return 'ATTEMPT_NOT_ADMITTED';
  if (a.module.moduleDigest !== binding.module.moduleDigest || a.module.moduleId !== binding.module.moduleId || a.module.moduleVersion !== binding.module.moduleVersion) return 'MODULE_NOT_SERVED';
  if (a.adapter.adapterDigest !== binding.adapter.adapterDigest || a.adapter.adapterId !== binding.adapter.adapterId || a.adapter.adapterVersion !== binding.adapter.adapterVersion) return 'ADAPTER_NOT_SERVED';
  if (a.reservation !== claim.reservation || a.generation !== claim.generation || a.action !== claim.action) return 'RESERVATION_MISMATCH';
  if (a.venueAccount.localId !== accountResource(terms.gate.chainId, principal).localId) return 'ACCOUNT_MISMATCH';
  if (terms.principal !== principal || artifact.mandate.principal !== principal) return 'PRINCIPAL_NOT_SERVED';
  // Custody re-derives the artifact from the attempt's own identity: the mandate id names this attempt's authorization, generation and adapter.
  const bad = checkGateArtifact(artifact, { executionId: a.authorization, authorizationId: artifact.candidate.evaluationStateDigest as never, reservation: a.reservation, generation: a.generation, adapter: a.adapter, evaluatedAt: artifact.mandate.createdAtUnixSeconds, validUntil: artifact.mandate.expiresAtUnixSeconds }, terms);
  if (bad !== null) return `ARTIFACT_INVALID.${bad}`;
  if (a.artifact.kind !== ARTIFACT_KIND || toHex(a.artifact.id) !== artifact.commitment) return 'ARTIFACT_NOT_ADMITTED';
  if (a.slot === null || a.slot.scope !== slotScope(terms.gate.chainId, terms.gate.gate, principal) || a.slot.sequence !== artifact.mandate.nonce) return 'SLOT_MISMATCH';
  if (view.now() >= a.validUntil || artifact.terms.deadline >= a.validUntil) return 'ATTEMPT_EXPIRED';
  if (state.reservations.get(a.reservation)?.status !== 'ACTIVE') return 'RESERVATION_CLOSED';
  if (view.issued(claim.attempt)) return 'ATTEMPT_ALREADY_ISSUED';
  for (const [kind, name, version, digest] of [
    ['MODULE', binding.module.moduleId, binding.module.moduleVersion, binding.module.moduleDigest],
    ['ADAPTER', binding.adapter.adapterId, binding.adapter.adapterVersion, binding.adapter.adapterDigest],
  ] as const) {
    const lc = view.lifecycle(kind, name, version);
    if (lc === null) return `${kind}_LIFECYCLE_UNKNOWN`;
    if (lc.digest !== digest) return `${kind}_LIFECYCLE_OTHER_DIGEST`;
    if (lc.status !== 'ACTIVE' && lc.status !== 'RETIRING') return `${kind}_${lc.status}`;
  }
  return null;
}

export class LocalGateCustody implements GateKeyCustody {
  readonly #key: Uint8Array;
  readonly #address: Address;
  readonly #view: CustodyView;
  readonly #binding: CustodyBinding;

  constructor(privateKeyHex: string, view: CustodyView, binding: CustodyBinding) {
    this.#key = parseKey(privateKeyHex);
    this.#address = addressOfKey(this.#key);
    this.#view = view;
    this.#binding = binding;
  }

  principal(): Address {
    return this.#address;
  }

  signMandate(artifact: GateArtifact, terms: ArtifactTerms, claim: GateClaim): CustodyResult<string> {
    const refusal = verifyAdmitted(this.#view, this.#binding, this.#address, artifact, terms, claim);
    if (refusal !== null) return { ok: false, error: refusal };
    const hash = principalSigningHash(artifact);
    const sig = signPrehashed(hash, this.#key);
    // Defence in depth: the signature must recover to this principal under the gate's own rule.
    if (recoverSigner(hash, sig) !== this.#address) return { ok: false, error: 'SIGNATURE_SELF_CHECK_FAILED' };
    return { ok: true, value: sig };
  }
}

export class LocalAgentSigner implements AgentSigner {
  readonly #key: Uint8Array;
  readonly #address: Address;

  constructor(privateKeyHex: string) {
    this.#key = parseKey(privateKeyHex);
    this.#address = addressOfKey(this.#key);
  }

  address(): Address {
    return this.#address;
  }

  signExecution(artifact: GateArtifact): CustodyResult<string> {
    if (artifact.mandate.agent !== this.#address || artifact.candidate.agent !== this.#address) return { ok: false, error: 'NOT_THIS_AGENT' };
    return { ok: true, value: signPrehashed(agentSigningHash(artifact), this.#key) };
  }
}

/** The address a 32-byte private key controls. */
export function keyAddress(privateKeyHex: string): Address {
  return addressOfKey(parseKey(privateKeyHex));
}
