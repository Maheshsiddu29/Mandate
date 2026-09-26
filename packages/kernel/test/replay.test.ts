/**
 * Replay state machine tests.
 *
 * The rules under test are in `docs/replay-semantics.md`. The two that carry the
 * most weight since Phase 5R.1: an authorization is restored only by a validated
 * *observation* of failure, never by a bare command; and `applyTransition` is
 * total over plain values, so no caller-controlled string can slip past the
 * vocabulary and land on a favourable branch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Decision,
  ReconciledOutcome,
  ReplayError,
  ReplayStatus,
  ReplayTransition,
  RETIRED_REPLAY_TRANSITIONS,
  applyTransition,
  isAvailable,
  mandateDigest,
  parseExecutionObservation,
  parseReplayRecord,
  parseReconciledOutcome,
  parseReplayTransition,
  replayKey,
  unusedRecord,
  verify,
  type ReplayRecord,
} from '../src/index.ts';
import { EXPIRES_AT, NOW } from './support/fixtures.ts';
import { buildWorld } from './support/world.ts';
import { validMandate } from './support/fixtures.ts';

const KEY = ('0x' + 'ab'.repeat(32)) as never;
const TX = ('0x' + 'cd'.repeat(32)) as never;

function expectOk<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  assert.equal(r.ok, true, r.ok ? '' : `unexpected error: ${r.error}`);
  return (r as { ok: true; value: T }).value;
}

function errorOf(r: { ok: true } | { ok: false; error: string }): string {
  assert.equal(r.ok, false, 'expected a rejection');
  return (r as { ok: false; error: string }).error;
}

/** A well-formed observation of what an attempt did. */
function observation(outcome: string, at = NOW + 5n) {
  return { outcome, observedAtUnixSeconds: at, sourceId: 'observer.chain.test', reference: TX };
}

const reserve = (current: ReplayRecord, now = NOW, hold = 120n) =>
  applyTransition({ current, transition: ReplayTransition.RESERVE, nowUnixSeconds: now, reservationSeconds: hold });

const reconcile = (current: ReplayRecord, outcome: string, now = NOW + 5n) =>
  applyTransition({ current, transition: ReplayTransition.RECONCILE, nowUnixSeconds: now, observation: observation(outcome, now) });

test('the replay key is the mandate digest', () => {
  const m = validMandate();
  assert.equal(replayKey(m), mandateDigest(m));
  // Two mandates differing only in nonce are independently spendable.
  assert.notEqual(replayKey(validMandate({ nonce: 1n })), replayKey(validMandate({ nonce: 2n })));
  // Any change of terms produces a different key, so an amended mandate cannot
  // ride a spent one's record.
  assert.notEqual(replayKey(validMandate()), replayKey(validMandate({ maxDeviationBps: 41n })));
});

test('the happy path is reserve then reconcile with observed settlement', () => {
  const start = unusedRecord(KEY, NOW);
  const reserved = expectOk(reserve(start));
  assert.equal(reserved.status, ReplayStatus.RESERVED);
  assert.equal(reserved.reservationExpiresAtUnixSeconds, NOW + 120n);
  assert.equal(reserved.resolution, null, 'a reservation asserts nothing about an outcome');

  const consumed = expectOk(reconcile(reserved, ReconciledOutcome.SETTLED));
  assert.equal(consumed.status, ReplayStatus.CONSUMED);
  assert.equal(consumed.reservationExpiresAtUnixSeconds, null);
  // The record carries what justified the resolution, not merely that it happened.
  assert.equal(consumed.resolution?.outcome, ReconciledOutcome.SETTLED);
  assert.equal(consumed.resolution?.sourceId, 'observer.chain.test');
  assert.equal(consumed.resolution?.reference, TX);
});

test('a second attempt cannot reserve an already-reserved mandate', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW)));
  assert.equal(errorOf(reserve(reserved)), ReplayError.NOT_RESERVABLE);
});

