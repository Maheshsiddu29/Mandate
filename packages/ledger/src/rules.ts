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
 *
 * **Exact semantics (7D.2).** A registration that needs a proof commits, in
 * its event, *whose* definition decided it — a `SemanticProofRef` naming the
 * exact `ModuleRef` (or Core) and the definition (semantic.ts). The reducer
 * asks the ordering under exactly that definition. An ordering must resolve
 * it by exact content identity — never by a module name through whatever
 * digest a registry maps it to today — and answer `UNPROVABLE` when that
 * artifact is unavailable, so a history whose semantics are gone refuses to
 * replay instead of being re-proved by a substitute.
 */

import type { StateInvariantTerm } from '@mandate/core';
import { proofMatches, type SemanticInvariantRef, type SemanticProofRef } from './semantic.ts';

/**
 * `NO_WEAKER`: every state satisfying the child's parameters satisfies the
 * parent's. `WEAKER`: provably not. `UNPROVABLE`: the definition cannot order
 * the two (different measures, unknown invariant, a comparator that failed).
 */
export type InvariantNarrowing = 'NO_WEAKER' | 'WEAKER' | 'UNPROVABLE';

export interface InvariantOrdering {
  /**
   * Called only for a child term restating a parent term with the same
   * `(invariantId, version, scope)` and different parameters, under the
   * exact definition the registration committed. Must be pure and
   * deterministic; a throw is read as `UNPROVABLE`.
   */
  noWeaker(parent: StateInvariantTerm, child: StateInvariantTerm, definition: SemanticInvariantRef): InvariantNarrowing;
}

/** One registration's narrowing decisions: the configured ordering, bound to the proofs its event committed. */
export type NarrowingProver = (parent: StateInvariantTerm, child: StateInvariantTerm) => InvariantNarrowing;

export interface ReducerRules {
  readonly invariantOrdering: InvariantOrdering | null;
}

/** The 7C rules: invariant parameters are accepted only when restated byte-identically. */
export const CORE_RULES: ReducerRules = Object.freeze({ invariantOrdering: null });

/** Ask the ordering under one definition, reading any failure as "cannot prove" — never as a pass. */
export function orderInvariants(ordering: InvariantOrdering | null, parent: StateInvariantTerm, child: StateInvariantTerm, definition: SemanticInvariantRef): InvariantNarrowing {
  if (ordering === null) return 'UNPROVABLE';
  try {
    const v = ordering.noWeaker(parent, child, definition);
    return v === 'NO_WEAKER' || v === 'WEAKER' ? v : 'UNPROVABLE';
  } catch {
    return 'UNPROVABLE';
  }
}

/**
 * The prover for one registration: a term is ordered only under the
 * definition its committed proof names (matched on `child`'s identity); a
 * term with no committed proof is `UNPROVABLE`. Which terms need a proof,
 * and that no proof is spurious, is checked by the reducer (`checkProofSet`).
 */
export function committedProver(ordering: InvariantOrdering | null, proofs: readonly SemanticProofRef[]): NarrowingProver {
  return (parent, child) => {
    const p = proofs.find((x) => proofMatches(x, child));
    return p === undefined ? 'UNPROVABLE' : orderInvariants(ordering, parent, child, p.definition);
  };
}
