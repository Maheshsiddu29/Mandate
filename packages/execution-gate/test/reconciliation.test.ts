import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyTransition, bytesToHex, ReplayTransition, unusedRecord, type Bytes32, type ExecutionObservation, type ReplayRecord } from '@mandate/kernel';
import {
  ConfirmationLevel,
  MAX_ATTEMPTS_PER_RESERVATION,
  ZERO_BYTES32,
  admitAttemptUnderReservation,
  authorizeExecution,
  decodeGateCandidate,
  encodeGateMandate,
  executionCommitment,
  observationFromGateEvidence,
  type GateChainEvidence,
  type GateMandate,
  type GateReservationRecord,
  type ReconciliationPolicy,
} from '../src/index.ts';
import { CHAIN_ID, DEPLOYMENT, T0, baseBuy, baseMandate, mandateDigestOf, sign, type Unsigned } from './support/world.ts';

const D = (b: string) => `0x${b.repeat(32)}` as Bytes32;
const DAY = 86_400n;
const policy: ReconciliationPolicy = { requiredLevel: ConfirmationLevel.FINALIZED, sourceId: 'gate-reader.test' };
const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

/** A BUY whose mandate is valid for 30 days, so attempt failure and mandate expiry are far apart. */
function longBuy(): Unsigned {
  const u = baseBuy();
  return { ...u, mandate: { ...u.mandate, expiresAtUnixSeconds: T0 + 30n * DAY } };
}

function digestOf(m: GateMandate): Bytes32 {
  return mandateDigestOf(m) as Bytes32;
}

/** The kernel's RESERVE, clamped to the mandate expiry, wrapped in a reservation record with no attempts yet. */
function reserve(m: GateMandate, now: bigint, seconds: bigint, current: ReplayRecord = unusedRecord(digestOf(m), now)): GateReservationRecord {
  const reserved = applyTransition({
    current,
    transition: ReplayTransition.RESERVE,
    nowUnixSeconds: now,
    reservationSeconds: seconds,
    mandateExpiresAtUnixSeconds: m.expiresAtUnixSeconds,
  });
  assert.ok(reserved.ok, json(reserved));
  return { chainId: CHAIN_ID, gate: DEPLOYMENT.gate, mandateEncoding: bytesToHex(encodeGateMandate(m)), reservation: reserved.value, attempts: [] };
}

function candidateDigestOf(u: Unsigned): Bytes32 {
  const decoded = decodeGateCandidate(u.candidate);
  assert.ok(decoded.ok);
  return decoded.value.digest;
}

/** Admit `u` under the record, as the pipeline would before signing. */
function admit(rec: GateReservationRecord, u: Unsigned, now: bigint): GateReservationRecord {
  const r = admitAttemptUnderReservation(rec, { candidateDigest: candidateDigestOf(u), terms: u.terms }, now);
  assert.ok(r.ok, json(r));
  return r.record;
}

function commitmentOf(u: Unsigned): Bytes32 {
  return executionCommitment({ mandateDigest: digestOf(u.mandate), candidateDigest: candidateDigestOf(u), terms: u.terms });
}

function quiet(m: GateMandate, blockTimestamp: bigint): GateChainEvidence {
  return {
    level: ConfirmationLevel.FINALIZED,
    chainId: CHAIN_ID,
    gate: DEPLOYMENT.gate,
    mandateDigest: digestOf(m),
    consumedCommitment: ZERO_BYTES32,
    blockTimestamp,
    settlement: null,
    observedAtUnixSeconds: blockTimestamp + 5n,
  };
}

function settledBy(m: GateMandate, commitment: Bytes32, blockTimestamp: bigint, tx: Bytes32 = D('bb')): GateChainEvidence {
  return { ...quiet(m, blockTimestamp), consumedCommitment: commitment, settlement: { transactionHash: tx, executionCommitment: commitment } };
}

/** What the reference model says the gate does with `u` at chain time `timestamp`. */
function gateSays(u: Unsigned, timestamp: bigint, consumed: ReadonlySet<string> = new Set()): string {
  const r = authorizeExecution(DEPLOYMENT, sign(u), { chainId: CHAIN_ID, timestamp, consumed });
  return r.ok ? 'authorizes' : r.rejection.error;
}

function withDeadline(u: Unsigned, deadline: bigint, fundingLimit = u.terms.fundingLimit): Unsigned {
  return { ...u, terms: { ...u.terms, deadline, fundingLimit } };
}