test('consumption is terminal under every transition in the vocabulary', () => {
  const consumed = expectOk(reconcile(expectOk(reserve(unusedRecord(KEY, NOW))), ReconciledOutcome.SETTLED));
  for (const transition of Object.values(ReplayTransition)) {
    assert.equal(
      errorOf(applyTransition({
        current: consumed,
        transition,
        nowUnixSeconds: NOW + 10n,
        reservationSeconds: 60n,
        observation: observation(ReconciledOutcome.FAILED, NOW + 10n),
      })),
      ReplayError.ALREADY_CONSUMED,
      transition,
    );
  }
});

test('reconciliation is only valid from an attempt that exists', () => {
  const unused = unusedRecord(KEY, NOW);
  assert.equal(errorOf(reconcile(unused, ReconciledOutcome.FAILED)), ReplayError.NOT_RESOLVABLE);
  assert.equal(errorOf(reconcile(unused, ReconciledOutcome.SETTLED)), ReplayError.NOT_RESOLVABLE);
  // And quarantine needs a live reservation to lapse.
  assert.equal(
    errorOf(applyTransition({ current: unused, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: NOW })),
    ReplayError.NOT_RESERVED,
  );
});

test('observed failure returns a reserved mandate to unused, so a failed attempt can retry', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW)));
  const released = expectOk(reconcile(reserved, ReconciledOutcome.FAILED, NOW + 3n));
  assert.equal(released.status, ReplayStatus.UNUSED);
  assert.equal(released.reservationExpiresAtUnixSeconds, null);
  assert.equal(released.resolution?.outcome, ReconciledOutcome.FAILED, 'the restore records its evidence');
  // And it is reservable again.
  assert.equal(expectOk(reserve(released, NOW + 4n)).status, ReplayStatus.RESERVED);
});

// --- N-5: an unsubstantiated command cannot restore an authorization --------

test('N-5 REGRESSION: the retired bare-command transitions are refused, not reinterpreted', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW)));
  for (const retired of RETIRED_REPLAY_TRANSITIONS) {
    const result = applyTransition({
      current: reserved,
      transition: retired,
      nowUnixSeconds: NOW + 5n,
      reservationSeconds: 60n,
    });
    assert.equal(result.ok, false, `${retired} must not apply`);
    assert.equal(result.ok ? '' : result.error, ReplayError.UNKNOWN_TRANSITION, retired);
  }
  // RELEASE in particular: the transition that used to restore permission on a
  // bare assertion is gone, and the record is untouched.
  assert.ok(RETIRED_REPLAY_TRANSITIONS.includes('RELEASE'));
  assert.equal(reserved.status, ReplayStatus.RESERVED);
});

test('N-5 REGRESSION: restoring an authorization requires a complete, well-formed observation', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW)));

  // No observation at all.
  assert.equal(
    errorOf(applyTransition({ current: reserved, transition: ReplayTransition.RECONCILE, nowUnixSeconds: NOW + 5n })),
    ReplayError.OBSERVATION_REQUIRED,
  );
  assert.equal(
    errorOf(applyTransition({ current: reserved, transition: ReplayTransition.RECONCILE, nowUnixSeconds: NOW + 5n, observation: null })),
    ReplayError.OBSERVATION_REQUIRED,
  );

  // Present but incomplete: each field is load-bearing and none is defaulted.
  const complete = observation(ReconciledOutcome.FAILED);
  for (const field of ['outcome', 'observedAtUnixSeconds', 'sourceId', 'reference'] as const) {
    const partial: Record<string, unknown> = { ...complete };
    delete partial[field];
    assert.equal(
      errorOf(applyTransition({ current: reserved, transition: ReplayTransition.RECONCILE, nowUnixSeconds: NOW + 5n, observation: partial })),
      ReplayError.OBSERVATION_INVALID,
      `missing ${field}`,
    );
  }

  // An unknown extra field is refused too: a caller sending a shape this kernel
  // does not understand has not established what it thinks it has.
  assert.equal(
    errorOf(applyTransition({
      current: reserved,
      transition: ReplayTransition.RECONCILE,
      nowUnixSeconds: NOW + 5n,
      observation: { ...complete, confidence: 'high' },
    })),
    ReplayError.OBSERVATION_INVALID,
  );

  // And the authorization stayed unavailable through every one of those.
  assert.equal(isAvailable(reserved), false);
});

