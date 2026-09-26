/**
 * From chain evidence to a kernel `ExecutionObservation`, and the signing rule
 * that makes that evidence decisive.
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
 * ## Two different facts (Phase 6R.1a)
 *
 * The gate's replay key is the mandate digest, so an agent can sign any number
 * of execution attempts of one mandate, each with its own chain-time deadline,
 * and whichever lands first consumes it. Two facts therefore have to be kept
 * apart:
 *
 * - **the attempts failed** — every attempt that could still settle under the
 *   current reservation is past its deadline and nothing consumed the mandate.
 *   `RECONCILE(FAILED)` then returns the record to `UNUSED` and the mandate may
 *   be tried again while it is still valid;
 * - **the mandate expired** — the gate refuses every attempt from the mandate's
 *   `expiresAt` on, whoever signed it.
 *
 * Phase 6R.1 waited for the second fact before reporting the first, which made a
 * retry after any reverted attempt impossible for the mandate's whole life.
 *
 * ## The reservation bounds every attempt signed under it
 *
 * `admitAttemptUnderReservation` is the pre-signing rule: an execution attempt
 * may be signed only while the kernel's replay record for this mandate is
 * `RESERVED` and live, and only with a deadline at or before that reservation's
 * expiry. The reservation expiry is therefore a ceiling on the deadline of every
 * attempt signed under it — one number, however many attempts there are (at
 * most `MAX_ATTEMPTS_PER_RESERVATION`, recorded with their commitments).
 *
 * `observationFromGateEvidence` then reports:
 *
 * - `SETTLED` whenever `executionCommitmentOf(mandateDigest) != 0` with a
 *   matching `MandateExecuted` log, whichever attempt consumed it, saying
 *   whether it was one this reservation recorded;
 * - `FAILED` (basis `ATTEMPTS_EXPIRED`) for an unconsumed final reading at a
 *   block whose timestamp is past the reservation's expiry. Every attempt signed
 *   under the reservation has a deadline at or before it, the gate's deadline
 *   check is `block.timestamp > deadline`, and chain timestamps never decrease,
 *   so none of them can ever land. Attempts signed under an earlier reservation
 *   were already past *their* ceiling when that reservation was reconciled
 *   FAILED, so they cannot land either;
 * - `FAILED` (basis `MANDATE_EXPIRED`) for an unconsumed final reading at or
 *   after the mandate's own expiry, which holds for every attempt ever signed;
 * - nothing otherwise (`OUTCOME_UNESTABLISHED`).
 *
 * Nothing here takes a caller's word for a time. The mandate arrives as the MCE
 * v2 bytes the principal signed, so its digest and expiry are derived; each
 * recorded attempt carries its execution commitment, which must re-derive from
 * its fields, so its deadline is the one the chain would enforce; and the
 * reservation is the kernel's own replay record for that digest.
 *
 * ## An observation resolves only the reservation it was derived from (Phase 6R.1b)
 *
 * The verdicts above hold for the reservation in the record they were derived
 * from, and for no other. A mandate whose attempts failed is reserved again, and
 * the new reservation admits new attempts; a FAILED observation derived from the
 * earlier record — delivered late, or derived afresh from an out-of-date copy of
 * it — says nothing about them. So the observation carries that record's
 * `reservationGeneration`, taken from the record and from nowhere else, and the
 * kernel's `RECONCILE` refuses it against a record of any other generation
 * (`STALE_RESERVATION_OBSERVATION`). The mandate digest cannot make this
 * distinction: every reservation of one mandate shares it.
 *
 * The one assumption is signing discipline: the agent signs attempts only
 * through `admitAttemptUnderReservation`. Mandate-supported agents must create
 * execution authorizations through it for these guarantees to hold; the gate
 * cannot enforce it, because the signed authorization deliberately carries no
 * reservation. An attempt signed outside it is not bounded by the reservation. It still cannot settle twice — the gate consumes
 * the digest at most once — and if it settles, reconciliation reports `SETTLED`
 * with `settledByRecordedAttempt: false`. A record that itself carries an attempt
 * past its reservation proves the discipline was broken, so it is refused until
 * the mandate expires.
 *
 * Both functions are public plain-value boundaries (docs/public-trust-boundaries.md,
 * class A): every argument is parsed strictly, and malformed input is refused,
 * never thrown.
 */

