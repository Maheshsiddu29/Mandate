/**
 * Reducer-level helpers: fold batches over a state directly, with no store,
 * and read balances. Tests of ledger semantics use these, so what they check
 * is the transition rules themselves.
 */

import assert from 'node:assert/strict';
import { authorityId, type AuthorityGrant, type LedgerDimensionInput, type PrincipalId, type PrincipalPolicy, type ReservationId } from '@mandate/core';
import type { ChargePlan } from '../../src/charge-plan.ts';
import type { LedgerRefusal } from '../../src/errors.ts';
import type { AccountingEvent, LedgerEvent } from '../../src/events.ts';
import { applyBatch, deriveReserveEvent } from '../../src/reducer.ts';
import { availableOf, emptyLedgerState, nodeTargetKey, policyDimensionIdentity, policyTargetKey, type LedgerState, type ReservationRecord, type TargetBalance } from '../../src/state.ts';
import { PRINCIPAL, T0, evidence, must, policy } from './grants.ts';

export function genesis(principal: PrincipalId = PRINCIPAL): LedgerState {
  return { ...emptyLedgerState(principal) };
}

/** Apply one batch; it must commit. */
export function step(s: LedgerState, events: readonly LedgerEvent[]): LedgerState {
  const r = applyBatch(s, events);
  if (!r.ok) assert.fail(`expected the batch to apply, got ${r.error.code} at ${r.error.path}`);
  return r.value.state;
}

/** Apply one batch; it must be refused, and the state it was applied to is untouched by construction. */
export function stepRefused(s: LedgerState, events: readonly LedgerEvent[]): LedgerRefusal {
  const r = applyBatch(s, events);
  if (r.ok) assert.fail('expected the batch to be refused');
  return r.error;
}

export function bootstrap(p: PrincipalPolicy, grants: readonly AuthorityGrant[], at: bigint = T0, principal: PrincipalId = PRINCIPAL): LedgerState {
  let s = step(genesis(principal), [{ kind: 'REGISTER_POLICY', at, policy: p }]);
  for (const g of grants) s = step(s, [{ kind: 'REGISTER_GRANT', at, grant: g }]);
  return s;
}

export function reserveEvent(s: LedgerState, plan: ChargePlan, at: bigint = T0): LedgerEvent {
  return must(deriveReserveEvent(s, plan, at));
}

export function reserve(s: LedgerState, plan: ChargePlan, at: bigint = T0): LedgerState {
  return step(s, [reserveEvent(s, plan, at)]);
}

export function reserveRefused(s: LedgerState, plan: ChargePlan, at: bigint = T0): LedgerRefusal {
  const e = deriveReserveEvent(s, plan, at);
  if (!e.ok) return e.error;
  return stepRefused(s, [e.value]);
}

export function reservationOf(s: LedgerState, id: ReservationId): ReservationRecord {
  const r = s.reservations.get(id);
  assert.ok(r !== undefined, 'no such reservation');
  return r;
}

export function consumeEvent(r: ReservationRecord, amounts: readonly bigint[], at: bigint = T0, label = 'fill'): AccountingEvent<'CONSUME'> {
  return { kind: 'CONSUME', at, reservation: r.id, generation: r.generation, evidence: evidence(label), amounts };
}

export function closeEvent(r: ReservationRecord, at: bigint = T0, label = 'final'): AccountingEvent<'CLOSE'> {
  return { kind: 'CLOSE', at, reservation: r.id, generation: r.generation, evidence: evidence(label), amounts: r.demands.map((d) => d.reserved - d.consumed) };
}

export function restoreEvent(r: ReservationRecord, amounts: readonly bigint[], at: bigint = T0, label = 'unwind'): AccountingEvent<'RESTORE'> {
  return { kind: 'RESTORE', at, reservation: r.id, generation: r.generation, evidence: evidence(label), amounts };
}

export function nodeBalance(s: LedgerState, g: AuthorityGrant, dimensionId: string): TargetBalance {
  const b = s.targets.get(nodeTargetKey(authorityId(g), dimensionId));
  assert.ok(b !== undefined, `no target ${dimensionId}`);
  return b;
}

export function policyBalance(s: LedgerState, d: LedgerDimensionInput): TargetBalance {
  const term = policy([d]).terms[0];
  assert.ok(term !== undefined && term.kind === 'LEDGER_DIMENSION');
  const b = s.targets.get(policyTargetKey(policyDimensionIdentity(term)));
  assert.ok(b !== undefined, `no policy target ${d.dimensionId}`);
  return b;
}

export function available(b: TargetBalance, at: bigint = T0): bigint {
  return availableOf(b, at);
}

/** `[reserved, consumed, restored, available]` of a target: one assertion shows the whole balance. */
export function figures(b: TargetBalance, at: bigint = T0): [bigint, bigint, bigint, bigint] {
  return [b.reserved, b.consumed, b.restored, availableOf(b, at)];
}