// --- N-3: RECONCILE accepts only recognized runtime outcome values ----------

test('N-3 REGRESSION: an unrecognized reconciliation outcome is refused and never defaults to FAILED', () => {
  const quarantined = expectOk(applyTransition({
    current: expectOk(reserve(unusedRecord(KEY, NOW), NOW, 120n)),
    transition: ReplayTransition.QUARANTINE,
    nowUnixSeconds: NOW + 120n,
  }));

  const hostile: readonly { readonly label: string; readonly outcome: unknown }[] = [
    { label: 'UNKNOWN', outcome: 'UNKNOWN' },
    { label: 'lowercase settled', outcome: 'settled' },
    { label: 'lowercase failed', outcome: 'failed' },
    { label: 'mixed case', outcome: 'Failed' },
    { label: 'trailing space', outcome: 'FAILED ' },
    { label: 'null', outcome: null },
    { label: 'undefined', outcome: undefined },
    { label: 'zero', outcome: 0 },
    { label: 'one', outcome: 1 },
    { label: 'empty string', outcome: '' },
    { label: 'object', outcome: { outcome: 'FAILED' } },
    { label: 'array', outcome: ['FAILED'] },
    { label: 'arbitrary string', outcome: 'definitely-not-an-outcome' },
    { label: 'true', outcome: true },
    { label: 'false', outcome: false },
    { label: 'prototype property', outcome: 'toString' },
    { label: 'constructor', outcome: 'constructor' },
  ];

  for (const item of hostile) {
    const result = applyTransition({
      current: quarantined,
      transition: ReplayTransition.RECONCILE,
      nowUnixSeconds: NOW + 200n,
      observation: { ...observation(ReconciledOutcome.FAILED, NOW + 200n), outcome: item.outcome },
    });
    assert.equal(result.ok, false, `${item.label} must not resolve a quarantine`);
    assert.equal(result.ok ? '' : result.error, ReplayError.OBSERVATION_INVALID, item.label);
    // The property that matters: the authorization is still unavailable.
    assert.equal(isAvailable(quarantined), false, item.label);
  }

  // The two recognized values, and only those two, apply.
  assert.equal(expectOk(reconcile(quarantined, 'SETTLED', NOW + 200n)).status, ReplayStatus.CONSUMED);
  assert.equal(expectOk(reconcile(quarantined, 'FAILED', NOW + 200n)).status, ReplayStatus.UNUSED);
});

test('N-3 REGRESSION: the outcome parser is exact', () => {
  assert.equal(expectOk(parseReconciledOutcome('SETTLED')), ReconciledOutcome.SETTLED);
  assert.equal(expectOk(parseReconciledOutcome('FAILED')), ReconciledOutcome.FAILED);
  for (const raw of ['UNKNOWN', 'settled', '', ' FAILED', 'hasOwnProperty', 0, -1, null, undefined, {}, [], true]) {
    assert.equal(errorOf(parseReconciledOutcome(raw)), ReplayError.OBSERVATION_INVALID, String(raw));
  }
  // The observation parser refuses the same set, whole.
  assert.equal(errorOf(parseExecutionObservation({ ...observation('UNKNOWN') })), ReplayError.OBSERVATION_INVALID);
  assert.equal(errorOf(parseExecutionObservation('SETTLED')), ReplayError.OBSERVATION_INVALID);
  assert.equal(errorOf(parseExecutionObservation([observation('FAILED')])), ReplayError.OBSERVATION_INVALID);
  assert.equal(expectOk(parseExecutionObservation(observation('SETTLED'))).outcome, ReconciledOutcome.SETTLED);
});

