/**
 * The exact gate artifact for one Mandate Core authorization (Phase 7E.3).
 *
 * The frozen Phase 6 gate executes a principal-signed MCE v2 mandate, an
 * agent-signed execution commitment over a Candidate V3, and execution terms
 * (execution-gate.md §3). This module derives all three — every field — from
 * a committed Core `AuthorizationRecord`, the action payload it commits to,
 * the reviewed market, and the gate slot the signer allocated. Nothing is
 * taken from the agent beyond the payload the authorization already binds.
 *
 * How Core identity reaches the chain without changing a frozen schema:
 *
 * | Core fact                          | Gate field it is bound into                                   |
 * | ---------------------------------- | ------------------------------------------------------------- |
 * | execution authorization id, reservation, generation, adapter digest | `mandate.mandateId` (principal-signed) |
 * | gate slot sequence (ledger-unique) | `mandate.nonce` (principal-signed)                            |
 * | attempt ceiling `validUntil`       | `mandate.expiresAt` (principal-signed; the gate refuses at it) |
 * | authorization record id            | `candidate.evaluationStateDigest` (agent-signed)              |
 * | reviewed market snapshot digest    | `candidate.registrySnapshotDigest` (agent-signed)             |
 * | exact quantity, price, notional, fee | candidate fields (agent-signed; the gate re-derives them)   |
 * | worst-case debit (capital reserved) | `mandate.economicLimit` and `terms.fundingLimit`             |
 * | recipient                          | `terms.recipient` = the principal (gate-enforced)             |
 * | chain and gate                     | the EIP-712 domain of both signatures                         |
 *
 * The mandate is **per reservation generation**: its digest is the gate's
 * replay key, so one generation can settle at most once onchain, and a gate
 * mandate for generation `n` names `n` and cannot be read as `n + 1`.
 *
 * Pure: no network, clock or key.
 */

import { ByteWriter, eip712SigningHash, keccak256, type Bytes32, type Eip712Domain } from '@mandate/kernel';
import { keccakDigest, writeDigest, type AdapterRef, type Digest32, type ReservationGeneration, type ReservationId, type ExecutionAuthorizationId } from '@mandate/core';
import { caip2, eip712Hash, encodeGateCandidate, encodeGateMandate, executionCommitment, gateDomain, HALT_POLICY_CODE, SIDE_CODE, SYNTHETIC_POLICY_CODE, type GateCandidate, type GateMandate, type GateTerms } from '@mandate/execution-gate';
import { buyCost, feeOn, grossCost, reviewedSnapshot, type ReviewedGate, type ReviewedMarket } from './market.ts';
import { encodeGateMarket, representationIdOf, type Address } from './vocabulary.ts';

/** Candidate V3's evaluation-state identifier for an artifact built from a Core authorization record. */
export const EVALUATION_STATE_ID = 'mandate-core.authorization-record';

/** The facts of the authorization an artifact is derived from. */
export interface ArtifactSource {
  readonly executionId: ExecutionAuthorizationId;
  readonly authorizationId: Digest32;
  readonly reservation: ReservationId;
  readonly generation: ReservationGeneration;
  readonly adapter: AdapterRef;
  /** Core's decision time: the gate mandate's creation and start. */
  readonly evaluatedAt: bigint;
  /** Core's attempt ceiling: the gate mandate expires at it. */
  readonly validUntil: bigint;
}

export interface ArtifactTerms {
  readonly gate: ReviewedGate;
  readonly market: ReviewedMarket;
  readonly principal: Address;
  readonly agent: Address;
  readonly quantity: bigint;
  /** The gate slot sequence the ledger admits, used as the mandate nonce. */
  readonly nonce: bigint;
  /** Chain-time deadline for this attempt, inclusive; strictly before `validUntil`. */
  readonly deadline: bigint;
}

export interface GateArtifact {
  readonly mandate: GateMandate;
  readonly candidate: GateCandidate;
  readonly terms: GateTerms;
  readonly mandateDigest: Bytes32;
  readonly candidateDigest: Bytes32;
  /** What the agent signs, the gate records, and `ADMIT_ATTEMPT` commits. */
  readonly commitment: Bytes32;
  readonly domain: Eip712Domain;
}

/**
 * `keccak256("mandate/evm-robinhood/gate-mandate-id" ‖ v1 ‖ executionId ‖
 * reservation ‖ generation ‖ adapterDigest)` — the principal-signed name of
 * exactly one reservation generation issued through exactly one adapter.
 */
export function gateMandateId(s: Pick<ArtifactSource, 'executionId' | 'reservation' | 'generation' | 'adapter'>): Bytes32 {
  const w = new ByteWriter().str('mandate/evm-robinhood/gate-mandate-id').u16(1);
  writeDigest(w, s.executionId);
  writeDigest(w, s.reservation);
  w.u64(s.generation);
  writeDigest(w, s.adapter.adapterDigest);
  return keccakDigest<Digest32>(w.finish()) as string as Bytes32;
}

/** The ledger's slot scope for one principal on one gate: `evm:<chain>:gate:<gate>:principal:<address>`. */
export function slotScope(chainId: bigint, gate: Address, principal: Address): string {
  return `evm:${chainId.toString(10)}:gate:${gate}:principal:${principal}`;
}

export function reviewedMarketDigest(gate: ReviewedGate, market: ReviewedMarket): Bytes32 {
  return keccak256(encodeGateMarket(reviewedSnapshot(gate.chainId, gate.gate, market)));
}

