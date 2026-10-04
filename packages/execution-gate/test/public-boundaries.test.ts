/**
 * Public trust boundaries of @mandate/execution-gate (docs/public-trust-boundaries.md).
 *
 * `observationFromGateEvidence` and `admitAttemptUnderReservation` are the two
 * class-A boundaries: evidence comes from an RPC reader, and reservation records
 * from the pipeline's store. Each is probed with the same eleven hostile plain
 * values the cross-package inventory in packages/jev/test/public-boundaries.test.ts
 * uses, at every argument position: no exception, a refusal, and no mutation of
 * input.
 *
 * The reference model (`authorizeExecution`, `settleExecution`) is a class-B
 * typed API. Its external boundary for execution is the gate's own ABI decoder;
 * the test below pins that classification so a change to it is deliberate.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { applyTransition, bytesToHex, ReplayTransition, unusedRecord, type Bytes32 } from '@mandate/kernel';
import * as gate from '../src/index.ts';
import {
  ConfirmationLevel,
  MAX_ATTEMPTS_PER_RESERVATION,
  admitAttemptUnderReservation,
  encodeGateMandate,
  executionCommitment,
  observationFromGateEvidence,
} from '../src/index.ts';
import { T0, baseMandate, baseTerms, mandateDigestOf } from './support/world.ts';

const HOSTILE_PLAIN_VALUES: readonly unknown[] = [
  null,
  undefined,
  false,
  true,
  0,
  1,
  '',
  'not a valid request!',
  [],
  {},
  { malformed: { nested: true } },
];

const D = (b: string) => `0x${b.repeat(32)}`;
const mandate = baseMandate();
const digest = mandateDigestOf(mandate) as Bytes32;
const reserved = applyTransition({
  current: unusedRecord(digest, T0),
  transition: ReplayTransition.RESERVE,
  nowUnixSeconds: T0,
  reservationSeconds: 600n,
  mandateExpiresAtUnixSeconds: mandate.expiresAtUnixSeconds,
});
if (!reserved.ok) throw new Error('baseline reservation');
const terms = baseTerms();
const commitment = executionCommitment({ mandateDigest: digest, candidateDigest: D('c0') as Bytes32, terms });
const valid = {
  record: {
    chainId: 46630n,
    gate: '0x000000000000000000000000000000000000a7e0',
    mandateEncoding: bytesToHex(encodeGateMandate(mandate)),
    reservation: reserved.value,
    attempts: [{ candidateDigest: D('c0'), terms, executionCommitment: commitment }],
  },
  evidence: {
    level: ConfirmationLevel.FINALIZED,
    chainId: 46630n,
    gate: '0x000000000000000000000000000000000000a7e0',
    mandateDigest: digest,
    consumedCommitment: commitment,
    blockTimestamp: T0 + 100n,
    settlement: { transactionHash: D('aa'), executionCommitment: commitment },
    observedAtUnixSeconds: T0 + 200n,
  },
  policy: { requiredLevel: ConfirmationLevel.FINALIZED, sourceId: 'gate-reader.test' },
  attempt: { candidateDigest: D('c1'), terms: { ...terms, fundingLimit: 1n } },
  now: T0 + 10n,
};

test('the valid baselines succeed, so every refusal below is caused by the hostile value', () => {
  assert.equal(observationFromGateEvidence(valid.record, valid.evidence, valid.policy).ok, true);
  assert.equal(admitAttemptUnderReservation(valid.record, valid.attempt, valid.now).ok, true);
});

for (const position of ['record', 'evidence', 'policy'] as const) {
  test(`observationFromGateEvidence refuses every hostile ${position} without throwing or mutating`, () => {
    for (const hostile of HOSTILE_PLAIN_VALUES) {
      const before = structuredClone(hostile);
      const args = { ...valid, [position]: hostile };
      const result = observationFromGateEvidence(args.record, args.evidence, args.policy);
      assert.deepEqual(result, { ok: false, refusal: 'EVIDENCE_MALFORMED' }, String(hostile));
      assert.ok(isDeepStrictEqual(hostile, before));
    }
  });
}

for (const position of ['record', 'attempt', 'now'] as const) {
  test(`admitAttemptUnderReservation refuses every hostile ${position} without throwing or mutating`, () => {
    for (const hostile of HOSTILE_PLAIN_VALUES) {
      const before = structuredClone(hostile);
      const args = { ...valid, [position]: hostile };
      const result = admitAttemptUnderReservation(args.record, args.attempt, args.now);
      assert.deepEqual(result, { ok: false, refusal: 'ATTEMPT_MALFORMED' }, String(hostile));
      assert.ok(isDeepStrictEqual(hostile, before));
    }
  });
}

test('malformed reservation-record fields refuse rather than coerce', () => {
  const attempt = valid.record.attempts[0];
  const records: Record<string, unknown>[] = [
    { ...valid.record, chainId: 46630 },
    { ...valid.record, mandateEncoding: valid.record.mandateEncoding.toUpperCase().replace('0X', '0x') },
    { ...valid.record, mandateEncoding: '0x' },
    { ...valid.record, reservation: { ...valid.record.reservation, status: 'reserved' } },
    { ...valid.record, attempts: {} },
    { ...valid.record, attempts: Array.from({ length: MAX_ATTEMPTS_PER_RESERVATION + 1 }, () => attempt) },
    { ...valid.record, attempts: [{ ...attempt, terms: { ...attempt?.terms, deadline: 2n ** 64n } }] },
    { ...valid.record, attempts: [{ ...attempt, terms: { ...attempt?.terms, executionData: '0xAB' } }] },
    { ...valid.record, attempts: [{ ...attempt, terms: { ...attempt?.terms, executionData: `0x${'00'.repeat(4_097)}` } }] },
    { ...valid.record, attempts: [{ ...attempt, executionCommitment: undefined }] },
  ];
  for (const record of records) {
    assert.deepEqual(observationFromGateEvidence(record, valid.evidence, valid.policy), { ok: false, refusal: 'EVIDENCE_MALFORMED' });
    assert.deepEqual(admitAttemptUnderReservation(record, valid.attempt, valid.now), { ok: false, refusal: 'ATTEMPT_MALFORMED' });
  }
});

test('malformed nested fields refuse rather than coerce', () => {
  const cases: Record<string, unknown>[] = [
    { ...valid.evidence, level: 'finalized' },
    { ...valid.evidence, level: 'toString' },
    { ...valid.evidence, chainId: 46630 },
    { ...valid.evidence, gate: '0x000000000000000000000000000000000000A7E0' },
    { ...valid.evidence, consumedCommitment: D('AA') },
    { ...valid.evidence, settlement: {} },
    { ...valid.evidence, settlement: undefined },
    { ...valid.evidence, blockTimestamp: 2n ** 63n },
  ];
  for (const evidence of cases) {
    assert.deepEqual(observationFromGateEvidence(valid.record, evidence, valid.policy), { ok: false, refusal: 'EVIDENCE_MALFORMED' });
  }
});

test('exports are classified: two class-A boundaries, everything else a typed internal API', () => {
  const functions = Object.entries(gate).filter(([, v]) => typeof v === 'function').map(([k]) => k).sort();
  assert.deepEqual(functions, [
    'admitAttemptUnderReservation', // A
    'applyDelegatedExecution', // C2.3 V3 reference model
    'authorizeExecution', // B: typed reference model; the gate's ABI decoder is the execution boundary
    'caip2',
    'ceilToScale',
    'decodeGateCandidate',
    'decodeGateMandate',
    'delegatedDomainSeparator',
    'delegatedExecutionApprovalHash',
    'delegatedExecutionApprovalStructHash',
    'delegatedPortfolioAuthorizationHash',
    'delegationStructHash',
    'eip712Hash',
    'encodeGateCandidate',
    'encodeGateMandate',
    'encodeRevert',
    'errorSignature',
    'executionCommitment',
    'floorToScale',
    'gateDomain',
    'gateRevertData',
    'observationFromGateEvidence', // A
    'recoverSigner',
    'reject',
    'representationIdFor',
    'revokeDelegationState',
    'selectorOf',
    'settleExecution', // B
    'toGateCandidate',
    'toGateMandate',
    'validateExecutionProfile', // B: typed pre-signing configuration validator
  ]);
});