// --- N-4: the transition boundary is total ----------------------------------

test('N-4 REGRESSION: an unrecognized transition is a typed error, never undefined', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW)));
  const hostile: readonly unknown[] = [
    'RECLAIM', 'COMMIT', 'RELEASE', 'reserve', 'Reserve', 'RESERVE ', '', 'UNKNOWN',
    'toString', 'constructor', '__proto__', 'hasOwnProperty',
    null, undefined, 0, 1, -1, true, false, {}, [], ['RESERVE'], { transition: 'RESERVE' },
  ];
  for (const transition of hostile) {
    const result = applyTransition({
      current: reserved,
      transition,
      nowUnixSeconds: NOW + 5n,
      reservationSeconds: 60n,
      observation: observation(ReconciledOutcome.FAILED),
    });
    // Totality: a result object, every time. Never `undefined`.
    assert.notEqual(result, undefined, String(transition));
    assert.equal(typeof result, 'object', String(transition));
    assert.equal(result.ok, false, String(transition));
    assert.equal(result.ok ? '' : result.error, ReplayError.UNKNOWN_TRANSITION, String(transition));
  }
});

test('N-4 REGRESSION: every member of the vocabulary is recognized and nothing else is', () => {
  for (const name of Object.values(ReplayTransition)) {
    assert.equal(expectOk(parseReplayTransition(name)), name);
  }
  for (const name of RETIRED_REPLAY_TRANSITIONS) {
    assert.equal(errorOf(parseReplayTransition(name)), ReplayError.UNKNOWN_TRANSITION, name);
  }
  assert.equal(Object.values(ReplayTransition).length, 3, 'RESERVE, QUARANTINE, RECONCILE');
});

test('N-4 REGRESSION: a malformed record is refused rather than transitioned', () => {
  const base = unusedRecord(KEY, NOW);
  const malformed: readonly { readonly label: string; readonly record: ReplayRecord }[] = [
    { label: 'unrecognized status', record: { ...base, status: 'AVAILABLE' as never } },
    { label: 'empty status', record: { ...base, status: '' as never } },
    { label: 'status is an object', record: { ...base, status: {} as never } },
    { label: 'key is not bytes32', record: { ...base, key: '0xnope' as never } },
    { label: 'updatedAt is a number', record: { ...base, updatedAtUnixSeconds: 1 as never } },
    { label: 'expiry is a string', record: { ...base, reservationExpiresAtUnixSeconds: '10' as never } },
  ];
  for (const item of malformed) {
    assert.equal(
      errorOf(applyTransition({ current: item.record, transition: ReplayTransition.RESERVE, nowUnixSeconds: NOW, reservationSeconds: 60n })),
      ReplayError.MALFORMED_RECORD,
      item.label,
    );
  }
  // And a non-bigint instant, which would otherwise reach string concatenation.
  assert.equal(
    errorOf(applyTransition({ current: base, transition: ReplayTransition.RESERVE, nowUnixSeconds: 1 as never, reservationSeconds: 60n })),
    ReplayError.MALFORMED_RECORD,
  );
});

