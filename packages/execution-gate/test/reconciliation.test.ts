import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyTransition, ReplayTransition, unusedRecord, type Bytes32 } from '@mandate/kernel';
import {
  ConfirmationLevel,
  ZERO_BYTES32,
  authorizeExecution,
  executionCommitment,
  decodeGateCandidate,
  observationFromGateEvidence,
  type GateAttemptRecord,
  type GateChainEvidence,
  type ReconciliationPolicy,
} from '../src/index.ts';
import { CHAIN_ID, DEPLOYMENT, T0, baseBuy, mandateDigestOf, sign } from './support/world.ts';

const D = (b: string) => `0x${b.repeat(32)}` as Bytes32;

const attempt: GateAttemptRecord = {
  chainId: 46630n,
  gate: '0x000000000000000000000000000000000000a7e0',
  mandateDigest: D('11'),
  executionCommitment: D('22'),
  mandateExpiresAtUnixSeconds: 1_800_003_600n,
};

const policy: ReconciliationPolicy = { requiredLevel: ConfirmationLevel.FINALIZED, sourceId: 'gate-reader.test' };

const settledEvidence: GateChainEvidence = {
  level: ConfirmationLevel.FINALIZED,
  chainId: 46630n,
  gate: attempt.gate,
  mandateDigest: attempt.mandateDigest,
  consumedCommitment: D('22'),
  blockTimestamp: 1_800_000_100n,
  settlement: { transactionHash: D('aa'), executionCommitment: D('22') },
  observedAtUnixSeconds: 1_800_000_200n,
};

const unsettledEvidence: GateChainEvidence = {
  ...settledEvidence,
  consumedCommitment: ZERO_BYTES32,
  settlement: null,
  blockTimestamp: attempt.mandateExpiresAtUnixSeconds,
};