describe('reconciliation from gate evidence (Phase 6R.1a)', () => {
  it('retries after a failed attempt while the mandate is valid, and still settles at most once', () => {
    const m = longBuy().mandate;
    const digest = digestOf(m);

    // Reservation 1 runs T0 .. T0+600. Attempt A is signed under it with deadline T0+300.
    const a = withDeadline(longBuy(), T0 + 300n);
    let rec = admit(reserve(m, T0, 600n), a, T0);
    assert.equal(rec.attempts.length, 1);

    // A never lands. Past A's deadline, but not past the reservation: another
    // attempt could still be admitted with a deadline up to T0+600.
    assert.equal(gateSays(a, T0 + 301n), 'ExecutionDeadlinePassed');
    assert.equal(gateSays(withDeadline(longBuy(), T0 + 600n), T0 + 600n), 'authorizes');
    for (const ts of [T0 + 301n, T0 + 600n]) {
      assert.deepEqual(observationFromGateEvidence(rec, quiet(m, ts), policy), { ok: false, refusal: 'OUTCOME_UNESTABLISHED' }, String(ts - T0));
    }

    // Past the reservation: every attempt under it is dead, though the mandate has 30 days left.
    const failed = observationFromGateEvidence(rec, quiet(m, T0 + 601n), policy);
    assert.ok(failed.ok, json(failed));
    assert.equal(failed.observation.outcome, 'FAILED');
    assert.equal(failed.failureBasis, 'ATTEMPTS_EXPIRED');
    assert.equal(failed.observation.reference, commitmentOf(a));
    const unused = applyTransition({ current: rec.reservation, transition: ReplayTransition.RECONCILE, nowUnixSeconds: T0 + 700n, observation: failed.observation });
    assert.ok(unused.ok, json(unused));
    assert.equal(unused.value.status, 'UNUSED');

    // Reservation 2 and attempt B, with a later deadline. A stays dead; B settles.
    const b = withDeadline(longBuy(), T0 + 1_000n);
    rec = admit(reserve(m, T0 + 700n, 600n, unused.value), b, T0 + 700n);
    assert.equal(gateSays(a, T0 + 800n), 'ExecutionDeadlinePassed');
    assert.equal(gateSays(b, T0 + 800n), 'authorizes');
    const settled = observationFromGateEvidence(rec, settledBy(m, commitmentOf(b), T0 + 800n), policy);
    assert.ok(settled.ok, json(settled));
    assert.equal(settled.observation.outcome, 'SETTLED');
    assert.equal(settled.settledCommitment, commitmentOf(b));
    assert.equal(settled.settledByRecordedAttempt, true);
    const consumed = applyTransition({ current: rec.reservation, transition: ReplayTransition.RECONCILE, nowUnixSeconds: T0 + 900n, observation: settled.observation });
    assert.ok(consumed.ok, json(consumed));
    assert.equal(consumed.value.status, 'CONSUMED');

    // One canonical settlement: B again, or any fresh attempt, is refused by the gate; the record is terminal.
    const spent = new Set([digest]);
    assert.equal(gateSays(b, T0 + 850n, spent), 'MandateAlreadyConsumed');
    assert.equal(gateSays(withDeadline(longBuy(), T0 + 2_000n), T0 + 850n, spent), 'MandateAlreadyConsumed');
    const again = applyTransition({ current: consumed.value, transition: ReplayTransition.RESERVE, nowUnixSeconds: T0 + 1_000n, reservationSeconds: 60n });
    assert.equal(again.ok, false);
  });

  it('never reports FAILED while any attempt under the reservation can still land', () => {
    const m = longBuy().mandate;
    // Two attempts live at once under one reservation (T0 .. T0+600): A to T0+300, A2 to T0+550.
    const a = withDeadline(longBuy(), T0 + 300n);
    const a2 = withDeadline(longBuy(), T0 + 550n, 2_000n * 10n ** 6n);
    const rec = admit(admit(reserve(m, T0, 600n), a, T0), a2, T0 + 10n);
    assert.equal(rec.attempts.length, 2);

    assert.equal(gateSays(a, T0 + 400n), 'ExecutionDeadlinePassed');
    assert.equal(gateSays(a2, T0 + 400n), 'authorizes');
    assert.equal(gateSays(a2, T0 + 550n), 'authorizes', 'the deadline is inclusive');
    assert.equal(gateSays(a2, T0 + 551n), 'ExecutionDeadlinePassed');
    for (const ts of [T0 + 301n, T0 + 400n, T0 + 550n, T0 + 551n, T0 + 600n]) {
      assert.deepEqual(observationFromGateEvidence(rec, quiet(m, ts), policy), { ok: false, refusal: 'OUTCOME_UNESTABLISHED' }, String(ts - T0));
    }
    const failed = observationFromGateEvidence(rec, quiet(m, T0 + 601n), policy);
    assert.ok(failed.ok);
    assert.equal(failed.failureBasis, 'ATTEMPTS_EXPIRED');
    // It names the last attempt signed.
    assert.equal(failed.observation.reference, commitmentOf(a2));

    // A2 landing before that is SETTLED, not FAILED, however late the reading.
    const late = observationFromGateEvidence(rec, settledBy(m, commitmentOf(a2), T0 + 5_000n), policy);
    assert.ok(late.ok);
    assert.equal(late.observation.outcome, 'SETTLED');
  });

  it('keeps mandate expiry a separate basis from attempt failure', () => {
    // The base mandate expires at T0+3600; a two-hour reservation is clamped to it.
    const u = baseBuy();
    const m = u.mandate;
    const rec = admit(reserve(m, T0, 7_200n), withDeadline(u, T0 + 3_600n), T0);
    assert.equal(rec.reservation.reservationExpiresAtUnixSeconds, m.expiresAtUnixSeconds);

    assert.deepEqual(observationFromGateEvidence(rec, quiet(m, T0 + 3_599n), policy), { ok: false, refusal: 'OUTCOME_UNESTABLISHED' });
    // At expiry the gate refuses every attempt (exclusive), whatever its deadline.
    assert.equal(gateSays(withDeadline(u, T0 + 3_600n), T0 + 3_600n), 'MandateExpired');
    const expired = observationFromGateEvidence(rec, quiet(m, T0 + 3_600n), policy);
    assert.ok(expired.ok);
    assert.equal(expired.observation.outcome, 'FAILED');
    assert.equal(expired.failureBasis, 'MANDATE_EXPIRED');
  });

  it('admits an attempt only under a live reservation for this mandate, with a deadline inside it', () => {
    const u = longBuy();
    const m = u.mandate;
    const open = reserve(m, T0, 600n);
    const attempt = (x: Unsigned) => ({ candidateDigest: candidateDigestOf(x), terms: x.terms });

    const atCeiling = admitAttemptUnderReservation(open, attempt(withDeadline(u, T0 + 600n)), T0 + 599n);
    assert.ok(atCeiling.ok);
    assert.equal(atCeiling.executionCommitment, commitmentOf(withDeadline(u, T0 + 600n)));
    assert.deepEqual(admitAttemptUnderReservation(open, attempt(withDeadline(u, T0 + 601n)), T0), { ok: false, refusal: 'DEADLINE_BEYOND_RESERVATION' });
    assert.deepEqual(admitAttemptUnderReservation(open, attempt(withDeadline(u, T0 + 300n)), T0 + 600n), { ok: false, refusal: 'RESERVATION_LAPSED' });

    // Only RESERVED admits. QUARANTINED, UNUSED and another mandate's record do not.
    const quarantined = applyTransition({ current: open.reservation, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: T0 + 600n });
    assert.ok(quarantined.ok);
    assert.deepEqual(admitAttemptUnderReservation({ ...open, reservation: quarantined.value }, attempt(u), T0 + 10n), { ok: false, refusal: 'NOT_RESERVED' });
    assert.deepEqual(admitAttemptUnderReservation({ ...open, reservation: unusedRecord(digestOf(m), T0) }, attempt(u), T0 + 10n), { ok: false, refusal: 'NOT_RESERVED' });
    const otherMandate = { ...m, nonce: 99n };
    assert.deepEqual(admitAttemptUnderReservation({ ...open, reservation: reserve(otherMandate, T0, 600n).reservation }, attempt(u), T0 + 10n), { ok: false, refusal: 'RESERVATION_MISMATCH' });
  });

  it('bounds the attempts a reservation carries, and treats a rebroadcast as the same attempt', () => {
    const u = longBuy();
    let rec = reserve(u.mandate, T0, 600n);
    for (let i = 0; i < MAX_ATTEMPTS_PER_RESERVATION; i += 1) rec = admit(rec, withDeadline(u, T0 + 100n + BigInt(i)), T0);
    assert.equal(rec.attempts.length, MAX_ATTEMPTS_PER_RESERVATION);
    const again = admitAttemptUnderReservation(rec, { candidateDigest: candidateDigestOf(u), terms: withDeadline(u, T0 + 100n).terms }, T0);
    assert.ok(again.ok);
    assert.deepEqual(again.record, rec, 'a rebroadcast leaves the record unchanged');
    const ninth = admitAttemptUnderReservation(rec, { candidateDigest: candidateDigestOf(u), terms: withDeadline(u, T0 + 200n).terms }, T0);
    assert.deepEqual(ninth, { ok: false, refusal: 'ATTEMPT_LIMIT_REACHED' });
    assert.deepEqual(observationFromGateEvidence({ ...rec, attempts: [...rec.attempts, rec.attempts[0]] }, quiet(u.mandate, T0 + 601n), policy), { ok: false, refusal: 'EVIDENCE_MALFORMED' });
  });

  it('takes no deadline or expiry on trust: each is derived from what was signed', () => {
    const u = longBuy();
    const m = u.mandate;
    const rec = admit(reserve(m, T0, 600n), withDeadline(u, T0 + 300n), T0);
    const signed = rec.attempts[0];
    assert.ok(signed !== undefined);

    // A stored deadline that is not the one the commitment carries is refused, in both directions.
    const tampered = { ...rec, attempts: [{ ...signed, terms: { ...signed.terms, deadline: T0 + 100n } }] };
    assert.deepEqual(observationFromGateEvidence(tampered, quiet(m, T0 + 601n), policy), { ok: false, refusal: 'EVIDENCE_INCONSISTENT' });
    assert.deepEqual(admitAttemptUnderReservation(tampered, { candidateDigest: signed.candidateDigest, terms: withDeadline(u, T0 + 400n).terms }, T0), { ok: false, refusal: 'ATTEMPT_INCONSISTENT' });

    // The expiry comes from the signed mandate bytes: a different mandate is a different digest.
    const shorter = { ...m, expiresAtUnixSeconds: T0 + 700n };
    assert.deepEqual(
      observationFromGateEvidence({ ...rec, mandateEncoding: bytesToHex(encodeGateMandate(shorter)) }, quiet(m, T0 + 601n), policy),
      { ok: false, refusal: 'EVIDENCE_MISMATCH' },
    );
    // Bytes that are not a canonical mandate are malformed, not trusted.
    assert.deepEqual(observationFromGateEvidence({ ...rec, mandateEncoding: '0x00' }, quiet(m, T0 + 601n), policy), { ok: false, refusal: 'EVIDENCE_MALFORMED' });

    // A reservation record for another mandate resolves nothing about this one.
    const foreign = reserve({ ...m, nonce: 7n }, T0, 600n).reservation;
    assert.deepEqual(observationFromGateEvidence({ ...rec, reservation: foreign }, quiet(m, T0 + 601n), policy), { ok: false, refusal: 'RESERVATION_MISMATCH' });
  });

  it('refuses to fail a record that proves attempts were signed outside its reservation, until the mandate expires', () => {
    const u = longBuy();
    const m = u.mandate;
    const open = reserve(m, T0, 600n);
    const outside = withDeadline(u, T0 + 900n);
    const rec: GateReservationRecord = {
      ...open,
      attempts: [{ candidateDigest: candidateDigestOf(outside), terms: outside.terms, executionCommitment: commitmentOf(outside) }],
    };
    assert.equal(gateSays(outside, T0 + 800n), 'authorizes', 'the out-of-reservation attempt is still live after the ceiling');
    assert.deepEqual(observationFromGateEvidence(rec, quiet(m, T0 + 601n), policy), { ok: false, refusal: 'ATTEMPT_OUTSIDE_RESERVATION' });
    assert.deepEqual(observationFromGateEvidence(rec, quiet(m, T0 + 901n), policy), { ok: false, refusal: 'ATTEMPT_OUTSIDE_RESERVATION' });
    const expired = observationFromGateEvidence(rec, quiet(m, m.expiresAtUnixSeconds), policy);
    assert.ok(expired.ok);
    assert.equal(expired.failureBasis, 'MANDATE_EXPIRED');
  });

  it('reports SETTLED by an attempt this reservation never recorded, and says so', () => {
    const u = longBuy();
    const rec = admit(reserve(u.mandate, T0, 600n), u, T0);
    const r = observationFromGateEvidence(rec, settledBy(u.mandate, D('33'), T0 + 100n), policy);
    assert.ok(r.ok);
    assert.equal(r.observation.outcome, 'SETTLED');
    assert.equal(r.settledCommitment, D('33'));
    assert.equal(r.settledByRecordedAttempt, false);
    assert.equal(r.failureBasis, null);
  });

  it('fails a reservation under which nothing was signed, naming the mandate digest', () => {
    const m = longBuy().mandate;
    const r = observationFromGateEvidence(reserve(m, T0, 600n), quiet(m, T0 + 601n), policy);
    assert.ok(r.ok);
    assert.equal(r.observation.reference, digestOf(m));
  });

  it('resolves QUARANTINED as well as RESERVED, and nothing else', () => {
    const u = longBuy();
    const rec = admit(reserve(u.mandate, T0, 600n), u, T0);
    const quarantined = applyTransition({ current: rec.reservation, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: T0 + 600n });
    assert.ok(quarantined.ok);
    const q = observationFromGateEvidence({ ...rec, reservation: quarantined.value }, quiet(u.mandate, T0 + 601n), policy);
    assert.ok(q.ok);
    const resolved = applyTransition({ current: quarantined.value, transition: ReplayTransition.RECONCILE, nowUnixSeconds: T0 + 700n, observation: q.observation });
    assert.ok(resolved.ok);
    assert.equal(resolved.value.status, 'UNUSED');
    assert.deepEqual(
      observationFromGateEvidence({ ...rec, reservation: unusedRecord(digestOf(u.mandate), T0) }, quiet(u.mandate, T0 + 601n), policy),
      { ok: false, refusal: 'NOT_RESOLVABLE' },
    );
  });

  it('establishes nothing below the required confirmation level', () => {
    const u = longBuy();
    const rec = admit(reserve(u.mandate, T0, 600n), u, T0);
    const evidence = settledBy(u.mandate, commitmentOf(u), T0 + 100n);
    for (const level of [ConfirmationLevel.SUBMITTED, ConfirmationLevel.MINED, ConfirmationLevel.CONFIRMED]) {
      assert.deepEqual(observationFromGateEvidence(rec, { ...evidence, level }, policy), { ok: false, refusal: 'NOT_FINAL' }, level);
    }
    const lenient = observationFromGateEvidence(rec, { ...evidence, level: ConfirmationLevel.CONFIRMED }, { ...policy, requiredLevel: ConfirmationLevel.CONFIRMED });
    assert.ok(lenient.ok);
  });

  it('refuses evidence about another chain, gate or mandate, and contradictory evidence', () => {
    const u = longBuy();
    const rec = admit(reserve(u.mandate, T0, 600n), u, T0);
    const evidence = settledBy(u.mandate, commitmentOf(u), T0 + 100n);
    for (const patch of [{ chainId: 4663n }, { gate: '0x000000000000000000000000000000000000beef' }, { mandateDigest: D('44') }]) {
      assert.deepEqual(observationFromGateEvidence(rec, { ...evidence, ...patch }, policy), { ok: false, refusal: 'EVIDENCE_MISMATCH' });
    }
    const noLog = { ...evidence, settlement: null };
    const wrongLog = { ...evidence, settlement: { transactionHash: D('aa'), executionCommitment: D('99') } };
    const logWithoutState = { ...quiet(u.mandate, T0 + 601n), settlement: { transactionHash: D('aa'), executionCommitment: commitmentOf(u) } };
    for (const e of [noLog, wrongLog, logWithoutState]) {
      assert.deepEqual(observationFromGateEvidence(rec, e, policy), { ok: false, refusal: 'EVIDENCE_INCONSISTENT' });
    }
  });

  it('refuses a record whose mandate is not the base BUY but claims its digest', () => {
    // The digest the evidence names must be the digest of the bytes the record carries.
    const u = baseBuy();
    const rec = admit(reserve(u.mandate, T0, 600n), u, T0);
    const other = { ...baseMandate(), nonce: 2n };
    assert.deepEqual(observationFromGateEvidence(rec, quiet(other, T0 + 601n), policy), { ok: false, refusal: 'EVIDENCE_MISMATCH' });
  });
});

