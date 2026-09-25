/**
 * Executable evidence for the production architecture pressure test.
 *
 * **These tests pin defects, not desired behaviour.** Each one asserts what the
 * kernel does today so that a finding in
 * [docs/production-architecture-pressure-test.md](../../../docs/production-architecture-pressure-test.md)
 * is reproducible rather than argued, and so that remediation is visible: when a
 * finding is fixed, the corresponding test here fails and must be inverted
 * deliberately. A green run of this file is not a statement that the behaviour
 * is correct.
 *
 * Every test name carries its finding id and severity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Decision,
  ReplayStatus,
  ReplayTransition,
  applyTransition,
  parseTrustedState,
  verify,
} from '../src/index.ts';
import { buildWorld } from './support/world.ts';
import { CHAIN, representationInput, stateInput } from './support/fixtures.ts';

// --- F-3 (HIGH): totality is bounded by the u16 encoding width ---------------

/**
 * `parseTrustedState` places no bound on `representations`, while
 * `encodeTrustedState` writes the count as a `u16`. The digests are computed in
 * `verify` before the per-check `try`, so the encoder's range assertion escapes
 * as a thrown error from a function documented as total (V-2) and as always
 * producing a receipt (INV-11).
 */
function representationsOfSize(count: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    const address = index.toString(16).padStart(40, '0');
    out.push(representationInput({ value: { representationId: `eip155:42161/erc20:0x${address}` } }));
  }
  return out;
}

test('F-3 (HIGH): parseTrustedState accepts a representation count the encoder cannot represent', () => {
  const parsed = parseTrustedState(stateInput({}, representationsOfSize(65_536)));
  assert.equal(parsed.ok, true, 'no bound is applied at parse time');
});

test('F-3 (HIGH): verify throws instead of returning a receipt at 65536 representations', () => {
  const atBound = verify(buildWorld({ representations: representationsOfSize(65_535) }));
  assert.equal(atBound.decision, Decision.REJECT, 'the last representable size still yields a receipt');

  assert.throws(
    () => verify(buildWorld({ representations: representationsOfSize(65_536) })),
    /exceeds 2-byte unsigned field/,
    'one past the bound escapes as a throw, so the refusal produces no receipt',
  );
});

// --- F-1 (HIGH): RECLAIM reopens a still-live authorization ------------------

/**
 * `docs/replay-semantics.md` §6 states that an attempt whose outcome was never
 * established leaves the mandate unavailable, and that "the reservation is
 * clamped to the mandate's own expiry so nothing is held past the point where
 * the authorization is dead anyway". The clamp is one-directional: it lowers a
 * reservation to the mandate expiry but never raises it. Any caller-chosen hold
 * shorter than the mandate's remaining life therefore returns a live
 * authorization to UNUSED while a submitted transaction may still settle.
 */
test('F-1 (HIGH): RECLAIM returns a mandate to UNUSED while it is still valid', () => {
  const now = 1_800_000_000n;
  const mandateExpiresAtUnixSeconds = now + 3_600n;
  const key = `0x${'11'.repeat(32)}` as never;

  const reserved = applyTransition({
    current: { key, status: ReplayStatus.UNUSED, updatedAtUnixSeconds: now, reservationExpiresAtUnixSeconds: null },
    transition: ReplayTransition.RESERVE,
    nowUnixSeconds: now,
    reservationSeconds: 300n,
    mandateExpiresAtUnixSeconds,
  });
  assert.equal(reserved.ok, true);
  assert.ok(reserved.ok);
  assert.equal(reserved.value.reservationExpiresAtUnixSeconds, now + 300n, 'the hold is not raised to the mandate expiry');

  const reclaimed = applyTransition({
    current: reserved.value,
    transition: ReplayTransition.RECLAIM,
    nowUnixSeconds: now + 301n,
  });
  assert.ok(reclaimed.ok);
  assert.equal(reclaimed.value.status, ReplayStatus.UNUSED);
  assert.ok(
    now + 301n < mandateExpiresAtUnixSeconds,
    'the authorization is spendable again with 3299 seconds of validity left',
  );
});

// --- F-6 (MEDIUM): the chain inside the representation id is not reconciled --

/**
 * `RepresentationId` is CAIP-19 shaped, so it carries the chain and the contract
 * the execution will address. The kernel checks `candidate.chain` against the
 * mandate's `allowedChains` and against the separate `chain` field of trusted
 * state, and never against the chain segment of the identifier itself. A
 * trusted-state builder that disagrees with its own identifier therefore passes.
 */
test('F-6 (MEDIUM): a contract on a disallowed chain passes when the chain field says otherwise', () => {
  const foreign = `eip155:1/erc20:0x${'de'.repeat(20)}`;
  const receipt = verify(
    buildWorld({
      candidate: { representationId: foreign, chain: CHAIN },
      representations: [representationInput({ value: { representationId: foreign, chain: CHAIN } })],
    }),
  );
  assert.equal(receipt.decision, Decision.PASS, 'the mandate allows only eip155:42161, and the contract is on eip155:1');
});

// --- F-8 (MEDIUM): the candidate binds a state name, not state content -------

/**
 * `checkStateBinding` compares `candidate.referenceStateId` to `state.stateId`,
 * a caller-chosen `Identifier`. Two materially different states sharing one
 * `stateId` both satisfy it. The receipt records `trustedStateDigest`, so the
 * substitution is auditable after the fact, but the check establishes nothing.
 */
test('F-8 (MEDIUM): two different states sharing one stateId both satisfy the binding', () => {
  const first = verify(buildWorld({}));
  const second = verify(
    buildWorld({
      state: {
        market: { value: { referencePrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 10_020n } } },
      },
    }),
  );
  assert.equal(first.decision, Decision.PASS);
  assert.equal(second.decision, Decision.PASS);
  assert.notEqual(first.trustedStateDigest, second.trustedStateDigest, 'the content differs');
});

// --- F-14 (LOW): the deviation bound is symmetric ----------------------------

/**
 * `deviationBps` is an absolute distance, so a BUY filled *below* the reference
 * is rejected on the same bound as one filled above it. This fails closed, and
 * it also refuses executions that are strictly better for the principal.
 */
test('F-14 (LOW): a BUY filled better than the reference is rejected on deviation', () => {
  const better = verify(
    buildWorld({
      candidate: {
        executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 9_500n },
        notional: { unit: 'USD', decimals: 2, atoms: 95_000n },
      },
    }),
  );
  assert.equal(better.decision, Decision.REJECT);
  assert.ok(better.reasonCodes.includes('PRICE_DEVIATION_EXCEEDED'));
});

// --- F-15 (LOW): a zero-quantity execution is authorized ---------------------

/**
 * No mandate field expresses a minimum size, and every economic check is
 * satisfied by zero: the notional is consistent with `0 × price`, it is within
 * `maxNotional`, and the deviation is unaffected. A zero-quantity execution is
 * therefore authorized and would consume a single-use authorization.
 */
test('F-15 (LOW): a zero-quantity candidate passes and would consume the mandate', () => {
  const receipt = verify(
    buildWorld({
      candidate: {
        quantity: { unit: 'SHARE', decimals: 2, atoms: 0n },
        notional: { unit: 'USD', decimals: 2, atoms: 0n },
      },
    }),
  );
  assert.equal(receipt.decision, Decision.PASS);
});