test('stored replay records enforce the complete shape of every state', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW), NOW, 120n));
  const quarantined = expectOk(applyTransition({
    current: reserved,
    transition: ReplayTransition.QUARANTINE,
    nowUnixSeconds: NOW + 120n,
  }));
  const settled = observation(ReconciledOutcome.SETTLED, NOW + 5n);
  const failed = observation(ReconciledOutcome.FAILED, NOW + 5n);
  const consumed = expectOk(reconcile(reserved, ReconciledOutcome.SETTLED, NOW + 5n));
  const restored = expectOk(reconcile(reserved, ReconciledOutcome.FAILED, NOW + 5n));

  for (const [label, record] of [
    ['initial UNUSED', unusedRecord(KEY, NOW)],
    ['restored UNUSED', restored],
    ['RESERVED', reserved],
    ['QUARANTINED', quarantined],
    ['CONSUMED', consumed],
    ['UNKNOWN', { ...unusedRecord(KEY, NOW), status: ReplayStatus.UNKNOWN }],
  ] as const) {
    assert.equal(parseReplayRecord(record).ok, true, label);
  }

  const malformed: readonly { readonly label: string; readonly record: unknown }[] = [
    { label: 'RESERVED + SETTLED', record: { ...reserved, resolution: settled } },
    { label: 'RESERVED + FAILED', record: { ...reserved, resolution: failed } },
    { label: 'CONSUMED + FAILED', record: { ...consumed, resolution: failed } },
    { label: 'QUARANTINED + terminal resolution', record: { ...quarantined, resolution: settled } },
    { label: 'invalid enum', record: { ...reserved, status: 'RELEASED' } },
    { label: 'missing reservation', record: { ...reserved, reservationExpiresAtUnixSeconds: null } },
    { label: 'inverted reservation timestamps', record: { ...reserved, reservationExpiresAtUnixSeconds: NOW - 1n } },
    { label: 'equal reservation timestamps', record: { ...reserved, reservationExpiresAtUnixSeconds: NOW } },
    { label: 'malformed resolution', record: { ...consumed, resolution: { outcome: 'SETTLED' } } },
    { label: 'timestamp overflow', record: { ...reserved, updatedAtUnixSeconds: 2n ** 63n } },
    { label: 'expiry overflow', record: { ...reserved, reservationExpiresAtUnixSeconds: 2n ** 63n } },
    { label: 'resolution timestamp overflow', record: { ...consumed, resolution: { ...settled, observedAtUnixSeconds: 2n ** 63n } } },
    { label: 'resolution after state update', record: { ...consumed, resolution: { ...settled, observedAtUnixSeconds: consumed.updatedAtUnixSeconds + 1n } } },
    { label: 'extra incompatible field', record: { ...reserved, released: true } },
    { label: 'UNUSED reservation', record: { ...unusedRecord(KEY, NOW), reservationExpiresAtUnixSeconds: NOW + 1n } },
    { label: 'CONSUMED without evidence', record: { ...consumed, resolution: null } },
    { label: 'UNKNOWN with resolution', record: { ...unusedRecord(KEY, NOW), status: ReplayStatus.UNKNOWN, resolution: failed } },
  ];

  for (const item of malformed) {
    assert.equal(errorOf(parseReplayRecord(item.record)), ReplayError.MALFORMED_RECORD, item.label);
    const transition = applyTransition({
      current: item.record,
      transition: ReplayTransition.RECONCILE,
      nowUnixSeconds: NOW + 10n,
      observation: failed,
    });
    assert.equal(errorOf(transition), ReplayError.MALFORMED_RECORD, item.label);
    assert.equal(isAvailable(item.record), false, `${item.label} must remain unavailable`);
  }
});

test('the transition boundary refuses malformed plain top-level values without throwing', () => {
  for (const raw of [null, undefined, false, true, 0, 1, 'RESERVE', [], {}, { current: null }] as const) {
    assert.doesNotThrow(() => applyTransition(raw));
    const result = applyTransition(raw);
    assert.equal(result.ok, false, String(raw));
    assert.ok(
      result.ok === false &&
        (result.error === ReplayError.MALFORMED_RECORD || result.error === ReplayError.UNKNOWN_TRANSITION),
      String(raw),
    );
  }
  assert.equal(errorOf(applyTransition(null)), ReplayError.MALFORMED_RECORD);
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
  assert.equal(
    expectOk(quarantine(NOW + 120n)).reservationExpiresAtUnixSeconds,
    NOW + 120n,
    'quarantine preserves the reservation timeline for reconciliation',
  );
  assert.equal(expectOk(quarantine(NOW + 120n)).updatedAtUnixSeconds, NOW);
  assert.equal(expectOk(quarantine(NOW + 120n)).resolution, null, 'a quarantine establishes no outcome');
});

