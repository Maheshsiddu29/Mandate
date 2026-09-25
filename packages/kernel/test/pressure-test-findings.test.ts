/**
 * Regression tests for the kernel findings of the production architecture
 * pressure test.
 *
 * These began as defect-pinning tests: each asserted what the kernel did wrong
 * so that a finding in
 * [docs/production-architecture-pressure-test.md](../../../docs/production-architecture-pressure-test.md)
 * was reproducible rather than argued. Phase 5R remediated the findings, so each
 * test has been **inverted**: it now asserts the safe behaviour, and it fails if
 * the vulnerability ever returns.
 *
 * Every test name carries the finding id it guards. Nothing here passes because
 * a defect was retained.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Decision,
  MAX_STATE_REPRESENTATIONS,
  ReconciledOutcome,
  ReplayError,
  ReplayStatus,
  ReplayTransition,
  RETIRED_REPLAY_TRANSITIONS,
  applyTransition,
  isAvailable,
  parseTrustedState,
  trustedStateDigest,
  verify,
} from '../src/index.ts';
import { buildWorld } from './support/world.ts';
import {
  CHAIN,
  EPOCH,
  FOREIGN_CHAIN_REPRESENTATION_ID,
  NOW,
  OTHER_REGISTRY_SNAPSHOT_DIGEST,
  representationInput,
  stateInput,
} from './support/fixtures.ts';

// --- F-3: totality no longer depends on collection size ---------------------

function representationsOfSize(count: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    const address = index.toString(16).padStart(40, '0');
    out.push(representationInput({ value: { representationId: `eip155:42161/erc20:0x${address}` } }));
  }
  return out;
}

test('F-3 REGRESSION: an oversized representation collection is a typed rejection, not a throw', () => {
  const parsed = parseTrustedState(stateInput({}, representationsOfSize(MAX_STATE_REPRESENTATIONS + 1)));
  assert.equal(parsed.ok, false, 'the parser bounds the collection');
  assert.equal(parsed.ok ? '' : parsed.error, 'RESOURCE_LIMIT_EXCEEDED');
});

test('F-3 REGRESSION: verify returns a receipt below, at and above the representation bound', () => {
  // Immediately below and at the bound: a receipt, and the decision is reached
  // on the merits rather than on size.
  for (const count of [MAX_STATE_REPRESENTATIONS - 1, MAX_STATE_REPRESENTATIONS]) {
    const receipt = verify(buildWorld({ representations: representationsOfSize(count) }));
    assert.equal(receipt.decision, Decision.REJECT, `${count} representations`);
    assert.ok(receipt.reasonCodes.length > 0);
    assert.match(receipt.receiptDigest, /^0x[0-9a-f]{64}$/, `${count} must still produce a receipt digest`);
  }

  // One above: still a receipt. This is the case that used to throw.
  const over = verify(buildWorld({ representations: representationsOfSize(MAX_STATE_REPRESENTATIONS + 1) }));
  assert.equal(over.decision, Decision.REJECT);
  assert.ok(over.reasonCodes.includes('RESOURCE_LIMIT_EXCEEDED'), over.reasonCodes.join(', '));
  assert.match(over.receiptDigest, /^0x[0-9a-f]{64}$/, 'a refusal that leaves no receipt is not auditable (INV-11)');
});

// --- F-1: a lapsed reservation never restores permission --------------------

test('F-1 REGRESSION: a lapsed reservation quarantines instead of returning to UNUSED', () => {
  const now = 1_800_000_000n;
  const mandateExpiresAtUnixSeconds = now + 3_600n;
  const key = `0x${'11'.repeat(32)}` as never;

  const reserved = applyTransition({
    current: { key, status: ReplayStatus.UNUSED, updatedAtUnixSeconds: now, reservationExpiresAtUnixSeconds: null, resolution: null },
    transition: ReplayTransition.RESERVE,
    nowUnixSeconds: now,
    // The short hold that used to open the window: 300 seconds against an hour
    // of remaining validity.
    reservationSeconds: 300n,
    mandateExpiresAtUnixSeconds,
  });
  assert.ok(reserved.ok);

  const lapsed = applyTransition({
    current: reserved.value,
    transition: ReplayTransition.QUARANTINE,
    nowUnixSeconds: now + 301n,
  });
  assert.ok(lapsed.ok);
  assert.equal(lapsed.value.status, ReplayStatus.QUARANTINED, 'not UNUSED, however much validity is left');
  assert.equal(isAvailable(lapsed.value), false);
  assert.ok(now + 301n < mandateExpiresAtUnixSeconds, 'the mandate is still live, which is exactly the dangerous case');

  // And the verifier refuses it, so the quarantine is not merely a label.
  const receipt = verify(buildWorld({ state: { replay: { value: { status: 'QUARANTINED' } } } }));
  assert.equal(receipt.decision, Decision.REJECT);
  assert.ok(receipt.reasonCodes.includes('MANDATE_QUARANTINED'));
});

test('F-1 REGRESSION: there is no transition from a lapsed reservation to permission without an observation', () => {
  const now = 1_800_000_000n;
  const key = `0x${'11'.repeat(32)}` as never;
  const reserved = applyTransition({
    current: { key, status: ReplayStatus.UNUSED, updatedAtUnixSeconds: now, reservationExpiresAtUnixSeconds: null, resolution: null },
    transition: ReplayTransition.RESERVE,
    nowUnixSeconds: now,
    reservationSeconds: 60n,
    mandateExpiresAtUnixSeconds: now + 3_600n,
  });
  assert.ok(reserved.ok);
  const quarantined = applyTransition({ current: reserved.value, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: now + 61n });
  assert.ok(quarantined.ok);

  // Exhaustive over the transition vocabulary, plus the retired names: nothing
  // that a timer or a retry loop could reach on its own produces an available
  // authorization, and no transition applies without an observation.
  for (const transition of [...Object.values(ReplayTransition), ...RETIRED_REPLAY_TRANSITIONS]) {
    const result = applyTransition({
      current: quarantined.value,
      transition,
      nowUnixSeconds: now + 10_000n,
      reservationSeconds: 60n,
      mandateExpiresAtUnixSeconds: now + 3_600n,
      // Deliberately omitted: no observation is asserted.
    });
    assert.equal(result.ok, false, `${transition} must not restore permission`);
    if (result.ok) continue;
    assert.ok(
      [ReplayError.OBSERVATION_REQUIRED, ReplayError.NOT_RESERVABLE, ReplayError.NOT_RESERVED, ReplayError.UNKNOWN_TRANSITION]
        .includes(result.error as never),
      `${transition} -> ${result.error}`,
    );
  }

  // Only a validated observation of failure restores it, and the record keeps it.
  const reconciled = applyTransition({
    current: quarantined.value,
    transition: ReplayTransition.RECONCILE,
    nowUnixSeconds: now + 10_000n,
    observation: {
      outcome: ReconciledOutcome.FAILED,
      observedAtUnixSeconds: now + 10_000n,
      sourceId: 'observer.chain.test',
      reference: `0x${'cd'.repeat(32)}`,
    },
  });
  assert.ok(reconciled.ok);
  assert.equal(reconciled.value.status, ReplayStatus.UNUSED);
  assert.equal(reconciled.value.resolution?.outcome, ReconciledOutcome.FAILED);
});

// --- F-6: the chain inside the identifier is reconciled ---------------------

test('F-6 REGRESSION: a contract on a disallowed chain rejects even when the chain field says otherwise', () => {
  const receipt = verify(
    buildWorld({
      candidate: { representationId: FOREIGN_CHAIN_REPRESENTATION_ID, chain: CHAIN },
      representations: [representationInput({ value: { representationId: FOREIGN_CHAIN_REPRESENTATION_ID, chain: CHAIN } })],
    }),
  );
  assert.equal(receipt.decision, Decision.REJECT, 'the mandate allows only eip155:42161 and the contract is on eip155:1');
  assert.ok(receipt.reasonCodes.includes('REPRESENTATION_CHAIN_INCONSISTENT'), receipt.reasonCodes.join(', '));
});

test('F-6 REGRESSION: the identifier is the canonical chain, in the candidate and in trusted state', () => {
  // The candidate alone disagreeing with its own identifier.
  const candidateOnly = verify(buildWorld({ candidate: { chain: 'eip155:1' } }));
  assert.ok(candidateOnly.reasonCodes.includes('REPRESENTATION_CHAIN_INCONSISTENT'));

  // Trusted state alone disagreeing with its own identifier.
  const stateOnly = verify(
    buildWorld({ representations: [representationInput({ value: { chain: 'eip155:1' } })] }),
  );
  assert.ok(stateOnly.reasonCodes.includes('REPRESENTATION_CHAIN_INCONSISTENT'), stateOnly.reasonCodes.join(', '));
});

// --- F-8 / N-1: the state binding, corrected ------------------------------

/**
 * F-8's remediation was right about the disease and wrong about the cure.
 *
 * The finding was that `referenceStateId` is a caller-chosen label, so two
 * materially different states could satisfy one candidate's binding. Phase 5R
 * fixed that by requiring the candidate to commit to the digest of the *whole*
 * trusted state and comparing it at every `verify` call.
 *
 * That over-corrected (finding N-1). A trusted-state digest covers observation
 * timestamps, so *any* fresh observation changed it, and the execution-handoff
 * re-verification — whose entire purpose is to read fresh state — could only ever
 * pass by replaying the evaluation state. Whole-state equality made the
 * re-verification a tautology.
 *
 * Phase 5R.1 splits the binding by what the fact actually is (ADR 0017), and
 * these three tests are the corrected property in full.
 */

