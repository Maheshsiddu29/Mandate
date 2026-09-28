/**
 * Reservation, authorization, execution-binding and receipt references
 * (reservations-reconciliation.md §3–4, receipts-provenance.md §3). Structural
 * only: there is no reservation lifecycle here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_LINEAGE_LENGTH,
  ZERO_DIGEST,
  checkBindingMatchesAuthorization,
  executionAuthorizationId,
  executionBindingId,
  reservationIdFor,
  reservationIdOf,
  reservationRefDigest,
  stateBindingIdsOf,
  validateExecutionAuthorization,
  validateExecutionBindingRef,
  validateReceiptHeader,
  validateReceiptReferences,
  validateReservationRef,
  type ActionId,
  type CoreResult,
  type ExecutionBindingRefInput,
  type ReceiptHeaderInput,
  type ReceiptReferencesInput,
  type ReservationGeneration,
  type ReservationRefInput,
  type StateBindingInput,
} from '../src/index.ts';
import { BTC_PERP_L, PERP_V1, PERP_V1_IMPL, PERP_V2, PRINCIPAL, VENUE_SIGNER_L, VENUE_SIGNER_M, digestOf, must } from './support/basics.ts';

function code<T>(r: CoreResult<T>): string {
  return r.ok ? 'OK' : r.error.code;
}

const ACTION = digestOf('action:o1');
const LINEAGE = [digestOf('node:leaf'), digestOf('node:parent'), digestOf('node:root')];

const RESERVATION: ReservationRefInput = {
  action: ACTION,
  generation: 1n,
  principal: PRINCIPAL,
  lineage: LINEAGE,
  policy: digestOf('policy:1'),
  module: PERP_V1,
  implementation: PERP_V1_IMPL,
  adapter: VENUE_SIGNER_L,
  ledgerVersion: 58n,
};

const BINDING: StateBindingInput = {
  stateKind: 'perp.markPrice',
  subject: BTC_PERP_L,
  sourceId: 'venue-l-api',
  trustClass: 'VERIFIED',
  sequence: { kind: 'VENUE_SEQUENCE', value: 1_040n },
  observedAt: 1_000n,
  validUntil: null,
  finality: { ladder: 'venue-l.market-data', level: 'PUBLISHED' },
  stateDigest: digestOf('state:mark'),
  requirement: {
    freshness: { kind: 'AGE', maxAgeSeconds: 5n },
    minTrust: 'VERIFIED',
    minFinality: { ladder: 'venue-l.market-data', level: 'PUBLISHED' },
    atIssue: 'RECHECK',
    atExecution: { kind: 'ENFORCED_BY_ARTIFACT', field: 'limitPrice' },
  },
};

describe('reservation generation', () => {
  it('is part of the reservation\'s identity: two generations of one intent are two reservations', () => {
    const g1 = reservationIdFor(ACTION as ActionId, 1n as ReservationGeneration);
    const g2 = reservationIdFor(ACTION as ActionId, 2n as ReservationGeneration);
    assert.notEqual(g1, g2);
    assert.notEqual(reservationRefDigest(must(validateReservationRef(RESERVATION))), reservationRefDigest(must(validateReservationRef({ ...RESERVATION, generation: 2n }))));
  });

  it('is explicit and at least 1: generation 0 is an intent before any reservation', () => {
    assert.deepEqual(validateReservationRef({ ...RESERVATION, generation: 0n }), { ok: false, error: { code: 'GENERATION_ZERO', path: 'reservation.generation' } });
    const { generation: _g, ...noGeneration } = RESERVATION;
    assert.deepEqual(validateReservationRef(noGeneration as ReservationRefInput), { ok: false, error: { code: 'MISSING_FIELD', path: 'reservation.generation' } });
    assert.equal(code(validateReservationRef({ ...RESERVATION, generation: 2n ** 64n })), 'INTEGER_OUT_OF_RANGE');
  });

  it('derives the reservation id from the ref, never accepting one', () => {
    const r = must(validateReservationRef(RESERVATION));
    assert.equal(reservationIdOf(r), reservationIdFor(r.action, r.generation));
  });
});

describe('ReservationRef', () => {
  it('names a bounded, non-repeating lineage, leaf to root', () => {
    assert.equal(code(validateReservationRef({ ...RESERVATION, lineage: [] })), 'COLLECTION_EMPTY');
    assert.equal(code(validateReservationRef({ ...RESERVATION, lineage: [LINEAGE[0] as string, LINEAGE[0] as string] })), 'LINEAGE_REPEATS_NODE');
    const tooLong = Array.from({ length: MAX_LINEAGE_LENGTH + 1 }, (_, i) => digestOf(`node:${i}`));
    assert.equal(code(validateReservationRef({ ...RESERVATION, lineage: tooLong })), 'COLLECTION_TOO_LARGE');
  });

  it('lineage order is meaningful: reversing it is a different reservation', () => {
    const reversed = must(validateReservationRef({ ...RESERVATION, lineage: [...LINEAGE].reverse() }));
    assert.notEqual(reservationRefDigest(reversed), reservationRefDigest(must(validateReservationRef(RESERVATION))));
  });

  it('binds the conforming implementation, and refuses a placeholder', () => {
    assert.equal(code(validateReservationRef({ ...RESERVATION, implementation: ZERO_DIGEST })), 'ZERO_DIGEST');
    assert.notEqual(
      reservationRefDigest(must(validateReservationRef(RESERVATION))),
      reservationRefDigest(must(validateReservationRef({ ...RESERVATION, implementation: digestOf('implementation:perp-policy:1:patched') }))),
    );
  });
});

describe('ExecutionAuthorization and ExecutionBindingRef', () => {
  const authorization = must(validateExecutionAuthorization({ reservation: RESERVATION, stateBindings: [BINDING], attemptCeiling: 1_200n }));
  const authorizationId = executionAuthorizationId(authorization);
  const bindingInput: ExecutionBindingRefInput = {
    authorization: authorizationId,
    action: ACTION,
    generation: 1n,
    module: PERP_V1,
    adapter: VENUE_SIGNER_L,
    stateBindings: [...stateBindingIdsOf(authorization)],
    parameters: digestOf('venue-order-parameters'),
  };

  it('the authorization commits to the state bindings it relied on', () => {
    const withoutState = must(validateExecutionAuthorization({ reservation: RESERVATION, stateBindings: [], attemptCeiling: 1_200n }));
    assert.notEqual(executionAuthorizationId(withoutState), authorizationId);
    assert.equal(code(validateExecutionAuthorization({ reservation: RESERVATION, stateBindings: [BINDING, BINDING], attemptCeiling: 1_200n })), 'DUPLICATE_SET_MEMBER');
  });

  it('a binding that restates its authorization matches it', () => {
    const binding = must(validateExecutionBindingRef(bindingInput));
    assert.equal(code(checkBindingMatchesAuthorization(binding, authorization)), 'OK');
  });

  it('a binding naming a stale generation, another module, another adapter or another authorization does not', () => {
    const cases: [string, Partial<ExecutionBindingRefInput>][] = [
      ['generation', { generation: 2n }],
      ['module', { module: PERP_V2 }],
      ['module', { module: { ...PERP_V1, moduleDigest: digestOf('manifest:perp-policy:1:other') } }],
      ['adapter', { adapter: VENUE_SIGNER_M }],
      ['action', { action: digestOf('action:other') }],
      ['authorization', { authorization: digestOf('authorization:other') }],
    ];
    for (const [field, change] of cases) {
      const binding = must(validateExecutionBindingRef({ ...bindingInput, ...change }));
      assert.deepEqual(checkBindingMatchesAuthorization(binding, authorization), {
        ok: false,
        error: { code: 'EXECUTION_BINDING_INCONSISTENT', path: `executionBinding.${field}` },
      });
    }
  });

  it('a revalidated state set is carried by the binding and still matches: REVALIDATE replaces bindings (7D checks which)', () => {
    const binding = must(validateExecutionBindingRef({ ...bindingInput, stateBindings: [digestOf('binding:revalidated')] }));
    assert.equal(code(checkBindingMatchesAuthorization(binding, authorization)), 'OK');
    assert.notEqual(executionBindingId(binding), executionBindingId(must(validateExecutionBindingRef(bindingInput))));
  });

  it('the execution parameters are bound by digest', () => {
    assert.notEqual(
      executionBindingId(must(validateExecutionBindingRef(bindingInput))),
      executionBindingId(must(validateExecutionBindingRef({ ...bindingInput, parameters: digestOf('venue-order-parameters:mutated') }))),
    );
    assert.equal(code(validateExecutionBindingRef({ ...bindingInput, generation: 0n })), 'GENERATION_ZERO');
  });
});

describe('receipt header and references', () => {
  const header: ReceiptHeaderInput = {
    kind: 'DECISION',
    coreVersion: 'mandate-core-1',
    principal: PRINCIPAL,
    ledgerBefore: { version: 57n, headDigest: digestOf('ledger:57') },
    ledgerAfter: { version: 58n, headDigest: digestOf('ledger:58') },
    previousReceipt: null,
    evaluatedAt: 1_001n,
  };

  it('a write advances the ledger version; a decision that wrote nothing has no after-state', () => {
    assert.equal(code(validateReceiptHeader(header)), 'OK');
    assert.equal(code(validateReceiptHeader({ ...header, ledgerAfter: null })), 'OK');
    assert.equal(code(validateReceiptHeader({ ...header, ledgerAfter: { version: 57n, headDigest: digestOf('ledger:57b') } })), 'LEDGER_VERSION_NOT_ADVANCED');
    assert.equal(code(validateReceiptHeader({ ...header, kind: 'ADJUST' as never })), 'UNKNOWN_ENUM_VALUE');
  });

  const references: ReceiptReferencesInput = {
    lineage: LINEAGE,
    policy: digestOf('policy:1'),
    action: ACTION,
    module: PERP_V1,
    implementation: PERP_V1_IMPL,
    adapter: VENUE_SIGNER_L,
    stateBindings: [digestOf('binding:1')],
    reservation: { reservationId: reservationIdFor(ACTION as ActionId, 1n as ReservationGeneration), generation: 1n },
    executionBinding: digestOf('binding-digest'),
    observation: digestOf('observation:1'),
  };

  it('name every lifecycle object by digest, and the reservation by (id, generation) consistent with the action', () => {
    assert.equal(code(validateReceiptReferences(references)), 'OK');
    assert.equal(code(validateReceiptReferences({ ...references, reservation: null, executionBinding: null, observation: null })), 'OK');
    assert.deepEqual(validateReceiptReferences({ ...references, reservation: { ...references.reservation, generation: 2n } as never }), {
      ok: false,
      error: { code: 'RESERVATION_ID_MISMATCH', path: 'references.reservation.reservationId' },
    });
    assert.equal(code(validateReceiptReferences({ ...references, reservation: { reservationId: digestOf('x'), generation: 0n } })), 'GENERATION_ZERO');
  });
});