import {
  ReconciledOutcome,
  ReplayStatus,
  decodeMandate,
  hexToBytes,
  keccak256,
  parseBigInt,
  parseBytes32,
  parseExecutionObservation,
  parseIdentifier,
  parseReplayRecord,
  parseUnixSeconds,
  type Bytes32,
  type ExecutionObservation,
  type ReplayRecord,
} from '@mandate/kernel';
import { executionCommitment } from './commitment.ts';
import { MAX_EXECUTION_DATA_BYTES } from './model.ts';
import { ADDRESS_PATTERN, type Address, type GateTerms } from './wire.ts';

export const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Bytes32;

/**
 * Attempts one reservation may carry. Enough for re-signing with a new funding
 * limit or route; small enough that a record stays bounded.
 */
export const MAX_ATTEMPTS_PER_RESERVATION = 8;

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

/** One signed execution attempt, as signed. */
export interface GateSignedAttempt {
  readonly candidateDigest: Bytes32;
  readonly terms: GateTerms;
  /** Must equal `executionCommitment` of the fields above, or the record is refused. */
  readonly executionCommitment: Bytes32;
}

/** What the reserving pipeline holds for one mandate while a reservation is open. */
export interface GateReservationRecord {
  readonly chainId: bigint;
  readonly gate: Address;
  /** The MCE v2 bytes the principal signed, lowercase hex. Digest and expiry are derived from them. */
  readonly mandateEncoding: string;
  /** The kernel replay record for that digest: `RESERVED` or `QUARANTINED`. */
  readonly reservation: ReplayRecord;
  /** Every attempt signed under this reservation, in signing order. */
  readonly attempts: readonly GateSignedAttempt[];
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
  /** The replay record is about another mandate. */
  RESERVATION_MISMATCH: 'RESERVATION_MISMATCH',
  /** The replay record holds no reservation to resolve (not `RESERVED` or `QUARANTINED`). */
  NOT_RESOLVABLE: 'NOT_RESOLVABLE',
  /** A recorded attempt's deadline is past its reservation, so the reservation no longer bounds the attempts. */
  ATTEMPT_OUTSIDE_RESERVATION: 'ATTEMPT_OUTSIDE_RESERVATION',
  OUTCOME_UNESTABLISHED: 'OUTCOME_UNESTABLISHED',
  OBSERVATION_INVALID: 'OBSERVATION_INVALID',
} as const;
export type ReconciliationRefusal = (typeof ReconciliationRefusal)[keyof typeof ReconciliationRefusal];

/** Why an unconsumed mandate is FAILED. */
export const FailureBasis = {
  /** Every attempt under the reservation is past its deadline; the mandate is still valid and may be retried. */
  ATTEMPTS_EXPIRED: 'ATTEMPTS_EXPIRED',
  /** The mandate itself has expired; `verify` will refuse it (`MANDATE_EXPIRED`) once it is UNUSED again. */
  MANDATE_EXPIRED: 'MANDATE_EXPIRED',
} as const;
export type FailureBasis = (typeof FailureBasis)[keyof typeof FailureBasis];

export type ReconciliationResult =
  | {
      readonly ok: true;
      readonly observation: ExecutionObservation;
      /** The commitment that consumed the authorization, when it settled. */
      readonly settledCommitment: Bytes32 | null;
      /** Whether that commitment is one this reservation recorded; null unless settled. */
      readonly settledByRecordedAttempt: boolean | null;
      /** Why it failed; null unless failed. */
      readonly failureBasis: FailureBasis | null;
    }
  | { readonly ok: false; readonly refusal: ReconciliationRefusal };

