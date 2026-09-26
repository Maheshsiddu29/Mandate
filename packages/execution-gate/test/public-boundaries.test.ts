/**
 * Public trust boundaries of @mandate/execution-gate (docs/public-trust-boundaries.md).
 *
 * `observationFromGateEvidence` is the one class-A boundary: its evidence comes
 * from an RPC reader. It is probed with the same eleven hostile plain values the
 * cross-package inventory in packages/jev/test/public-boundaries.test.ts uses, at
 * every argument position: no exception, a refusal, and no mutation of input.
 *
 * The reference model (`authorizeExecution`, `settleExecution`) is a class-B
 * typed API. Its external boundary for execution is the gate's own ABI decoder;
 * the test below pins that classification so a change to it is deliberate.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import * as gate from '../src/index.ts';
import { ConfirmationLevel, observationFromGateEvidence } from '../src/index.ts';

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
const valid = {
  attempt: { chainId: 46630n, gate: '0x000000000000000000000000000000000000a7e0', mandateDigest: D('11'), executionCommitment: D('22'), deadline: 1_800_000_300n },
  evidence: {
    level: ConfirmationLevel.FINALIZED,
    chainId: 46630n,
    gate: '0x000000000000000000000000000000000000a7e0',
    mandateDigest: D('11'),
    consumedCommitment: D('22'),
    blockTimestamp: 1_800_000_100n,
    settlement: { transactionHash: D('aa'), executionCommitment: D('22') },
    observedAtUnixSeconds: 1_800_000_200n,
  },
  policy: { requiredLevel: ConfirmationLevel.FINALIZED, sourceId: 'gate-reader.test' },
};

test('the valid baseline settles, so every refusal below is caused by the hostile value', () => {
  assert.equal(observationFromGateEvidence(valid.attempt, valid.evidence, valid.policy).ok, true);
});

for (const position of ['attempt', 'evidence', 'policy'] as const) {
  test(`observationFromGateEvidence refuses every hostile ${position} without throwing or mutating`, () => {
    for (const hostile of HOSTILE_PLAIN_VALUES) {
      const before = structuredClone(hostile);
      const args = { ...valid, [position]: hostile };
      const result = observationFromGateEvidence(args.attempt, args.evidence, args.policy);
      assert.deepEqual(result, { ok: false, refusal: 'EVIDENCE_MALFORMED' }, String(hostile));
      assert.ok(isDeepStrictEqual(hostile, before));
    }
  });
}

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
    assert.deepEqual(observationFromGateEvidence(valid.attempt, evidence, valid.policy), { ok: false, refusal: 'EVIDENCE_MALFORMED' });
  }
});

test('exports are classified: one class-A boundary, everything else a typed internal API', () => {
  const functions = Object.entries(gate).filter(([, v]) => typeof v === 'function').map(([k]) => k).sort();
  assert.deepEqual(functions, [
    'authorizeExecution', // B: typed reference model; the gate's ABI decoder is the execution boundary
    'caip2',
    'ceilToScale',
    'decodeGateCandidate',
    'decodeGateMandate',
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
    'selectorOf',
    'settleExecution', // B
    'toGateCandidate',
    'toGateMandate',
    'validateExecutionProfile', // B: typed pre-signing configuration validator
  ]);
});
