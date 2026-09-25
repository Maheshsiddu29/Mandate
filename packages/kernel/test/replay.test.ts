/**
 * Replay state machine tests.
 *
 * The rules under test are in `docs/replay-semantics.md`. The two that carry
 * the most weight: reserve happens before signing, so a second attempt cannot
 * reserve; and release requires *observing* failure, so an attempt that cannot
 * establish its outcome leaves the mandate reserved rather than freeing it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Decision,
  ReconciledOutcome,
  ReplayError,
  ReplayStatus,
  ReplayTransition,
  applyTransition,
  isAvailable,
  mandateDigest,
  replayKey,
  unusedRecord,
  verify,
  type ReplayRecord,
} from '../src/index.ts';
import { EXPIRES_AT, NOW } from './support/fixtures.ts';
import { buildWorld } from './support/world.ts';
import { validMandate } from './support/fixtures.ts';

const KEY = ('0x' + 'ab'.repeat(32)) as never;

function expectOk<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  assert.equal(r.ok, true, r.ok ? '' : `unexpected error: ${r.error}`);
  return (r as { ok: true; value: T }).value;
}

function errorOf(r: { ok: true } | { ok: false; error: string }): string {
  assert.equal(r.ok, false, 'expected a rejection');
  return (r as { ok: false; error: string }).error;
}

const reserve = (current: ReplayRecord, now = NOW, hold = 120n) =>
  applyTransition({ current, transition: ReplayTransition.RESERVE, nowUnixSeconds: now, reservationSeconds: hold });

test('the replay key is the mandate digest', () => {
  const m = validMandate();
  assert.equal(replayKey(m), mandateDigest(m));
  // Two mandates differing only in nonce are independently spendable.
  assert.notEqual(replayKey(validMandate({ nonce: 1n })), replayKey(validMandate({ nonce: 2n })));
  // Any change of terms produces a different key, so an amended mandate cannot
  // ride a spent one's record.
  assert.notEqual(replayKey(validMandate()), replayKey(validMandate({ maxDeviationBps: 41n })));
});

test('the happy path is reserve then commit', () => {
  const start = unusedRecord(KEY, NOW);
  const reserved = expectOk(reserve(start));
  assert.equal(reserved.status, ReplayStatus.RESERVED);
  assert.equal(reserved.reservationExpiresAtUnixSeconds, NOW + 120n);

  const consumed = expectOk(
    applyTransition({ current: reserved, transition: ReplayTransition.COMMIT, nowUnixSeconds: NOW + 5n }),
  );
  assert.equal(consumed.status, ReplayStatus.CONSUMED);
  assert.equal(consumed.reservationExpiresAtUnixSeconds, null);
});

test('a second attempt cannot reserve an already-reserved mandate', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW)));
  assert.equal(errorOf(reserve(reserved)), ReplayError.NOT_RESERVABLE);
});

test('consumption is terminal', () => {
  const consumed = expectOk(
    applyTransition({
      current: expectOk(reserve(unusedRecord(KEY, NOW))),
      transition: ReplayTransition.COMMIT,
      nowUnixSeconds: NOW,
    }),
  );
  for (const transition of [ReplayTransition.RESERVE, ReplayTransition.COMMIT, ReplayTransition.RELEASE] as const) {
    assert.equal(
      errorOf(applyTransition({ current: consumed, transition, nowUnixSeconds: NOW, reservationSeconds: 60n })),
      ReplayError.ALREADY_CONSUMED,
      transition,
    );
  }
});

test('commit and release are only valid from a reservation', () => {
  const unused = unusedRecord(KEY, NOW);
  for (const transition of [ReplayTransition.COMMIT, ReplayTransition.RELEASE, ReplayTransition.QUARANTINE] as const) {
    assert.equal(
      errorOf(applyTransition({ current: unused, transition, nowUnixSeconds: NOW })),
      ReplayError.NOT_RESERVED,
      transition,
    );
  }
});

test('release returns a reserved mandate to unused, so a failed attempt can retry', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW)));
  const released = expectOk(
    applyTransition({ current: reserved, transition: ReplayTransition.RELEASE, nowUnixSeconds: NOW + 3n }),
  );
  assert.equal(released.status, ReplayStatus.UNUSED);
  assert.equal(released.reservationExpiresAtUnixSeconds, null);
  // And it is reservable again.
  assert.equal(expectOk(reserve(released, NOW + 4n)).status, ReplayStatus.RESERVED);
});

test('a reservation can only be quarantined after it expires', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW), NOW, 120n));
  const quarantine = (now: bigint) =>
    applyTransition({ current: reserved, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: now });

  assert.equal(errorOf(quarantine(NOW + 119n)), ReplayError.RESERVATION_NOT_EXPIRED);
  // At and past the boundary it quarantines. It never returns to UNUSED: the
  // reservation lapsing says the attempt stopped reporting, not that it failed.
  assert.equal(expectOk(quarantine(NOW + 120n)).status, ReplayStatus.QUARANTINED, 'at the boundary');
  assert.equal(expectOk(quarantine(NOW + 121n)).status, ReplayStatus.QUARANTINED);
  assert.equal(expectOk(quarantine(NOW + 120n)).reservationExpiresAtUnixSeconds, null);
});

test('a lapsed reservation never restores permission, however long it has been', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW), NOW, 120n));
  for (const elapsed of [120n, 121n, 10_000n, 10n ** 9n]) {
    const after = expectOk(
      applyTransition({ current: reserved, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: NOW + elapsed }),
    );
    assert.equal(after.status, ReplayStatus.QUARANTINED, `+${elapsed}s`);
    assert.equal(isAvailable(after), false, `+${elapsed}s must not be available`);
  }
});

test('only reconciliation leaves a quarantine, and it must state what it found', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW), NOW, 120n));
  const quarantined = expectOk(
    applyTransition({ current: reserved, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: NOW + 120n }),
  );

  // Nothing else may act on it. RELEASE in particular claims an observation the
  // quarantine exists to record that nobody has.
  for (const transition of [ReplayTransition.RESERVE, ReplayTransition.COMMIT, ReplayTransition.RELEASE, ReplayTransition.QUARANTINE] as const) {
    assert.equal(
      errorOf(applyTransition({ current: quarantined, transition, nowUnixSeconds: NOW + 200n, reservationSeconds: 60n })),
      ReplayError.NOT_QUARANTINED,
      transition,
    );
  }

  // RECONCILE without an outcome is refused rather than defaulting either way.
  assert.equal(
    errorOf(applyTransition({ current: quarantined, transition: ReplayTransition.RECONCILE, nowUnixSeconds: NOW + 200n })),
    ReplayError.OUTCOME_REQUIRED,
  );

  const settled = expectOk(applyTransition({
    current: quarantined, transition: ReplayTransition.RECONCILE,
    nowUnixSeconds: NOW + 200n, reconciledOutcome: ReconciledOutcome.SETTLED,
  }));
  assert.equal(settled.status, ReplayStatus.CONSUMED);
  assert.equal(isAvailable(settled), false);

  const failed = expectOk(applyTransition({
    current: quarantined, transition: ReplayTransition.RECONCILE,
    nowUnixSeconds: NOW + 200n, reconciledOutcome: ReconciledOutcome.FAILED,
  }));
  assert.equal(failed.status, ReplayStatus.UNUSED);
  assert.equal(isAvailable(failed), true);
});

test('a consumed authorization is terminal even against reconciliation', () => {
  const consumed = expectOk(applyTransition({
    current: expectOk(reserve(unusedRecord(KEY, NOW))),
    transition: ReplayTransition.COMMIT,
    nowUnixSeconds: NOW + 5n,
  }));
  assert.equal(
    errorOf(applyTransition({
      current: consumed, transition: ReplayTransition.RECONCILE,
      nowUnixSeconds: NOW + 9n, reconciledOutcome: ReconciledOutcome.FAILED,
    })),
    ReplayError.ALREADY_CONSUMED,
  );
});

test('a reservation never outlives the mandate it holds', () => {
  const reserved = expectOk(
    applyTransition({
      current: unusedRecord(KEY, NOW),
      transition: ReplayTransition.RESERVE,
      nowUnixSeconds: NOW,
      reservationSeconds: 100_000n,
      mandateExpiresAtUnixSeconds: EXPIRES_AT,
    }),
  );
  assert.equal(reserved.reservationExpiresAtUnixSeconds, EXPIRES_AT);
});

test('a zero or negative reservation is refused', () => {
  for (const hold of [0n, -1n]) {
    assert.equal(errorOf(reserve(unusedRecord(KEY, NOW), NOW, hold)), ReplayError.NOT_RESERVABLE, String(hold));
  }
});

test('an unknown record cannot be transitioned into a known one', () => {
  const unknown: ReplayRecord = {
    key: KEY,
    status: ReplayStatus.UNKNOWN,
    updatedAtUnixSeconds: NOW,
    reservationExpiresAtUnixSeconds: null,
  };
  for (const transition of Object.values(ReplayTransition)) {
    assert.equal(
      errorOf(applyTransition({ current: unknown, transition, nowUnixSeconds: NOW, reservationSeconds: 60n })),
      ReplayError.UNKNOWN_STATE,
      transition,
    );
  }
});

test('the verifier refuses every non-available replay status', () => {
  const expected: Record<string, string> = {
    RESERVED: 'MANDATE_RESERVED',
    CONSUMED: 'MANDATE_ALREADY_CONSUMED',
    UNKNOWN: 'REPLAY_STATE_UNKNOWN',
  };
  for (const [status, code] of Object.entries(expected)) {
    const receipt = verify(buildWorld({ state: { replay: { value: { status } } } }));
    assert.equal(receipt.decision, Decision.REJECT, status);
    assert.ok(receipt.reasonCodes.includes(code as never), `${status} -> ${receipt.reasonCodes.join(', ')}`);
  }
  assert.equal(verify(buildWorld({ state: { replay: { value: { status: 'UNUSED' } } } })).decision, Decision.PASS);
});
