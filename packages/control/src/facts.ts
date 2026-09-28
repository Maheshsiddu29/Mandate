/**
 * Reservation facts: the unresolved reservations a projection must account
 * for, normalized from the ledger (brief §12, §13, §52;
 * action-state-model.md §6 `Pending(L)`).
 *
 * `Pending(L)` is every `ACTIVE` reservation of the principal, in every
 * domain, at the ledger version the decision reads. Nothing is filtered by
 * agent, root or authority: a sibling's, a cousin's or another root's pending
 * order is as real as one's own, and principal-global invariants exist
 * precisely to see across roots.
 *
 * A module never inspects the ledger. It is handed immutable facts, and only
 * those under its own exact `ModuleRef`, because only it can interpret them;
 * reservations in its domain under a *different* `ModuleRef` are reported
 * separately, so the engine can refuse to treat that module's view of its
 * domain as complete (projection is `UNKNOWN`, never optimistic).
 *
 * Every fact names its `ReservationId` and generation. A closed generation
 * `n` is not a fact at all, and a fact of generation `n` is never generation
 * `n + 1`'s (RECON-2).
 *
 * The worst case of a fact is its whole reserved contribution. Consumption
 * already recorded is carried alongside, but is not subtracted: under 7D
 * nothing is consumed through an evidence-backed path, and a consumed part
 * that the admitted snapshot does not yet reflect must still count (PROJ-1:
 * never optimistic, even at the cost of counting a fill twice until
 * reconciliation arrives).
 */

import { ok } from '@mandate/kernel';
import { moduleRefsEqual, type ModuleRef, type ReservationId } from '@mandate/core';
import type { LedgerState, ReservationRecord } from '@mandate/ledger';
import { refuse, type ControlResult } from './errors.ts';
import { MAX_RESERVATION_FACTS } from './limits.ts';
import type { ReservationFact } from './module.ts';

function factOf(r: ReservationRecord): ReservationFact {
  return {
    reservation: r.id,
    generation: r.generation,
    action: r.action,
    module: r.module,
    implementation: r.implementation,
    lineage: [...r.lineage],
    status: 'ACTIVE',
    committedAt: r.committedAt,
    effects: r.demands.map((d) => ({ quantity: d.contribution.quantity, market: d.contribution.market, account: d.contribution.account, consumed: d.consumed })),
  };
}

/** Every `ACTIVE` reservation of the principal, in `ReservationId` order. */
export function reservationFacts(state: LedgerState, path = 'ledger.reservations'): ControlResult<readonly ReservationFact[]> {
  const out: ReservationFact[] = [];
  for (const id of state.reservations.sortedKeys()) {
    const r = state.reservations.get(id) as ReservationRecord;
    if (r.status !== 'ACTIVE') continue;
    if (out.length === MAX_RESERVATION_FACTS) return refuse('RESOURCE_BOUND_EXCEEDED', 'TOO_MANY_OPEN_RESERVATIONS', path);
    out.push(factOf(r));
  }
  return ok(out);
}

/** The facts a module may interpret, and the reservations in its domain it cannot. */
export function factsFor(module: ModuleRef, facts: readonly ReservationFact[]): { readonly own: readonly ReservationFact[]; readonly foreign: readonly ReservationId[] } {
  const own: ReservationFact[] = [];
  const foreign: ReservationId[] = [];
  for (const f of facts) {
    if (moduleRefsEqual(f.module, module)) own.push(f);
    else if (f.module.domainId === module.domainId) foreign.push(f.reservation);
  }
  return { own, foreign };
}