describe('reservation generations (Phase 6R.1b)', () => {
  it('STALE REGRESSION: an observation derived from reservation 1 cannot fail reservation 2 while its attempt is live', () => {
    const m = longBuy().mandate;

    // Reservation 1 (T0 .. T0+600) admits A; A never lands; O1 is derived at T0+601.
    const a = withDeadline(longBuy(), T0 + 300n);
    const r1 = admit(reserve(m, T0, 600n), a, T0);
    assert.equal(r1.reservation.reservationGeneration, 1n);
    const o1 = observationFromGateEvidence(r1, quiet(m, T0 + 601n), policy);
    assert.ok(o1.ok);
    assert.equal(o1.observation.outcome, 'FAILED');
    assert.equal(o1.observation.reservationGeneration, 1n, 'the generation comes from the record, not the caller');

    // Reconciled correctly, and reservation 2 opens in the very second O1 was observed.
    const at = o1.observation.observedAtUnixSeconds;
    const unused = applyTransition({ current: r1.reservation, transition: ReplayTransition.RECONCILE, nowUnixSeconds: at, observation: o1.observation });
    assert.ok(unused.ok);
    const b = withDeadline(longBuy(), T0 + 1_000n);
    const r2 = admit(reserve(m, at, 600n, unused.value), b, at);
    assert.equal(r2.reservation.reservationGeneration, 2n);
    assert.equal(r2.reservation.updatedAtUnixSeconds, o1.observation.observedAtUnixSeconds, 'O1 fits reservation 2\'s timeline exactly');
    assert.equal(gateSays(b, T0 + 700n), 'authorizes', 'B is live');

    // O1 delivered again, and O1' derived afresh from the out-of-date reservation-1 record: neither applies.
    const o1Again = observationFromGateEvidence(r1, quiet(m, T0 + 700n), policy);
    assert.ok(o1Again.ok);
    assert.equal(o1Again.failureBasis, 'ATTEMPTS_EXPIRED', 'judged against reservation 1, the reading is a genuine failure');
    for (const stale of [o1.observation, o1Again.observation]) {
      const before = structuredClone(r2.reservation);
      const result = applyTransition({ current: r2.reservation, transition: ReplayTransition.RECONCILE, nowUnixSeconds: T0 + 710n, observation: stale });
      assert.deepEqual(result, { ok: false, error: 'STALE_RESERVATION_OBSERVATION' });
      assert.deepEqual(r2.reservation, before, 'the newer reservation is untouched');
    }

    // B is still live, may still settle, and reservation 2's own observation resolves it.
    assert.equal(gateSays(b, T0 + 900n), 'authorizes');
    const o2 = observationFromGateEvidence(r2, settledBy(m, commitmentOf(b), T0 + 900n), policy);
    assert.ok(o2.ok);
    assert.equal(o2.observation.reservationGeneration, 2n);
    const consumed = applyTransition({ current: r2.reservation, transition: ReplayTransition.RECONCILE, nowUnixSeconds: T0 + 910n, observation: o2.observation });
    assert.ok(consumed.ok);
    assert.equal(consumed.value.status, 'CONSUMED');
    assert.equal(gateSays(b, T0 + 950n, new Set([digestOf(m)])), 'MandateAlreadyConsumed');

    // Had B not landed, reservation 2's own FAILED would apply, once B is dead.
    assert.deepEqual(observationFromGateEvidence(r2, quiet(m, T0 + 1_206n), policy), { ok: false, refusal: 'OUTCOME_UNESTABLISHED' });
    const o2Failed = observationFromGateEvidence(r2, quiet(m, T0 + 1_207n), policy);
    assert.ok(o2Failed.ok);
    const retried = applyTransition({ current: r2.reservation, transition: ReplayTransition.RECONCILE, nowUnixSeconds: T0 + 1_212n, observation: o2Failed.observation });
    assert.ok(retried.ok);
    assert.equal(retried.value.status, 'UNUSED');
  });

  it('randomized: stale observations never move the current reservation, and FAILED never precedes a live attempt', () => {
    const counts = run(RUNS, STEPS);
    // Non-vacuity: every interleaving the property is about actually happened.
    assert.ok(counts.staleDelivered > 0 && counts.staleFailedWhileLive > 0, json(counts));
    assert.ok(counts.retries > 0 && counts.settlements > 0 && counts.quarantines > 0, json(counts));
    assert.ok(counts.attemptsExpired > 0 && counts.mandateExpired > 0 && counts.overlapping > 0, json(counts));
    assert.ok(counts.deadAttemptsRefused > 0 && counts.admissionsRefused > 0, json(counts));
  });
});