export function buildGateArtifact(src: ArtifactSource, t: ArtifactTerms): GateArtifact {
  const m = t.market;
  const chain = caip2(t.gate.chainId);
  const gross = grossCost(m, t.quantity);
  const fee = feeOn(m, gross);
  const cost = buyCost(m, t.quantity);
  const settle = (atoms: bigint) => ({ unit: m.settlementUnit, decimals: m.fundingDecimals, atoms });
  const mandate: GateMandate = {
    version: 2n,
    mandateId: gateMandateId(src),
    nonce: t.nonce,
    principal: t.principal,
    agent: t.agent,
    canonicalAsset: m.canonicalAsset,
    side: BigInt(SIDE_CODE.BUY),
    // The true product at funding precision, rounded up: exactly what the gate's maxNotional rule renders.
    maxNotional: settle(gross),
    // MAX_TOTAL_DEBIT: the venue's exact quote, fee included — the capital Core reserved.
    economicLimit: settle(cost),
    maxDeviationBps: 0n,
    syntheticPolicy: BigInt(m.synthetic ? SYNTHETIC_POLICY_CODE.ALLOWED : SYNTHETIC_POLICY_CODE.FORBIDDEN),
    allowedIssuers: [m.issuer],
    allowedChains: [chain],
    allowedVenues: [m.venueId],
    requiredCorporateActionEpoch: 1n,
    maxPriceAgeSeconds: 60n,
    maxCorporateActionAgeSeconds: 3_600n,
    haltPolicy: BigInt(HALT_POLICY_CODE.FORBID_WHEN_HALTED),
    createdAtUnixSeconds: src.evaluatedAt,
    notBeforeUnixSeconds: src.evaluatedAt,
    expiresAtUnixSeconds: src.validUntil,
  };
  const candidate: GateCandidate = {
    version: 3n,
    representationId: representationIdOf(t.gate.chainId, m.representation),
    canonicalAsset: m.canonicalAsset,
    issuer: m.issuer,
    chain,
    venue: m.venueId,
    side: BigInt(SIDE_CODE.BUY),
    agent: t.agent,
    quantity: { unit: m.quantityUnit, decimals: m.representationDecimals, atoms: t.quantity },
    executionPrice: { numeratorUnit: m.settlementUnit, denominatorUnit: m.quantityUnit, decimals: m.fixturePrice.decimals, atoms: m.fixturePrice.atoms },
    notional: settle(gross),
    feeTotal: settle(fee),
    evaluationStateId: EVALUATION_STATE_ID,
    evaluationStateDigest: src.authorizationId,
    registrySnapshotDigest: reviewedMarketDigest(t.gate, m),
    corporateActionEpoch: 1n,
  };
  const terms: GateTerms = { recipient: t.principal, fundingLimit: cost, deadline: t.deadline, executionData: '0x' };
  const mandateDigest = keccak256(encodeGateMandate(mandate));
  const candidateDigest = keccak256(encodeGateCandidate(candidate));
  const commitment = executionCommitment({ mandateDigest, candidateDigest, terms });
  return { mandate, candidate, terms, mandateDigest, candidateDigest, commitment, domain: gateDomain(t.gate.chainId, t.gate.gate) };
}

/**
 * Why `a` is not exactly the artifact `src` and `t` determine, or `null`.
 * Applied to whatever is about to be admitted and to whatever custody is
 * asked to sign: a construction bug or a substituted field cannot reach a key.
 */
export function checkGateArtifact(a: GateArtifact, src: ArtifactSource, t: ArtifactTerms): string | null {
  const expected = buildGateArtifact(src, t);
  if (t.deadline >= src.validUntil) return 'DEADLINE_NOT_BEFORE_CEILING';
  if (a.mandate.principal !== t.principal || a.terms.recipient !== t.principal) return 'PRINCIPAL_OR_RECIPIENT_MISMATCH';
  if (a.mandate.agent !== t.agent || a.candidate.agent !== t.agent) return 'AGENT_MISMATCH';
  if (a.candidate.quantity.atoms !== t.quantity) return 'QUANTITY_MISMATCH';
  if (a.terms.fundingLimit !== buyCost(t.market, t.quantity) || a.mandate.economicLimit.atoms !== a.terms.fundingLimit) return 'DEBIT_MISMATCH';
  if (a.terms.executionData !== '0x') return 'EXECUTION_DATA_NOT_EMPTY';
  if (a.mandate.mandateId !== gateMandateId(src) || a.mandate.nonce !== t.nonce) return 'MANDATE_IDENTITY_MISMATCH';
  if (a.mandate.expiresAtUnixSeconds !== src.validUntil) return 'EXPIRY_MISMATCH';
  if (a.mandateDigest !== keccak256(encodeGateMandate(a.mandate)) || a.candidateDigest !== keccak256(encodeGateCandidate(a.candidate))) return 'DIGEST_MISMATCH';
  if (a.commitment !== executionCommitment({ mandateDigest: a.mandateDigest, candidateDigest: a.candidateDigest, terms: a.terms })) return 'COMMITMENT_MISMATCH';
  if (a.mandateDigest !== expected.mandateDigest || a.candidateDigest !== expected.candidateDigest || a.commitment !== expected.commitment) return 'ARTIFACT_NOT_DERIVED';
  if (a.domain.chainId !== t.gate.chainId || a.domain.verifyingContract !== t.gate.gate) return 'DOMAIN_MISMATCH';
  return null;
}

/** The bytes the principal signs: `MandateAuthorization(mandateDigest)` under the gate's domain. */
export function principalSigningHash(a: GateArtifact): Uint8Array {
  return eip712SigningHash(a.domain, a.mandateDigest);
}

/** The bytes the agent signs: `ExecutionAuthorization(...)` under the gate's domain. */
export function agentSigningHash(a: GateArtifact): Uint8Array {
  return eip712Hash(a.domain, a.commitment);
}