test('reconciliation observations must fit the reservation and evaluation timeline', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW), NOW, 120n));
  const quarantined = expectOk(applyTransition({
    current: reserved,
    transition: ReplayTransition.QUARANTINE,
    nowUnixSeconds: NOW + 120n,
  }));

  const validCases = [
    { label: 'exactly at reservation', observedAt: NOW, reconciledAt: NOW + 10n },
    { label: 'after reservation', observedAt: NOW + 1n, reconciledAt: NOW + 10n },
    { label: 'exactly at reconciliation', observedAt: NOW + 10n, reconciledAt: NOW + 10n },
  ] as const;
  for (const current of [reserved, quarantined]) {
    for (const item of validCases) {
      const result = applyTransition({
        current,
        transition: ReplayTransition.RECONCILE,
        nowUnixSeconds: item.reconciledAt,
        observation: observation(ReconciledOutcome.FAILED, item.observedAt),
      });
      assert.equal(expectOk(result).status, ReplayStatus.UNUSED, `${current.status}: ${item.label}`);
    }
  }

  const invalidCases = [
    { label: 'one second before reservation', observedAt: NOW - 1n, reconciledAt: NOW + 10n },
    { label: 'one second after reconciliation', observedAt: NOW + 11n, reconciledAt: NOW + 10n },
    { label: 'far future', observedAt: 2n ** 62n, reconciledAt: NOW + 10n },
    { label: 'zero', observedAt: 0n, reconciledAt: NOW + 10n },
    { label: 'timestamp overflow', observedAt: 2n ** 63n, reconciledAt: NOW + 10n },
  ] as const;
  for (const current of [reserved, quarantined]) {
    for (const item of invalidCases) {
      const before = structuredClone(current);
      const result = applyTransition({
        current,
        transition: ReplayTransition.RECONCILE,
        nowUnixSeconds: item.reconciledAt,
        observation: observation(ReconciledOutcome.FAILED, item.observedAt),
      });
      assert.equal(errorOf(result), ReplayError.OBSERVATION_INVALID, `${current.status}: ${item.label}`);
      assert.deepEqual(current, before, `${current.status}: ${item.label} must not mutate the record`);
      assert.equal(isAvailable(current), false, `${current.status}: ${item.label} must not restore authorization`);
    }
  }

  const maximum = 2n ** 63n - 1n;
  const atBoundary = expectOk(reserve(unusedRecord(KEY, maximum - 1n), maximum - 1n, 1n));
  const reconciled = applyTransition({
    current: atBoundary,
    transition: ReplayTransition.RECONCILE,
    nowUnixSeconds: maximum,
    observation: observation(ReconciledOutcome.SETTLED, maximum),
  });
  assert.equal(expectOk(reconciled).status, ReplayStatus.CONSUMED, 'the exact maximum is valid without overflow');
  assert.equal(
    errorOf(reserve(unusedRecord(KEY, maximum), maximum, 1n)),
    ReplayError.NOT_RESERVABLE,
    'a reservation timestamp beyond the maximum is a typed refusal',
  );
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

  // Nothing else may act on it: a quarantine is not reservable, and it cannot be
  // quarantined again.
  assert.equal(
    errorOf(applyTransition({ current: quarantined, transition: ReplayTransition.RESERVE, nowUnixSeconds: NOW + 200n, reservationSeconds: 60n })),
    ReplayError.NOT_RESERVABLE,
  );
  assert.equal(
    errorOf(applyTransition({ current: quarantined, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: NOW + 200n })),
    ReplayError.NOT_RESERVED,
  );

  // RECONCILE without an observation is refused rather than defaulting either way.
  assert.equal(
    errorOf(applyTransition({ current: quarantined, transition: ReplayTransition.RECONCILE, nowUnixSeconds: NOW + 200n })),
    ReplayError.OBSERVATION_REQUIRED,
  );

  const settled = expectOk(reconcile(quarantined, ReconciledOutcome.SETTLED, NOW + 200n));
  assert.equal(settled.status, ReplayStatus.CONSUMED);
  assert.equal(isAvailable(settled), false);

  const failed = expectOk(reconcile(quarantined, ReconciledOutcome.FAILED, NOW + 200n));
  assert.equal(failed.status, ReplayStatus.UNUSED);
  assert.equal(isAvailable(failed), true);
  assert.equal(failed.resolution?.outcome, ReconciledOutcome.FAILED);
});