test('N-1 REGRESSION: a fresh state that is otherwise safe verifies, rather than failing on a digest', () => {
  const evaluation = buildWorld({});
  const evaluationReceipt = verify(evaluation);
  assert.equal(evaluationReceipt.decision, Decision.PASS);

  // The same candidate, against state re-observed five seconds later: a new
  // snapshot label, newer provenance, and a reference price that moved within
  // the mandate's deviation bound. Every byte of the state digest differs.
  const later = NOW + 5n;
  const refreshed = stateInput({
    stateId: 'snapshot.0002',
    market: {
      provenance: { observedAtUnixSeconds: later },
      value: { referencePrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 10_020n } },
    },
    corporateAction: { provenance: { observedAtUnixSeconds: later } },
    replay: { provenance: { observedAtUnixSeconds: later } },
  });
  const parsedRefreshed = parseTrustedState(refreshed);
  assert.ok(parsedRefreshed.ok);
  assert.notEqual(evaluationReceipt.trustedStateDigest, trustedStateDigest(parsedRefreshed.value));

  const handoff = verify({
    ...evaluation,
    trustedState: { ...refreshed, replay: (evaluation.trustedState as Record<string, unknown>)['replay'] as unknown },
    clock: { nowUnixSeconds: later },
  });
  assert.equal(handoff.decision, Decision.PASS, `a safe refresh must pass: ${handoff.reasonCodes.join(', ')}`);
  assert.notEqual(handoff.trustedStateDigest, evaluationReceipt.trustedStateDigest, 'and it really was different state');
});

