/**
 * Semantic delegation narrowing (AUTH-2; authority-model.md §4 "parameters
 * no weaker"; brief §17–§19).
 *
 * 7C refused any child that restated a parent's invariant with different
 * parameters, because Core cannot read them. 7D proves the ordering with the
 * invariant definition's own `noWeaker`:
 *
 * ```text
 * parent: synth.account-leverage ≤ 4x      child: ≤ 3x   → NO_WEAKER  (registered)
 * parent: synth.account-leverage ≤ 4x      child: ≤ 5x   → WEAKER     (DELEGATION_WEAKENS_INVARIANT)
 * parent: opaque invariant A               child: B      → UNPROVABLE (SEMANTIC_NARROWING_UNPROVABLE)
 * ```
 *
 * **Trust boundary.** No caller supplies a verdict. There is no
 * `{ semanticSubset: true }` anywhere: the proof is computed here by the
 * catalog, which resolves the one module that owns the invariant definition
 * by exact `ModuleRef` (digest included) and calls its comparator, or uses
 * Core's comparator for Core's aggregate. The ledger then re-derives the
 * same verdict at commit, and at every replay, from the ordering its store is
 * configured with (`controlRules(catalog)`); nothing in the registration or
 * its event carries the verdict. A catalog with a different digest for the
 * owning module is a different ordering, resolved afresh, never a cached
 * answer.
 *
 * A proof records whose semantics produced it — Core, or the exact
 * `ModuleRef` — so the registration's evidence names the comparator.
 */

import { termKey, type AuthorityGrant, type InvariantId, type InvariantVersion, type StateInvariantTerm } from '@mandate/core';
import type { InvariantNarrowing } from '@mandate/ledger';
import type { Evaluator, ModuleCatalog } from './catalog.ts';

export interface NarrowingProof {
  /** Core's `termKey`: the restated invariant's identity, scope included. */
  readonly term: string;
  readonly invariantId: InvariantId;
  readonly version: InvariantVersion;
  readonly parentParams: string;
  readonly childParams: string;
  readonly evaluator: Evaluator;
  readonly verdict: InvariantNarrowing;
}

/**
 * A proof for every invariant the child restates with different parameters,
 * by the owning definition, for a *new* registration (the owner must be
 * active, not retiring). Exact restatements need no proof.
 */
export function narrowingProofs(parent: AuthorityGrant, child: AuthorityGrant, catalog: ModuleCatalog): readonly NarrowingProof[] {
  const parents = new Map<string, StateInvariantTerm>();
  for (const t of parent.terms) if (t.kind === 'STATE_INVARIANT') parents.set(termKey(t), t);
  const out: NarrowingProof[] = [];
  for (const c of child.terms) {
    if (c.kind !== 'STATE_INVARIANT') continue;
    const key = termKey(c);
    const p = parents.get(key);
    if (p === undefined || p.params === c.params) continue;
    const comparison = catalog.compareInvariants(p, c, true);
    out.push({ term: key, invariantId: c.invariantId, version: c.version, parentParams: p.params, childParams: c.params, evaluator: comparison.evaluator, verdict: comparison.verdict });
  }
  return out;
}
