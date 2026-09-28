/**
 * Reducer configuration: the one extension point Phase 7D adds to the ledger.
 *
 * Phase 7C refused any delegation that restated a parent's state invariant
 * with different parameters (`DELEGATION_NARROWING_UNPROVEN`), because an
 * invariant's parameters are opaque module bytes and only the invariant's
 * definition can say whether a child's are no weaker (authority-model.md §4,
 * implementation-7c.md §14 item 2). Phase 7D supplies that definition's
 * `noWeaker` through an `InvariantOrdering`.
 *
 * **Trust boundary.** The ordering is configuration of the reducer — given to
 * the store and the engine by whoever constructs them — and never an input of
 * a registration, an event or any other call. No event carries a verdict, so
 * nothing an agent submits can assert "this child is narrower": the reducer
 * asks the configured ordering at commit, and again at every replay. A
 * history that relied on a semantic proof therefore replays only under an
 * ordering that still proves it; replayed without one, it refuses (fail
 * closed) instead of silently accepting the grant.
 *
 * With no ordering (`CORE_RULES`) the ledger behaves exactly as in 7C.
 */

import type { StateInvariantTerm } from '@mandate/core';

/**
 * `NO_WEAKER`: every state satisfying the child's parameters satisfies the
 * parent's. `WEAKER`: provably not. `UNPROVABLE`: the definition cannot order
 * the two (different measures, unknown invariant, a comparator that failed).
 */
export type InvariantNarrowing = 'NO_WEAKER' | 'WEAKER' | 'UNPROVABLE';

export interface InvariantOrdering {
  /**
   * Called only for a child term restating a parent term with the same
   * `(invariantId, version, scope)` and different parameters. Must be pure
   * and deterministic; a throw is read as `UNPROVABLE`.
   */
  noWeaker(parent: StateInvariantTerm, child: StateInvariantTerm): InvariantNarrowing;
}

export interface ReducerRules {
  readonly invariantOrdering: InvariantOrdering | null;
}

/** The 7C rules: invariant parameters are accepted only when restated byte-identically. */
export const CORE_RULES: ReducerRules = Object.freeze({ invariantOrdering: null });

/** Ask the ordering, reading any failure as "cannot prove" — never as a pass. */
export function orderInvariants(ordering: InvariantOrdering | null, parent: StateInvariantTerm, child: StateInvariantTerm): InvariantNarrowing {
  if (ordering === null) return 'UNPROVABLE';
  try {
    const v = ordering.noWeaker(parent, child);
    return v === 'NO_WEAKER' || v === 'WEAKER' ? v : 'UNPROVABLE';
  } catch {
    return 'UNPROVABLE';
  }
}