export const AttemptRefusal = {
  ATTEMPT_MALFORMED: 'ATTEMPT_MALFORMED',
  RESERVATION_MISMATCH: 'RESERVATION_MISMATCH',
  /** The record is not `RESERVED`: nothing was reserved, the reservation lapsed into quarantine, or it is resolved. */
  NOT_RESERVED: 'NOT_RESERVED',
  /** The reservation's expiry has been reached on the pipeline's clock. */
  RESERVATION_LAPSED: 'RESERVATION_LAPSED',
  /** The attempt could still settle after the reservation that bounds it. */
  DEADLINE_BEYOND_RESERVATION: 'DEADLINE_BEYOND_RESERVATION',
  ATTEMPT_LIMIT_REACHED: 'ATTEMPT_LIMIT_REACHED',
  ATTEMPT_INCONSISTENT: 'ATTEMPT_INCONSISTENT',
} as const;
export type AttemptRefusal = (typeof AttemptRefusal)[keyof typeof AttemptRefusal];

export type AttemptAdmission =
  | {
      readonly ok: true;
      /** What the agent signs (under the gate's EIP-712 domain). */
      readonly executionCommitment: Bytes32;
      /** The record to store: the input record with this attempt appended, unless it was already there. */
      readonly record: GateReservationRecord;
    }
  | { readonly ok: false; readonly refusal: AttemptRefusal };

// --- Strict parsing -----------------------------------------------------------

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function level(raw: unknown): ConfirmationLevel | undefined {
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(ConfirmationLevel, raw) ? (raw as ConfirmationLevel) : undefined;
}

function address(raw: unknown): Address | undefined {
  return typeof raw === 'string' && ADDRESS_PATTERN.test(raw) ? raw : undefined;
}

function unsignedBelow(raw: unknown, limit: bigint): bigint | undefined {
  const v = parseBigInt(raw);
  return v !== undefined && v >= 0n && v < limit ? v : undefined;
}

function bytes32(raw: unknown): Bytes32 | undefined {
  const v = parseBytes32(raw, 'MALFORMED_AUTHORIZATION');
  return v.ok ? v.value : undefined;
}

function unixSeconds(raw: unknown): bigint | undefined {
  const v = parseUnixSeconds(raw, 'MALFORMED_TRUSTED_STATE');
  return v.ok ? v.value : undefined;
}

function terms(raw: unknown): GateTerms | undefined {
  const r = record(raw);
  const recipient = address(r?.['recipient']);
  const fundingLimit = unsignedBelow(r?.['fundingLimit'], 2n ** 256n);
  const deadline = unsignedBelow(r?.['deadline'], 2n ** 64n);
  const data = r?.['executionData'];
  const dataBytes = typeof data === 'string' ? hexToBytes(data) : undefined;
  if (recipient === undefined || fundingLimit === undefined || deadline === undefined || dataBytes === undefined) return undefined;
  if (dataBytes.length > MAX_EXECUTION_DATA_BYTES) return undefined;
  return { recipient, fundingLimit, deadline, executionData: data as string };
}

function signedAttempt(raw: unknown): GateSignedAttempt | undefined {
  const r = record(raw);
  const candidateDigest = bytes32(r?.['candidateDigest']);
  const t = terms(r?.['terms']);
  const commitment = bytes32(r?.['executionCommitment']);
  if (candidateDigest === undefined || t === undefined || commitment === undefined) return undefined;
  return { candidateDigest, terms: t, executionCommitment: commitment };
}

/** The signed mandate's digest and expiry, derived from its MCE v2 bytes. */
function signedMandate(raw: unknown): { encoding: string; digest: Bytes32; expiresAt: bigint } | undefined {
  if (typeof raw !== 'string') return undefined;
  const bytes = hexToBytes(raw);
  if (bytes === undefined) return undefined;
  const decoded = decodeMandate(bytes);
  if (!decoded.ok) return undefined;
  return { encoding: raw, digest: keccak256(bytes), expiresAt: decoded.value.expiresAtUnixSeconds };
}

interface ParsedRecord {
  readonly value: GateReservationRecord;
  readonly mandateDigest: Bytes32;
  readonly mandateExpiresAt: bigint;
}