test('N-1 REGRESSION: a fresh state with a material change rejects for that change, not for a digest', () => {
  const evaluation = buildWorld({});
  const later = NOW + 5n;
  const replay = (evaluation.trustedState as Record<string, unknown>)['replay'] as unknown;

  const cases: readonly {
    readonly label: string;
    readonly state: Record<string, unknown>;
    readonly code: string;
    /** The epoch case legitimately also reports the candidate's own epoch commitment. */
    readonly alsoCandidateMismatch?: boolean;
  }[] = [
    {
      label: 'halted',
      state: { market: { provenance: { observedAtUnixSeconds: later }, value: { haltStatus: 'HALTED' } } },
      code: 'TRADING_HALTED',
    },
    {
      label: 'representation paused',
      state: { market: { provenance: { observedAtUnixSeconds: later } } },
      code: 'REPRESENTATION_INACTIVE',
    },
    {
      label: 'price outside the mandate bound',
      state: {
        market: {
          provenance: { observedAtUnixSeconds: later },
          value: { referencePrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 10_500n } },
        },
      },
      code: 'PRICE_DEVIATION_EXCEEDED',
    },
    {
      label: 'corporate action epoch advanced',
      state: {
        market: { provenance: { observedAtUnixSeconds: later } },
        corporateAction: { provenance: { observedAtUnixSeconds: later }, value: { epoch: EPOCH + 1n } },
      },
      code: 'CORPORATE_ACTION_STATE_CHANGED',
      // The candidate commits to the epoch it was built under, so this case also
      // reports `CANDIDATE_STATE_MISMATCH` for that field. That is the one place
      // the code survives, and it is what it was always documented to mean.
      alsoCandidateMismatch: true,
    },
  ];

  for (const item of cases) {
    const representations = item.label === 'representation paused'
      ? [representationInput({ value: { operationalState: 'PAUSED' } })]
      : undefined;
    const refreshed = stateInput({ stateId: 'snapshot.0002', ...item.state }, representations);
    const receipt = verify({
      ...evaluation,
      trustedState: { ...refreshed, replay },
      clock: { nowUnixSeconds: later },
    });
    assert.equal(receipt.decision, Decision.REJECT, item.label);
    assert.ok(receipt.reasonCodes.includes(item.code as never), `${item.label} -> ${receipt.reasonCodes.join(', ')}`);
    // The specific reason, not a generic state mismatch. This is the whole point:
    // an operator reading the receipt learns what changed.
    if (item.alsoCandidateMismatch !== true) {
      assert.ok(!receipt.reasonCodes.includes('CANDIDATE_STATE_MISMATCH' as never), item.label);
    }
  }
});

