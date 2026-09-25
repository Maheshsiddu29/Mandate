/**
 * The commitment hierarchy, at the kernel layer.
 *
 * After Phase 5R.1 changed what a candidate commits to and how each commitment is
 * used (ADR 0017), the hierarchy is worth stating and testing as its own property
 * rather than leaving it implied by the encoders:
 *
 * ```
 *   signed mandate digest                 keccak256(MCE(mandate)), signed under EIP-712
 *     └─ candidate digest                 keccak256(MCE(candidate)) — covers every
 *        │                                candidate field, including both state
 *        │                                provenance commitments and the fee total
 *        ├─ evaluation-state provenance    evaluationStateId + evaluationStateDigest:
 *        │                                committed, audited, never a predicate
 *        └─ structural authority           registrySnapshotDigest: committed *and*
 *                                          compared for equality against the state
 *     └─ verification receipt digest      covers mandate, candidate and
 *                                          trusted-state digests, the evaluation
 *                                          instant, the decision and every violation
 * ```
 *
 * The routing/handoff layer continues it — a fresh handoff-state digest and the
 * final re-verification receipt, both inside the routing receipt — and
 * `router/test/commitment-hierarchy.test.ts` tests that half.
 *
 * Two properties are asserted here:
 *
 * 1. **Nothing escapes commitment.** Every field the candidate carries changes
 *    the candidate digest, driven off `CANDIDATE_FIELDS` so a field added without
 *    a case fails rather than passing silently.
 * 2. **Commitment is not enforcement, and the two are distinguishable.** The
 *    fields that are committed for audit do not change the verdict; the field that
 *    is committed for enforcement does. That distinction is the whole of N-1's
 *    remediation, and it is only meaningful if both halves are checked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANDIDATE_FIELDS,
  Decision,
  candidateDigest,
  decodeCandidate,
  encodeCandidate,
  mandateDigest,
  parseCandidate,
  parseMandate,
  parseTrustedState,
  trustedStateDigest,
  verify,
} from '../src/index.ts';
import {
  AMD,
  EPOCH,
  OTHER_AGENT,
  OTHER_REGISTRY_SNAPSHOT_DIGEST,
  OTHER_VENUE,
  SYNTHETIC_REPRESENTATION_ID,
  UNAPPROVED_ISSUER,
  validCandidate,
} from './support/fixtures.ts';
import { buildWorld } from './support/world.ts';

test('every candidate field is committed, and the field list is exhaustively covered', () => {
  const base = candidateDigest(validCandidate());

  // One mutation per candidate field. `version` is excluded from the mutation set
  // because a different version does not parse at all, which is a stronger
  // property than a different digest and is tested elsewhere.
  const mutations: Record<string, Record<string, unknown>> = {
    representationId: { representationId: SYNTHETIC_REPRESENTATION_ID },
    canonicalAsset: { canonicalAsset: { ...AMD } },
    issuer: { issuer: UNAPPROVED_ISSUER },
    chain: { chain: 'eip155:1' },
    venue: { venue: OTHER_VENUE },
    side: { side: 'SELL' },
    agent: { agent: { ...OTHER_AGENT } },
    quantity: { quantity: { unit: 'SHARE', decimals: 2, atoms: 1_001n } },
    executionPrice: { executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 10_001n } },
    notional: { notional: { unit: 'USD', decimals: 2, atoms: 100_001n } },
    feeTotal: { feeTotal: { unit: 'USD', decimals: 2, atoms: 251n } },
    evaluationStateId: { evaluationStateId: 'snapshot.9999' },
    evaluationStateDigest: { evaluationStateDigest: '0x' + 'ab'.repeat(32) },
    registrySnapshotDigest: { registrySnapshotDigest: OTHER_REGISTRY_SNAPSHOT_DIGEST },
    corporateActionEpoch: { corporateActionEpoch: EPOCH + 1n },
  };

  // The mutation set is exactly the field set, minus `version`. This is what makes
  // the property survive a schema change: adding a field without a case fails here.
  assert.deepEqual(
    Object.keys(mutations).sort(),
    CANDIDATE_FIELDS.filter((name) => name !== 'version').slice().sort(),
    'every candidate field needs a mutation case',
  );

  const digests = new Map<string, string>();
  for (const [field, override] of Object.entries(mutations)) {
    const digest = candidateDigest(validCandidate(override));
    assert.notEqual(digest, base, `${field} must change the candidate digest`);
    const collision = digests.get(digest);
    assert.equal(collision, undefined, `${field} collides with ${String(collision)}`);
    digests.set(digest, field);
  }
});

test('the candidate encoding round-trips both state commitments and the registry binding', () => {
  const candidate = validCandidate();
  const decoded = decodeCandidate(encodeCandidate(candidate));
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.value.evaluationStateId, candidate.evaluationStateId);
  assert.equal(decoded.value.evaluationStateDigest, candidate.evaluationStateDigest);
  assert.equal(decoded.value.registrySnapshotDigest, candidate.registrySnapshotDigest);
  // Canonicality: re-encoding the decoded value reproduces the bytes.
  assert.deepEqual(encodeCandidate(decoded.value), encodeCandidate(candidate));
});

test('a v3 candidate encoding does not decode as a v2 one, so the change is not silent', () => {
  // The domain tag carries the version, so the same field values under the old tag
  // are a different byte string and do not decode. An integrator on schema v2 gets
  // a refusal rather than a misread candidate.
  const bytes = encodeCandidate(validCandidate());
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  assert.ok(text.includes('MANDATE.CANDIDATE.V3'), 'the encoding names its version');
  assert.ok(!text.includes('MANDATE.CANDIDATE.V2'));

  const downgraded = new Uint8Array(bytes);
  const marker = text.indexOf('MANDATE.CANDIDATE.V3');
  downgraded[marker + 'MANDATE.CANDIDATE.V'.length] = '2'.charCodeAt(0);
  assert.equal(decodeCandidate(downgraded).ok, false, 'a retagged encoding does not decode');
});

test('committed-for-audit and committed-for-enforcement are distinguishable', () => {
  // Audit: evaluation-state provenance changes the candidate digest and does not
  // change the verdict. This is the property that makes a fresh handoff possible.
  const audited = verify(buildWorld({
    candidate: { evaluationStateId: 'snapshot.9999', evaluationStateDigest: '0x' + 'ab'.repeat(32) },
    unboundState: true,
  }));
  const baseline = verify(buildWorld({}));
  assert.equal(baseline.decision, Decision.PASS);
  assert.equal(audited.decision, Decision.PASS, audited.reasonCodes.join(', '));
  assert.notEqual(audited.candidateDigest, baseline.candidateDigest, 'committed');
  assert.notEqual(audited.receiptDigest, baseline.receiptDigest, 'and visible in the receipt');

  // Enforcement: the registry snapshot binding changes both.
  const enforced = verify(buildWorld({ candidate: { registrySnapshotDigest: OTHER_REGISTRY_SNAPSHOT_DIGEST } }));
  assert.equal(enforced.decision, Decision.REJECT);
  assert.ok(enforced.reasonCodes.includes('REGISTRY_SNAPSHOT_MISMATCH'));
  assert.notEqual(enforced.candidateDigest, baseline.candidateDigest);
});

test('the receipt commits to every input the verdict was computed over', () => {
  const world = buildWorld({});
  const receipt = verify(world);
  assert.equal(receipt.decision, Decision.PASS);

  // Each digest in the receipt is the digest of the corresponding input, recomputed
  // here from the world's own inputs, so the chain from a signed mandate to a
  // verdict is reconstructible from the receipt alone.
  const mandate = parseMandate(world.mandate);
  const candidate = parseCandidate(world.candidate);
  const state = parseTrustedState(world.trustedState);
  assert.ok(mandate.ok && candidate.ok && state.ok);
  assert.equal(receipt.mandateDigest, mandateDigest(mandate.value));
  assert.equal(receipt.candidateDigest, candidateDigest(candidate.value));
  assert.equal(receipt.trustedStateDigest, trustedStateDigest(state.value));
  assert.equal(receipt.evaluatedAtUnixSeconds, (world.clock as { nowUnixSeconds: bigint }).nowUnixSeconds);

  // The candidate's own commitments are the ones ADR 0017 layered: provenance of
  // the world it was built against, and the registry snapshot that world declared.
  assert.equal(candidate.value.evaluationStateDigest, trustedStateDigest(state.value));
  assert.equal(candidate.value.registrySnapshotDigest, state.value.registrySnapshotDigest);

  // And the receipt digest covers the decision, so a receipt cannot be restated
  // with a different verdict over the same inputs.
  const rejected = verify(buildWorld({ candidate: { registrySnapshotDigest: OTHER_REGISTRY_SNAPSHOT_DIGEST } }));
  assert.notEqual(rejected.receiptDigest, receipt.receiptDigest);
});