describe('reconciliation from gate evidence', () => {
  it('establishes SETTLED from a finalized consumption with its MandateExecuted log, referenced by transaction', () => {
    const r = observationFromGateEvidence(attempt, settledEvidence, policy);
    assert.ok(r.ok);
    assert.equal(r.observation.outcome, 'SETTLED');
    assert.equal(r.observation.reference, D('aa'));
    assert.equal(r.settledCommitment, D('22'));
  });

  it('establishes nothing below the required confirmation level: an observed transaction is not final settlement', () => {
    for (const level of [ConfirmationLevel.SUBMITTED, ConfirmationLevel.MINED, ConfirmationLevel.CONFIRMED]) {
      const r = observationFromGateEvidence(attempt, { ...settledEvidence, level }, policy);
      assert.deepEqual(r, { ok: false, refusal: 'NOT_FINAL' }, level);
    }
    const lenient = observationFromGateEvidence(attempt, { ...settledEvidence, level: ConfirmationLevel.CONFIRMED }, { ...policy, requiredLevel: ConfirmationLevel.CONFIRMED });
    assert.ok(lenient.ok);
  });

  it('reports SETTLED even when a different signed execution consumed the authorization, and surfaces which', () => {
    const other = { ...settledEvidence, consumedCommitment: D('33'), settlement: { transactionHash: D('bb'), executionCommitment: D('33') } };
    const r = observationFromGateEvidence(attempt, other, policy);
    assert.ok(r.ok);
    assert.equal(r.observation.outcome, 'SETTLED');
    assert.equal(r.settledCommitment, D('33'));
  });

  it('establishes FAILED only once final chain time reaches the mandate expiry', () => {
    const failed = observationFromGateEvidence(attempt, unsettledEvidence, policy);
    assert.ok(failed.ok);
    assert.equal(failed.observation.outcome, 'FAILED');
    assert.equal(failed.observation.reference, attempt.executionCommitment);

    // One second before expiry the gate still accepts some attempt of this mandate.
    const early = observationFromGateEvidence(attempt, { ...unsettledEvidence, blockTimestamp: attempt.mandateExpiresAtUnixSeconds - 1n }, policy);
    assert.deepEqual(early, { ok: false, refusal: 'OUTCOME_UNESTABLISHED' });
  });

  it('does not fail a mandate because one attempt expired while another attempt can still settle', () => {
    // Attempt A: the base BUY, deadline T0 + 300.
    const unsignedA = baseBuy();
    const a = sign(unsignedA);
    // Attempt B: the same mandate, re-signed by its agent with a later deadline.
    const b = sign({ ...unsignedA, terms: { ...unsignedA.terms, deadline: T0 + 3_000n } });
    const mandateDigest = mandateDigestOf(unsignedA.mandate) as Bytes32;
    const commitmentOf = (x: typeof a): Bytes32 => {
      const decoded = decodeGateCandidate(x.candidate);
      assert.ok(decoded.ok);
      return executionCommitment({ mandateDigest, candidateDigest: decoded.value.digest, terms: x.terms });
    };
    const record: GateAttemptRecord = {
      chainId: CHAIN_ID,
      gate: DEPLOYMENT.gate,
      mandateDigest,
      executionCommitment: commitmentOf(a),
      mandateExpiresAtUnixSeconds: unsignedA.mandate.expiresAtUnixSeconds,
    };

    // Chain time is past A's deadline: A can never land, B still can.
    const after = T0 + 301n;
    const chain = { chainId: CHAIN_ID, timestamp: after, consumed: new Set<string>() };
    const lateA = authorizeExecution(DEPLOYMENT, a, chain);
    assert.equal(lateA.ok ? 'settles' : lateA.rejection.error, 'ExecutionDeadlinePassed');
    assert.ok(authorizeExecution(DEPLOYMENT, b, chain).ok, 'B remains a valid execution opportunity');

    // So an unconsumed final reading there establishes nothing — the rule this
    // module had before 6R.1 reported FAILED here.
    const quiet: GateChainEvidence = {
      level: ConfirmationLevel.FINALIZED,
      chainId: CHAIN_ID,
      gate: DEPLOYMENT.gate,
      mandateDigest,
      consumedCommitment: ZERO_BYTES32,
      blockTimestamp: after,
      settlement: null,
      observedAtUnixSeconds: after + 60n,
    };
    assert.deepEqual(observationFromGateEvidence(record, quiet, policy), { ok: false, refusal: 'OUTCOME_UNESTABLISHED' });

    // B then settles, and reconciliation of A's record reports that, naming B.
    const settled = observationFromGateEvidence(record, {
      ...quiet,
      consumedCommitment: commitmentOf(b),
      blockTimestamp: after + 10n,
      settlement: { transactionHash: D('bb'), executionCommitment: commitmentOf(b) },
      observedAtUnixSeconds: after + 70n,
    }, policy);
    assert.ok(settled.ok);
    assert.equal(settled.observation.outcome, 'SETTLED');
    assert.equal(settled.settledCommitment, commitmentOf(b));

    // Only at the mandate's expiry does the gate refuse every attempt, and only
    // then may an unconsumed final reading be FAILED.
    const atExpiry = { ...chain, timestamp: unsignedA.mandate.expiresAtUnixSeconds };
    const lateB = authorizeExecution(DEPLOYMENT, b, atExpiry);
    assert.equal(lateB.ok ? 'settles' : lateB.rejection.error, 'MandateExpired');
    const failed = observationFromGateEvidence(record, { ...quiet, blockTimestamp: atExpiry.timestamp, observedAtUnixSeconds: atExpiry.timestamp + 60n }, policy);
    assert.ok(failed.ok);
    assert.equal(failed.observation.outcome, 'FAILED');
  });

  it('refuses an attempt record without the mandate expiry, or with only a deadline', () => {
    const { mandateExpiresAtUnixSeconds: _omitted, ...withoutExpiry } = attempt;
    for (const bad of [withoutExpiry, { ...withoutExpiry, deadline: 1_800_000_300n }]) {
      assert.deepEqual(observationFromGateEvidence(bad, unsettledEvidence, policy), { ok: false, refusal: 'EVIDENCE_MALFORMED' });
    }
  });

  it('refuses evidence about another chain, gate or mandate', () => {
    for (const patch of [{ chainId: 4663n }, { gate: '0x000000000000000000000000000000000000beef' }, { mandateDigest: D('44') }]) {
      assert.deepEqual(observationFromGateEvidence(attempt, { ...settledEvidence, ...patch }, policy), { ok: false, refusal: 'EVIDENCE_MISMATCH' });
    }
  });

  it('refuses contradictory evidence rather than repairing it', () => {
    const noLog = { ...settledEvidence, settlement: null };
    const wrongLog = { ...settledEvidence, settlement: { transactionHash: D('aa'), executionCommitment: D('99') } };
    const logWithoutState = { ...unsettledEvidence, settlement: { transactionHash: D('aa'), executionCommitment: D('22') } };
    for (const e of [noLog, wrongLog, logWithoutState]) {
      assert.deepEqual(observationFromGateEvidence(attempt, e, policy), { ok: false, refusal: 'EVIDENCE_INCONSISTENT' });
    }
  });

  it('produces a FAILED observation the kernel accepts once the mandate has expired', () => {
    const reserved = applyTransition({
      current: unusedRecord(attempt.mandateDigest, 1_800_000_000n),
      transition: ReplayTransition.RESERVE,
      nowUnixSeconds: 1_800_000_000n,
      reservationSeconds: 600n,
      mandateExpiresAtUnixSeconds: attempt.mandateExpiresAtUnixSeconds,
    });
    assert.ok(reserved.ok);
    const quarantined = applyTransition({ current: reserved.value, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: 1_800_000_600n });
    assert.ok(quarantined.ok);
    const r = observationFromGateEvidence(attempt, { ...unsettledEvidence, observedAtUnixSeconds: attempt.mandateExpiresAtUnixSeconds + 60n }, policy);
    assert.ok(r.ok);
    const resolved = applyTransition({
      current: quarantined.value,
      transition: ReplayTransition.RECONCILE,
      nowUnixSeconds: attempt.mandateExpiresAtUnixSeconds + 120n,
      observation: r.observation,
    });
    assert.ok(resolved.ok, JSON.stringify(resolved, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(resolved.value.status, 'UNUSED');
  });

  it('produces observations the kernel replay state machine accepts', () => {
    const reserved = applyTransition({
      current: unusedRecord(attempt.mandateDigest, 1_800_000_000n),
      transition: ReplayTransition.RESERVE,
      nowUnixSeconds: 1_800_000_000n,
      reservationSeconds: 600n,
      mandateExpiresAtUnixSeconds: 1_800_003_600n,
    });
    assert.ok(reserved.ok);
    const r = observationFromGateEvidence(attempt, settledEvidence, policy);
    assert.ok(r.ok);
    const consumed = applyTransition({
      current: reserved.value,
      transition: ReplayTransition.RECONCILE,
      nowUnixSeconds: 1_800_000_200n,
      observation: r.observation,
    });
    assert.ok(consumed.ok, JSON.stringify(consumed, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(consumed.value.status, 'CONSUMED');
  });
});