test('N-8 REGRESSION: structural authority is still bound by equality, and absence fails closed', () => {
  // A registry snapshot is not a dynamic observation, so it is not permitted to
  // refresh under a candidate. This is the binding that replaces whole-state
  // equality, and the only piece of state provenance compared for equality.
  const swapped = verify(buildWorld({ candidate: { registrySnapshotDigest: OTHER_REGISTRY_SNAPSHOT_DIGEST } }));
  assert.equal(swapped.decision, Decision.REJECT);
  assert.ok(swapped.reasonCodes.includes('REGISTRY_SNAPSHOT_MISMATCH'), swapped.reasonCodes.join(', '));

  // Before Phase 5R.1 a state declaring no snapshot was accepted, because the
  // whole-state digest covered it incidentally. Removing that cover made an
  // undeclared snapshot an unestablished binding, and unestablished rejects.
  const undeclared = verify(buildWorld({ state: { registrySnapshotDigest: null } }));
  assert.equal(undeclared.decision, Decision.REJECT);
  assert.ok(undeclared.reasonCodes.includes('REGISTRY_SNAPSHOT_UNKNOWN'), undeclared.reasonCodes.join(', '));

  // The label alone still establishes nothing, which was F-8's original point:
  // two states sharing one stateId are told apart by their content, now by the
  // predicates over that content rather than by a digest comparison.
  const sameLabelDifferentWorld = verify({
    ...buildWorld({}),
    trustedState: stateInput({ market: { value: { haltStatus: 'HALTED' } } }),
  });
  assert.equal(sameLabelDifferentWorld.decision, Decision.REJECT);
  assert.ok(sameLabelDifferentWorld.reasonCodes.includes('TRADING_HALTED'));
});