function reservationRecord(raw: unknown): ParsedRecord | undefined {
  const r = record(raw);
  if (r === undefined) return undefined;
  const chainId = unsignedBelow(r['chainId'], 2n ** 256n);
  const gate = address(r['gate']);
  const mandate = signedMandate(r['mandateEncoding']);
  const reservation = parseReplayRecord(r['reservation']);
  const rawAttempts = r['attempts'];
  if (chainId === undefined || gate === undefined || mandate === undefined || !reservation.ok || !Array.isArray(rawAttempts)) return undefined;
  if (rawAttempts.length > MAX_ATTEMPTS_PER_RESERVATION) return undefined;
  const attempts: GateSignedAttempt[] = [];
  for (const a of rawAttempts) {
    const parsed = signedAttempt(a);
    if (parsed === undefined) return undefined;
    attempts.push(parsed);
  }
  return {
    value: { chainId, gate, mandateEncoding: mandate.encoding, reservation: reservation.value, attempts },
    mandateDigest: mandate.digest,
    mandateExpiresAt: mandate.expiresAt,
  };
}

function parseEvidence(raw: unknown): GateChainEvidence | undefined {
  const r = record(raw);
  if (r === undefined) return undefined;
  const lvl = level(r['level']);
  const chainId = unsignedBelow(r['chainId'], 2n ** 256n);
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

/** The attempt's commitment re-derived from its own fields. */
function commitmentOf(mandateDigest: Bytes32, a: GateSignedAttempt): Bytes32 {
  return executionCommitment({ mandateDigest, candidateDigest: a.candidateDigest, terms: a.terms });
}

// --- Pre-signing --------------------------------------------------------------

/**
 * Admit one execution attempt under the mandate's open reservation, or refuse.
 *
 * Call this before the agent signs, and store the returned record: it is the
 * only way an attempt should be signed, because it is what makes the
 * reservation's expiry a ceiling on every signed deadline. Re-admitting an
 * attempt already in the record returns it unchanged, so a rebroadcast of the
 * same signed attempt is not a new attempt.
 */
export function admitAttemptUnderReservation(rawRecord: unknown, rawAttempt: unknown, rawNowUnixSeconds: unknown): AttemptAdmission {
  const parsed = reservationRecord(rawRecord);
  const r = record(rawAttempt);
  const candidateDigest = bytes32(r?.['candidateDigest']);
  const t = terms(r?.['terms']);
  const now = unixSeconds(rawNowUnixSeconds);
  if (parsed === undefined || candidateDigest === undefined || t === undefined || now === undefined) {
    return { ok: false, refusal: 'ATTEMPT_MALFORMED' };
  }
  const { value, mandateDigest } = parsed;
  if (value.reservation.key !== mandateDigest) return { ok: false, refusal: 'RESERVATION_MISMATCH' };
  if (value.reservation.status !== ReplayStatus.RESERVED) return { ok: false, refusal: 'NOT_RESERVED' };
  const ceiling = value.reservation.reservationExpiresAtUnixSeconds;
  // A RESERVED record always carries its expiry; the kernel parser enforces it.
  if (ceiling === null || now >= ceiling) return { ok: false, refusal: 'RESERVATION_LAPSED' };
  if (t.deadline > ceiling) return { ok: false, refusal: 'DEADLINE_BEYOND_RESERVATION' };
  for (const existing of value.attempts) {
    if (commitmentOf(mandateDigest, existing) !== existing.executionCommitment) return { ok: false, refusal: 'ATTEMPT_INCONSISTENT' };
  }

  const attempt: GateSignedAttempt = { candidateDigest, terms: t, executionCommitment: executionCommitment({ mandateDigest, candidateDigest, terms: t }) };
  if (value.attempts.some((a) => a.executionCommitment === attempt.executionCommitment)) {
    return { ok: true, executionCommitment: attempt.executionCommitment, record: value };
  }
  if (value.attempts.length >= MAX_ATTEMPTS_PER_RESERVATION) return { ok: false, refusal: 'ATTEMPT_LIMIT_REACHED' };
  return { ok: true, executionCommitment: attempt.executionCommitment, record: { ...value, attempts: [...value.attempts, attempt] } };
}

// --- Reconciliation -----------------------------------------------------------

function refuse(refusal: ReconciliationRefusal): ReconciliationResult {
  return { ok: false, refusal };
}

export function observationFromGateEvidence(rawRecord: unknown, rawEvidence: unknown, rawPolicy: unknown): ReconciliationResult {
  const parsed = reservationRecord(rawRecord);
  const evidence = parseEvidence(rawEvidence);
  const policy = parsePolicy(rawPolicy);
  if (parsed === undefined || evidence === undefined || policy === undefined) return refuse('EVIDENCE_MALFORMED');
  const { value, mandateDigest, mandateExpiresAt } = parsed;

  if (RANK[evidence.level] < RANK[policy.requiredLevel]) return refuse('NOT_FINAL');

  if (evidence.chainId !== value.chainId || evidence.gate !== value.gate || evidence.mandateDigest !== mandateDigest) {
    return refuse('EVIDENCE_MISMATCH');
  }
  if (value.reservation.key !== mandateDigest) return refuse('RESERVATION_MISMATCH');
  const ceiling = value.reservation.reservationExpiresAtUnixSeconds;
  if ((value.reservation.status !== ReplayStatus.RESERVED && value.reservation.status !== ReplayStatus.QUARANTINED) || ceiling === null) {
    return refuse('NOT_RESOLVABLE');
  }
  // Each recorded deadline must be the one its commitment — and so the gate — enforces.
  for (const a of value.attempts) {
    if (commitmentOf(mandateDigest, a) !== a.executionCommitment) return refuse('EVIDENCE_INCONSISTENT');
  }

  let outcome: ReconciledOutcome;
  let reference: Bytes32;
  let settledCommitment: Bytes32 | null = null;
  let settledByRecordedAttempt: boolean | null = null;
  let failureBasis: FailureBasis | null = null;
  if (evidence.consumedCommitment !== ZERO_BYTES32) {
    if (evidence.settlement === null || evidence.settlement.executionCommitment !== evidence.consumedCommitment) {
      return refuse('EVIDENCE_INCONSISTENT');
    }
    outcome = ReconciledOutcome.SETTLED;
    reference = evidence.settlement.transactionHash;
    settledCommitment = evidence.consumedCommitment;
    settledByRecordedAttempt = value.attempts.some((a) => a.executionCommitment === settledCommitment);
  } else {
    if (evidence.settlement !== null) return refuse('EVIDENCE_INCONSISTENT');
    // Exclusive, like the gate's `MandateExpired`: from this block on nothing settles.
    if (evidence.blockTimestamp >= mandateExpiresAt) {
      failureBasis = FailureBasis.MANDATE_EXPIRED;
    } else {
      // An attempt past its reservation shows attempts were signed outside the
      // rule that bounds them, so the reservation's expiry proves nothing.
      if (value.attempts.some((a) => a.terms.deadline > ceiling)) return refuse('ATTEMPT_OUTSIDE_RESERVATION');
      // The gate refuses when `block.timestamp > deadline`, and every deadline is at most the ceiling.
      if (evidence.blockTimestamp <= ceiling) return refuse('OUTCOME_UNESTABLISHED');
      failureBasis = FailureBasis.ATTEMPTS_EXPIRED;
    }
    outcome = ReconciledOutcome.FAILED;
    // The last attempt signed, or the mandate digest when none was: nothing to name but the authorization.
    reference = value.attempts.at(-1)?.executionCommitment ?? mandateDigest;
  }

  const observation = parseExecutionObservation({
    outcome,
    observedAtUnixSeconds: evidence.observedAtUnixSeconds,
    sourceId: policy.sourceId,
    reference,
    // The reservation this reading was judged against, and so the only one it can resolve.
    reservationGeneration: value.reservation.reservationGeneration,
  });
  if (!observation.ok) return refuse('OBSERVATION_INVALID');
  return { ok: true, observation: observation.value, settledCommitment, settledByRecordedAttempt, failureBasis };
}