test('a consumed authorization is terminal even against reconciliation', () => {
  const consumed = expectOk(reconcile(expectOk(reserve(unusedRecord(KEY, NOW))), ReconciledOutcome.SETTLED));
  assert.equal(errorOf(reconcile(consumed, ReconciledOutcome.FAILED, NOW + 9n)), ReplayError.ALREADY_CONSUMED);
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
  // And a missing or non-bigint hold, which is the same unestablished input.
  assert.equal(
    errorOf(applyTransition({ current: unusedRecord(KEY, NOW), transition: ReplayTransition.RESERVE, nowUnixSeconds: NOW })),
    ReplayError.NOT_RESERVABLE,
  );
});

test('an unknown record cannot be transitioned into a known one', () => {
  const unknown: ReplayRecord = {
    key: KEY,
    status: ReplayStatus.UNKNOWN,
    updatedAtUnixSeconds: NOW,
    reservationExpiresAtUnixSeconds: null,
    resolution: null,
  };
  for (const transition of Object.values(ReplayTransition)) {
    assert.equal(
      errorOf(applyTransition({
        current: unknown,
        transition,
        nowUnixSeconds: NOW,
        reservationSeconds: 60n,
        observation: observation(ReconciledOutcome.FAILED),
      })),
      ReplayError.UNKNOWN_STATE,
      transition,
    );
  }
});

test('every replay error is reachable, so none is dead security-looking surface', () => {
  const reserved = expectOk(reserve(unusedRecord(KEY, NOW), NOW, 60n));
  const quarantined = expectOk(applyTransition({ current: reserved, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: NOW + 60n }));
  const consumed = expectOk(reconcile(reserved, ReconciledOutcome.SETTLED));

  const reached = new Set<string>([
    errorOf(applyTransition({ current: { ...reserved, status: 'NOPE' as never }, transition: ReplayTransition.RESERVE, nowUnixSeconds: NOW })),
    errorOf(applyTransition({ current: reserved, transition: 'RELEASE', nowUnixSeconds: NOW })),
    errorOf(applyTransition({
      current: { ...unusedRecord(KEY, NOW), status: ReplayStatus.UNKNOWN },
      transition: ReplayTransition.RESERVE,
      nowUnixSeconds: NOW,
    })),
    errorOf(reserve(reserved)),
    errorOf(applyTransition({ current: unusedRecord(KEY, NOW), transition: ReplayTransition.QUARANTINE, nowUnixSeconds: NOW })),
    errorOf(reconcile(unusedRecord(KEY, NOW), ReconciledOutcome.FAILED)),
    errorOf(reconcile(consumed, ReconciledOutcome.FAILED)),
    errorOf(applyTransition({ current: reserved, transition: ReplayTransition.QUARANTINE, nowUnixSeconds: NOW + 1n })),
    errorOf(applyTransition({ current: quarantined, transition: ReplayTransition.RECONCILE, nowUnixSeconds: NOW + 61n })),
    errorOf(applyTransition({ current: quarantined, transition: ReplayTransition.RECONCILE, nowUnixSeconds: NOW + 61n, observation: observation('UNKNOWN') })),
  ]);
  assert.deepEqual([...Object.values(ReplayError)].filter((e) => !reached.has(e)), [], 'unreachable replay error');
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