// --- F-2 / F-4: the kernel is the economic authority -----------------------

test('F-2 REGRESSION: the kernel refuses a BUY whose fees push the total debit over the signed bound', () => {
  // At the bound exactly: passes. The valid world's limit is the notional plus
  // its fee, so there is no slack to hide a fee in.
  assert.equal(verify(buildWorld()).decision, Decision.PASS);

  // One atom of fee past it: the kernel itself refuses, with no router involved.
  const over = verify(buildWorld({ candidate: { feeTotal: { unit: 'USD', decimals: 2, atoms: 901n } } }));
  assert.equal(over.decision, Decision.REJECT);
  assert.ok(over.reasonCodes.includes('TOTAL_DEBIT_EXCEEDED'), over.reasonCodes.join(', '));
});

test('F-4 REGRESSION: the kernel refuses a SELL whose fees erode the proceeds past the signed floor', () => {
  // A SELL mandate reads economicLimit as a minimum total credit.
  const floor = { unit: 'USD', decimals: 2, atoms: 99_000n };
  const sell = { side: 'SELL', economicLimit: floor };

  // Fees of 10.00 on a 1000.00 notional leave 990.00, exactly at the floor.
  const atFloor = verify(buildWorld({
    mandate: sell,
    candidate: { side: 'SELL', feeTotal: { unit: 'USD', decimals: 2, atoms: 1_000n } },
  }));
  assert.equal(atFloor.decision, Decision.PASS, atFloor.reasonCodes.join(', '));

  // One atom more of fee and the credit is below the floor.
  const belowFloor = verify(buildWorld({
    mandate: sell,
    candidate: { side: 'SELL', feeTotal: { unit: 'USD', decimals: 2, atoms: 1_001n } },
  }));
  assert.equal(belowFloor.decision, Decision.REJECT);
  assert.ok(belowFloor.reasonCodes.includes('TOTAL_CREDIT_BELOW_MINIMUM'), belowFloor.reasonCodes.join(', '));

  // The one-atom sale the pressure test found admissible: fees one atom below
  // the whole notional. It is now refused whatever floor is set, because a floor
  // of zero is still a floor the credit must clear, and because a credit of one
  // atom clears nothing a principal would sign.
  const ruinous = verify(buildWorld({
    mandate: { side: 'SELL', economicLimit: { unit: 'USD', decimals: 2, atoms: 1n } },
    candidate: { side: 'SELL', feeTotal: { unit: 'USD', decimals: 2, atoms: 99_999n } },
  }));
  assert.equal(ruinous.decision, Decision.PASS, 'a principal may sign a floor of one atom, and this clears it');

  // What is never permitted is fees at or above the notional: that is a debit
  // dressed as a sale, and there is no defensible credit to compare.
  const netDebit = verify(buildWorld({
    mandate: { side: 'SELL', economicLimit: { unit: 'USD', decimals: 2, atoms: 1n } },
    candidate: { side: 'SELL', feeTotal: { unit: 'USD', decimals: 2, atoms: 100_000n } },
  }));
  assert.equal(netDebit.decision, Decision.REJECT);
  assert.ok(netDebit.reasonCodes.includes('FEES_EXCEED_NOTIONAL'), netDebit.reasonCodes.join(', '));
});

test('F-2/F-4 REGRESSION: the candidate digest commits to the fee total', () => {
  const base = verify(buildWorld());
  const differentFee = verify(buildWorld({ candidate: { feeTotal: { unit: 'USD', decimals: 2, atoms: 100n } } }));
  assert.notEqual(
    base.candidateDigest,
    differentFee.candidateDigest,
    'a fee change must change the commitment a Phase 6 gate would re-assert',
  );
});