// --- Randomized reconciliation state machine ------------------------------------

const RUNS = 200;
const STEPS = 48;

/** Deterministic PRNG, so a failure is reproducible from its run number. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Counts {
  retries: number;
  settlements: number;
  quarantines: number;
  attemptsExpired: number;
  mandateExpired: number;
  overlapping: number;
  staleDelivered: number;
  staleFailedWhileLive: number;
  deadAttemptsRefused: number;
  admissionsRefused: number;
}

/**
 * A pipeline, the kernel's replay store and the reference gate, driven in random
 * order: reserve, admit (some deadlines past the ceiling), advance chain time,
 * land any admitted attempt (including ones from earlier reservations), quarantine,
 * reconcile from the current record, and deliver stale observations — both ones
 * derived earlier and ones derived afresh from out-of-date records.
 */
function run(runs: number, steps: number): Counts {
  const counts: Counts = {
    retries: 0, settlements: 0, quarantines: 0, attemptsExpired: 0, mandateExpired: 0,
    overlapping: 0, staleDelivered: 0, staleFailedWhileLive: 0, deadAttemptsRefused: 0, admissionsRefused: 0,
  };
  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    const next = rng(0x6d616e64 + runIndex);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const between = (lo: number, hi: number): bigint => BigInt(lo + Math.floor(next() * (hi - lo + 1)));
    const where = (step: number) => `run ${runIndex} step ${step}`;

    const base = longBuy();
    const mandate = { ...base.mandate, expiresAtUnixSeconds: T0 + between(700, 4_000) };
    const digest = digestOf(mandate);
    const signed = new Map<Bytes32, ReturnType<typeof sign>>();
    const says = (u: Unsigned, at: bigint, consumed: ReadonlySet<string>): string => {
      const c = commitmentOf(u);
      let s = signed.get(c);
      if (s === undefined) signed.set(c, (s = sign(u)));
      const r = authorizeExecution(DEPLOYMENT, s, { chainId: CHAIN_ID, timestamp: at, consumed });
      return r.ok ? 'authorizes' : r.rejection.error;
    };

    let now = T0;
    let kernel: ReplayRecord = unusedRecord(digest, now);
    let current: GateReservationRecord | null = null;
    const outdated: GateReservationRecord[] = []; // every record the pipeline ever held, as it was then
    const derived: ExecutionObservation[] = [];
    const admitted = new Map<bigint, Unsigned[]>(); // by reservation generation
    const failedGenerations = new Set<bigint>();
    const consumed = new Set<string>();
    let settledGeneration: bigint | null = null;
    let settlementTx: Bytes32 | null = null;
    let settledCommitment: Bytes32 | null = null;
    let lastFailedLegitimately = false;
    let settlementsThisRun = 0;

    const evidenceNow = (): GateChainEvidence => ({
      ...quiet(mandate, now),
      observedAtUnixSeconds: now,
      ...(settledCommitment === null
        ? {}
        : { consumedCommitment: settledCommitment, settlement: { transactionHash: settlementTx as Bytes32, executionCommitment: settledCommitment } }),
    });
    const liveAttemptOfCurrent = (): boolean =>
      (admitted.get(kernel.reservationGeneration) ?? []).some((u) => says(u, now, consumed) === 'authorizes');

    for (let step = 0; step < steps; step += 1) {
      const action = next();
      const wasConsumed = kernel.status === 'CONSUMED';
      const before = structuredClone(kernel);

      if (action < 0.18) {
        now += between(1, 400);
      } else if (action < 0.3) {
        // RESERVE: always possible after a legitimate failure while the mandate has time left.
        const r = applyTransition({
          current: kernel, transition: ReplayTransition.RESERVE, nowUnixSeconds: now,
          reservationSeconds: between(60, 900), mandateExpiresAtUnixSeconds: mandate.expiresAtUnixSeconds,
        });
        if (kernel.status === 'UNUSED' && now < mandate.expiresAtUnixSeconds) {
          assert.ok(r.ok, `${where(step)}: retry refused ${json(r)}`);
          if (lastFailedLegitimately) counts.retries += 1;
        }
        if (r.ok) {
          assert.equal(r.value.reservationGeneration, kernel.reservationGeneration + 1n, where(step));
          kernel = r.value;
          current = { chainId: CHAIN_ID, gate: DEPLOYMENT.gate, mandateEncoding: bytesToHex(encodeGateMandate(mandate)), reservation: kernel, attempts: [] };
          outdated.push(current);
          lastFailedLegitimately = false;
        }
      } else if (action < 0.45) {
        // Admit, sometimes with a deadline past the ceiling.
        if (current === null) continue;
        const ceiling = current.reservation.reservationExpiresAtUnixSeconds ?? now;
        const u: Unsigned = { ...base, mandate, terms: { ...base.terms, deadline: now + between(0, Number(ceiling - now) + 60), fundingLimit: between(2_006, 2_010) * 10n ** 6n } };
        const r = admitAttemptUnderReservation({ ...current, reservation: kernel }, { candidateDigest: candidateDigestOf(u), terms: u.terms }, now);
        if (!r.ok) {
          counts.admissionsRefused += 1;
          continue;
        }
        current = r.record;
        outdated.push(current);
        const list = admitted.get(kernel.reservationGeneration) ?? [];
        if (!list.some((x) => commitmentOf(x) === r.executionCommitment)) list.push(u);
        admitted.set(kernel.reservationGeneration, list);
        if (list.length > 1) counts.overlapping += 1;
      } else if (action < 0.55) {
        // Land any attempt ever admitted, from any reservation.
        const generations = [...admitted.keys()];
        if (generations.length === 0) continue;
        const g = pick(generations);
        const u = pick(admitted.get(g) ?? []);
        const verdict = says(u, now, consumed);
        if (failedGenerations.has(g)) {
          // FAILED was reported for this reservation: none of its attempts may ever land.
          assert.notEqual(verdict, 'authorizes', `${where(step)}: an attempt of a FAILED reservation settled`);
          counts.deadAttemptsRefused += 1;
        }
        if (verdict === 'authorizes') {
          consumed.add(digest);
          settledGeneration = g;
          settledCommitment = commitmentOf(u);
          settlementTx = D((10 + runIndex % 80).toString(16).padStart(2, '0'));
          counts.settlements += 1;
          settlementsThisRun += 1;
        }
      } else if (action < 0.62) {
        const r = applyTransition({ current: kernel, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: now });
        if (r.ok) {
          assert.equal(r.value.reservationGeneration, kernel.reservationGeneration, where(step));
          kernel = r.value;
          counts.quarantines += 1;
        }
      } else if (action < 0.8) {
        // Reconcile from the pipeline's current record.
        if (current === null) continue;
        const o = observationFromGateEvidence({ ...current, reservation: kernel }, evidenceNow(), policy);
        if (!o.ok) continue;
        derived.push(o.observation);
        const r = applyTransition({ current: kernel, transition: ReplayTransition.RECONCILE, nowUnixSeconds: now, observation: o.observation });
        assert.ok(r.ok, `${where(step)}: a current observation was refused ${json(r)}`);
        if (o.observation.outcome === 'FAILED') {
          assert.equal(liveAttemptOfCurrent(), false, `${where(step)}: FAILED while an admitted attempt can still land`);
          failedGenerations.add(kernel.reservationGeneration);
          if (o.failureBasis === 'ATTEMPTS_EXPIRED') counts.attemptsExpired += 1;
          else counts.mandateExpired += 1;
          lastFailedLegitimately = true;
        }
        kernel = r.value;
      } else {
        // Stale delivery: an earlier observation, or one derived now from an out-of-date record.
        const older = outdated.filter((x) => x.reservation.reservationGeneration !== kernel.reservationGeneration);
        const candidates: ExecutionObservation[] = derived.filter((o) => o.reservationGeneration !== kernel.reservationGeneration);
        if (older.length > 0) {
          const o = observationFromGateEvidence(pick(older), evidenceNow(), policy);
          if (o.ok) candidates.push(o.observation);
        }
        if (candidates.length === 0) continue;
        const stale = pick(candidates);
        const live = liveAttemptOfCurrent();
        const r = applyTransition({ current: kernel, transition: ReplayTransition.RECONCILE, nowUnixSeconds: now, observation: stale });
        assert.equal(r.ok, false, `${where(step)}: a stale observation moved the record`);
        if (kernel.status === 'RESERVED' || kernel.status === 'QUARANTINED') {
          assert.deepEqual(r, { ok: false, error: 'STALE_RESERVATION_OBSERVATION' }, where(step));
          if (stale.outcome === 'FAILED' && live) counts.staleFailedWhileLive += 1;
        }
        assert.deepEqual(kernel, before, where(step));
        counts.staleDelivered += 1;
      }

      // Invariants after every step.
      assert.ok(consumed.size <= 1, where(step));
      assert.ok(settlementsThisRun <= 1, `${where(step)}: more than one settlement`);
      if (wasConsumed) assert.deepEqual(kernel, before, `${where(step)}: CONSUMED changed`);
      if (kernel.status === 'CONSUMED') assert.ok(consumed.has(digest), `${where(step)}: CONSUMED without a settlement`);
      if (settledGeneration !== null && kernel.status !== 'CONSUMED') {
        // The chain settled an admitted attempt: the store must still hold that reservation, unresolved.
        assert.ok(kernel.status === 'RESERVED' || kernel.status === 'QUARANTINED', `${where(step)}: settled but ${kernel.status}`);
        assert.equal(kernel.reservationGeneration, settledGeneration, `${where(step)}: settled under an earlier reservation`);
      }
    }
  }
  return counts;
}
