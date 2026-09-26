import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyTransition, ReplayTransition, unusedRecord, type Bytes32 } from '@mandate/kernel';
import {
  ConfirmationLevel,
  ZERO_BYTES32,
  observationFromGateEvidence,
  type GateAttemptRecord,
  type GateChainEvidence,
  type ReconciliationPolicy,
} from '../src/index.ts';

const D = (b: string) => `0x${b.repeat(32)}` as Bytes32;

const attempt: GateAttemptRecord = {
  chainId: 46630n,
  gate: '0x000000000000000000000000000000000000a7e0',
  mandateDigest: D('11'),
  executionCommitment: D('22'),
  deadline: 1_800_000_300n,
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
  blockTimestamp: attempt.deadline + 1n,
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

  it('establishes FAILED only once chain time is past the attempt deadline', () => {
    const failed = observationFromGateEvidence(attempt, unsettledEvidence, policy);
    assert.ok(failed.ok);
    assert.equal(failed.observation.outcome, 'FAILED');
    assert.equal(failed.observation.reference, attempt.executionCommitment);

    // A reverted receipt at the deadline itself is not enough: a copy of the same
    // signed attempt can still be included.
    const early = observationFromGateEvidence(attempt, { ...unsettledEvidence, blockTimestamp: attempt.deadline }, policy);
    assert.deepEqual(early, { ok: false, refusal: 'OUTCOME_UNESTABLISHED' });
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
