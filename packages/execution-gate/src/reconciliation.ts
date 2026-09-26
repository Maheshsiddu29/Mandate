/**
 * From chain evidence to a kernel `ExecutionObservation`.
 *
 * Phase 5R left reconciliation holding a *validated assertion*: an observation
 * had to be complete and temporally possible, but nothing checked that the
 * referenced execution happened (ADR 0018). The gate makes the chain the
 * authority. This module is the narrow bridge: given what a reader observed of
 * the gate, at a stated confirmation level, it either produces the observation
 * the kernel's `RECONCILE` transition requires or refuses to produce one.
 *
 * It performs no I/O. Reading the chain is the caller's job; deciding what the
 * reading establishes is this function's, and it is pure so the rule can be
 * tested exhaustively.
 *
 * The rule, in full:
 *
 * - below the required confirmation level, nothing is established;
 * - evidence about a different chain, gate or mandate establishes nothing;
 * - `executionCommitmentOf(mandateDigest) != 0` with a matching
 *   `MandateExecuted` log is SETTLED — the authorization is consumed, whichever
 *   signed attempt consumed it;
 * - `executionCommitmentOf(mandateDigest) == 0` is FAILED **only** once the
 *   state read is at a block past the attempt's deadline, because before then
 *   the signed attempt can still land. A reverted receipt is not enough on its
 *   own: a byte-identical copy of the same attempt may have been included by
 *   someone else;
 * - anything contradictory is refused, never repaired.
 *
 * It is a public plain-value boundary (docs/public-trust-boundaries.md, class A):
 * evidence arrives from an RPC reader, so every argument is parsed strictly
 * first and a malformed one is `EVIDENCE_MALFORMED`, never an exception.
 *
 * The onchain gate already makes double settlement impossible, so a FAILED here
 * is an availability decision for the offchain record, not a safety one.
 */

import {
  ReconciledOutcome,
  parseBigInt,
  parseBytes32,
  parseExecutionObservation,
  parseIdentifier,
  parseUnixSeconds,
  type Bytes32,
  type ExecutionObservation,
} from '@mandate/kernel';
import { ADDRESS_PATTERN, type Address } from './wire.ts';

export const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Bytes32;

/**
 * How far along the chain's own finality a reading is.
 *
 * For an Arbitrum-family chain such as Robinhood Chain: SUBMITTED is a
 * broadcast transaction; MINED is a receipt in a sequencer block (a soft
 * confirmation); CONFIRMED is a block at or below the node's `safe` tag (its
 * batch is posted to the parent chain); FINALIZED is at or below `finalized`
 * (the parent chain has finalized that batch). The mapping lives here and in the
 * caller's policy, never in the gate.
 */
export const ConfirmationLevel = {
  SUBMITTED: 'SUBMITTED',
  MINED: 'MINED',
  CONFIRMED: 'CONFIRMED',
  FINALIZED: 'FINALIZED',
} as const;
export type ConfirmationLevel = (typeof ConfirmationLevel)[keyof typeof ConfirmationLevel];

const RANK: Record<ConfirmationLevel, number> = { SUBMITTED: 0, MINED: 1, CONFIRMED: 2, FINALIZED: 3 };

export interface ReconciliationPolicy {
  /** The least level at which a reading may resolve an authorization. `FINALIZED` by default in docs. */
  readonly requiredLevel: ConfirmationLevel;
  /** Recorded on the observation as who observed it. */
  readonly sourceId: string;
}

/** What the reserving pipeline recorded when it signed the attempt. */
export interface GateAttemptRecord {
  readonly chainId: bigint;
  readonly gate: Address;
  readonly mandateDigest: Bytes32;
  readonly executionCommitment: Bytes32;
  readonly deadline: bigint;
}

/** One reading of the gate, taken at one block. */
export interface GateChainEvidence {
  readonly level: ConfirmationLevel;
  readonly chainId: bigint;
  readonly gate: Address;
  readonly mandateDigest: Bytes32;
  /** `executionCommitmentOf(mandateDigest)` at the reading's block. */
  readonly consumedCommitment: Bytes32;
  /** Timestamp of the block the reading was taken at. */
  readonly blockTimestamp: bigint;
  /** The `MandateExecuted` log for this mandate digest at or before that block, if any. */
  readonly settlement: { readonly transactionHash: Bytes32; readonly executionCommitment: Bytes32 } | null;
  readonly observedAtUnixSeconds: bigint;
}

export const ReconciliationRefusal = {
  EVIDENCE_MALFORMED: 'EVIDENCE_MALFORMED',
  NOT_FINAL: 'NOT_FINAL',
  EVIDENCE_MISMATCH: 'EVIDENCE_MISMATCH',
  EVIDENCE_INCONSISTENT: 'EVIDENCE_INCONSISTENT',
  OUTCOME_UNESTABLISHED: 'OUTCOME_UNESTABLISHED',
  OBSERVATION_INVALID: 'OBSERVATION_INVALID',
} as const;
export type ReconciliationRefusal = (typeof ReconciliationRefusal)[keyof typeof ReconciliationRefusal];

export type ReconciliationResult =
  | {
      readonly ok: true;
      readonly observation: ExecutionObservation;
      /** The commitment that consumed the authorization, when it settled. May differ from the recorded attempt's. */
      readonly settledCommitment: Bytes32 | null;
    }
  | { readonly ok: false; readonly refusal: ReconciliationRefusal };

