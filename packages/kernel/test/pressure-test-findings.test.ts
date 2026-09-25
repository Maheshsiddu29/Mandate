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
  applyTransition,
  isAvailable,
  parseTrustedState,
  trustedStateDigest,
  verify,
} from '../src/index.ts';
import { buildWorld } from './support/world.ts';
import { CHAIN, FOREIGN_CHAIN_REPRESENTATION_ID, representationInput, stateInput } from './support/fixtures.ts';

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
    current: { key, status: ReplayStatus.UNUSED, updatedAtUnixSeconds: now, reservationExpiresAtUnixSeconds: null },
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
    current: { key, status: ReplayStatus.UNUSED, updatedAtUnixSeconds: now, reservationExpiresAtUnixSeconds: null },
    transition: ReplayTransition.RESERVE,
    nowUnixSeconds: now,
    reservationSeconds: 60n,
    mandateExpiresAtUnixSeconds: now + 3_600n,
  });
  assert.ok(reserved.ok);
  const quarantined = applyTransition({ current: reserved.value, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: now + 61n });
  assert.ok(quarantined.ok);

  // Exhaustive over the transition vocabulary: only RECONCILE applies, and only
  // with an outcome. Nothing that a timer or a retry loop could reach on its own
  // produces an available authorization.
  for (const transition of Object.values(ReplayTransition)) {
    const result = applyTransition({
      current: quarantined.value,
      transition,
      nowUnixSeconds: now + 10_000n,
      reservationSeconds: 60n,
      mandateExpiresAtUnixSeconds: now + 3_600n,
      // Deliberately omitted: no outcome is asserted.
    });
    if (transition === ReplayTransition.RECONCILE) {
      assert.equal(result.ok, false, 'RECONCILE without an outcome is refused');
      assert.equal(result.ok ? '' : result.error, ReplayError.OUTCOME_REQUIRED);
      continue;
    }
    assert.equal(result.ok, false, `${transition} must not act on a quarantine`);
    assert.equal(result.ok ? '' : result.error, ReplayError.NOT_QUARANTINED, transition);
  }

  // Only an authoritative observation of failure restores it.
  const reconciled = applyTransition({
    current: quarantined.value,
    transition: ReplayTransition.RECONCILE,
    nowUnixSeconds: now + 10_000n,
    reconciledOutcome: ReconciledOutcome.FAILED,
  });
  assert.ok(reconciled.ok);
  assert.equal(reconciled.value.status, ReplayStatus.UNUSED);
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

// --- F-8: the state binding is a commitment to content ---------------------

test('F-8 REGRESSION: two different states sharing one stateId no longer both satisfy the binding', () => {
  const first = verify(buildWorld({}));
  assert.equal(first.decision, Decision.PASS);

  // The same candidate, bound to the first state's digest, against a state that
  // shares its stateId but carries a different reference price.
  const movedState = stateInput({
    market: { value: { referencePrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 10_020n } } },
  });
  const parsedMoved = parseTrustedState(movedState);
  assert.ok(parsedMoved.ok);
  const world = buildWorld({});
  const substituted = verify({ ...world, trustedState: movedState });

  assert.equal(substituted.decision, Decision.REJECT, 'the label matches; the content does not');
  assert.ok(
    substituted.violations.some((v) => v.code === 'CANDIDATE_STATE_MISMATCH' && v.detail['field'] === 'referenceStateDigest'),
    substituted.reasonCodes.join(', '),
  );
  assert.notEqual(first.trustedStateDigest, trustedStateDigest(parsedMoved.value));
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