function refuse(refusal: ReconciliationRefusal): ReconciliationResult {
  return { ok: false, refusal };
}

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function level(raw: unknown): ConfirmationLevel | undefined {
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(ConfirmationLevel, raw) ? (raw as ConfirmationLevel) : undefined;
}

function address(raw: unknown): Address | undefined {
  return typeof raw === 'string' && ADDRESS_PATTERN.test(raw) ? raw : undefined;
}

function unsigned(raw: unknown): bigint | undefined {
  const v = parseBigInt(raw);
  return v !== undefined && v >= 0n && v < 2n ** 256n ? v : undefined;
}

function bytes32(raw: unknown): Bytes32 | undefined {
  const v = parseBytes32(raw, 'MALFORMED_AUTHORIZATION');
  return v.ok ? v.value : undefined;
}

function unixSeconds(raw: unknown): bigint | undefined {
  const v = parseUnixSeconds(raw, 'MALFORMED_TRUSTED_STATE');
  return v.ok ? v.value : undefined;
}

function parseAttempt(raw: unknown): GateAttemptRecord | undefined {
  const r = record(raw);
  if (r === undefined) return undefined;
  const chainId = unsigned(r['chainId']);
  const gate = address(r['gate']);
  const mandateDigest = bytes32(r['mandateDigest']);
  const executionCommitment = bytes32(r['executionCommitment']);
  const deadline = unsigned(r['deadline']);
  if (chainId === undefined || gate === undefined || mandateDigest === undefined || executionCommitment === undefined || deadline === undefined) {
    return undefined;
  }
  return { chainId, gate, mandateDigest, executionCommitment, deadline };
}

function parseEvidence(raw: unknown): GateChainEvidence | undefined {
  const r = record(raw);
  if (r === undefined) return undefined;
  const lvl = level(r['level']);
  const chainId = unsigned(r['chainId']);
  const gate = address(r['gate']);
  const mandateDigest = bytes32(r['mandateDigest']);
  const consumedCommitment = bytes32(r['consumedCommitment']);
  const blockTimestamp = unixSeconds(r['blockTimestamp']);
  const observedAtUnixSeconds = unixSeconds(r['observedAtUnixSeconds']);
  if (
    lvl === undefined || chainId === undefined || gate === undefined || mandateDigest === undefined ||
    consumedCommitment === undefined || blockTimestamp === undefined || observedAtUnixSeconds === undefined
  ) {
    return undefined;
  }
  let settlement: GateChainEvidence['settlement'] = null;
  if (r['settlement'] !== null) {
    const s = record(r['settlement']);
    const transactionHash = bytes32(s?.['transactionHash']);
    const executionCommitment = bytes32(s?.['executionCommitment']);
    if (transactionHash === undefined || executionCommitment === undefined) return undefined;
    settlement = { transactionHash, executionCommitment };
  }
  return { level: lvl, chainId, gate, mandateDigest, consumedCommitment, blockTimestamp, settlement, observedAtUnixSeconds };
}

function parsePolicy(raw: unknown): ReconciliationPolicy | undefined {
  const r = record(raw);
  const requiredLevel = level(r?.['requiredLevel']);
  const sourceId = parseIdentifier(r?.['sourceId']);
  if (requiredLevel === undefined || !sourceId.ok) return undefined;
  return { requiredLevel, sourceId: sourceId.value };
}

export function observationFromGateEvidence(rawAttempt: unknown, rawEvidence: unknown, rawPolicy: unknown): ReconciliationResult {
  const attempt = parseAttempt(rawAttempt);
  const evidence = parseEvidence(rawEvidence);
  const policy = parsePolicy(rawPolicy);
  if (attempt === undefined || evidence === undefined || policy === undefined) return refuse('EVIDENCE_MALFORMED');

  if (RANK[evidence.level] < RANK[policy.requiredLevel]) return refuse('NOT_FINAL');

  if (evidence.chainId !== attempt.chainId || evidence.gate !== attempt.gate || evidence.mandateDigest !== attempt.mandateDigest) {
    return refuse('EVIDENCE_MISMATCH');
  }

  let outcome: ReconciledOutcome;
  let reference: Bytes32;
  let settledCommitment: Bytes32 | null = null;
  if (evidence.consumedCommitment !== ZERO_BYTES32) {
    if (evidence.settlement === null || evidence.settlement.executionCommitment !== evidence.consumedCommitment) {
      return refuse('EVIDENCE_INCONSISTENT');
    }
    outcome = ReconciledOutcome.SETTLED;
    reference = evidence.settlement.transactionHash;
    settledCommitment = evidence.consumedCommitment;
  } else {
    if (evidence.settlement !== null) return refuse('EVIDENCE_INCONSISTENT');
    // Until chain time passes the deadline, the signed attempt can still land.
    if (evidence.blockTimestamp <= attempt.deadline) return refuse('OUTCOME_UNESTABLISHED');
    outcome = ReconciledOutcome.FAILED;
    reference = attempt.executionCommitment;
  }

  const parsed = parseExecutionObservation({
    outcome,
    observedAtUnixSeconds: evidence.observedAtUnixSeconds,
    sourceId: policy.sourceId,
    reference,
  });
  if (!parsed.ok) return refuse('OBSERVATION_INVALID');
  return { ok: true, observation: parsed.value, settledCommitment };
}
