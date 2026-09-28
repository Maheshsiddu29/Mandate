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
 *
 * **Committed provenance (7D.2).** That identity is no longer only evidence
 * returned to the caller: the registration event commits it, as a ledger
 * `SemanticProofRef` per restated invariant (`semanticProofRefs`). The
 * reducer re-proves each narrowing under exactly that definition at commit
 * and at replay, so a history is bound to the semantics that accepted it
 * and never to whatever a registry later maps the module's name to.
 *
 * **Bound terms (7D.3).** A comparator orders two parameters only if both
 * mean the same thing: the parent term's committed binding and the child
 * term's binding must be one definition, and the proof is made under exactly
 * it. If they differ, no comparator is asked at all — the restatement is
 * refused by the ledger as `SEMANTIC_BINDING_MISMATCH`.
 */

import { policyInvariants, termKey, type AuthorityGrant, type InvariantId, type InvariantVersion, type PrincipalPolicy, type StateInvariantTerm } from '@mandate/core';
import {
  bindingOf,
  canonicalProofs,
  restatedInvariants,
  sameDefinition,
  type InvariantNarrowing,
  type LedgerState,
  type SemanticInvariantRef,
  type SemanticProofRef,
  type SemanticTermBinding,
} from '@mandate/ledger';
import type { Evaluator, ModuleCatalog } from './catalog.ts';

export interface NarrowingProof {
  /** Core's `termKey`: the restated invariant's identity, scope included. */
  readonly term: string;
  readonly invariantId: InvariantId;
  readonly version: InvariantVersion;
  readonly parentParams: string;
  readonly childParams: string;
  readonly evaluator: Evaluator;
  /** The exact definition the proof was made under, or `null` if no definition could be found. */
  readonly definition: SemanticInvariantRef | null;
  readonly verdict: InvariantNarrowing;
}

/** The committed bindings of the two sides of a restatement (7D.3). */
export interface RestatementBindings {
  readonly parent: readonly SemanticTermBinding[];
  readonly child: readonly SemanticTermBinding[];
}

/**
 * A proof for every invariant the child restates with different parameters,
 * by the owning definition, for a *new* registration (the owner must be
 * active, not retiring). Exact restatements need no proof. With `bindings`,
 * a module-defined term is ordered only when the parent's and the child's
 * bindings are one definition — the one the proof is then made under;
 * otherwise nothing is asked and the proof is `UNPROVABLE` with no definition.
 */
export function narrowingProofs(parent: AuthorityGrant, child: AuthorityGrant, catalog: ModuleCatalog, bindings?: RestatementBindings): readonly NarrowingProof[] {
  const parents = new Map<string, StateInvariantTerm>();
  for (const t of parent.terms) if (t.kind === 'STATE_INVARIANT') parents.set(termKey(t), t);
  const out: NarrowingProof[] = [];
  for (const c of child.terms) {
    if (c.kind !== 'STATE_INVARIANT') continue;
    const key = termKey(c);
    const p = parents.get(key);
    if (p === undefined || p.params === c.params) continue;
    const definition = bindings === undefined ? catalog.definitionFor(c.invariantId, c.version) : boundDefinition(p, c, bindings, catalog);
    const comparison = definition === null ? { evaluator: { kind: 'NONE' } as const, verdict: 'UNPROVABLE' as const } : catalog.compareInvariants(p, c, definition, true);
    out.push({ term: key, invariantId: c.invariantId, version: c.version, parentParams: p.params, childParams: c.params, evaluator: comparison.evaluator, definition, verdict: comparison.verdict });
  }
  return out;
}

/** The one definition both sides of a restatement are bound to, Core's for a Core term, or `null` if they differ. */
function boundDefinition(parent: StateInvariantTerm, child: StateInvariantTerm, bindings: RestatementBindings, catalog: ModuleCatalog): SemanticInvariantRef | null {
  const p = bindingOf(bindings.parent, parent);
  const c = bindingOf(bindings.child, child);
  if (p === null && c === null) return catalog.definitionFor(child.invariantId, child.version);
  return p !== null && c !== null && sameDefinition(p.definition, c.definition) ? c.definition : null;
}

/**
 * A proof for every principal-global invariant a policy update restates with
 * different parameters once activity exists (7D.1), ordered the other way:
 * the old parameters must be no weaker than the new. Before any activity, or
 * for a first policy, nothing needs proving.
 */
export function policyProofs(state: LedgerState, policy: PrincipalPolicy, catalog: ModuleCatalog, bindings?: readonly SemanticTermBinding[]): readonly NarrowingProof[] {
  if (state.policy === null || !state.everReserved) return [];
  const previous = policyInvariants(state.policy.policy);
  const before = new Map(previous.map((t) => [termKey(t), t]));
  const committed = state.policy.bindings;
  return restatedInvariants(previous, policyInvariants(policy)).map((t) => {
    const old = before.get(termKey(t)) as StateInvariantTerm;
    // With the new policy's bindings, ordered only under the one definition both sides mean (7D.3).
    const definition = bindings === undefined ? catalog.definitionFor(t.invariantId, t.version) : boundDefinition(old, t, { parent: committed, child: bindings }, catalog);
    const comparison = definition === null ? { evaluator: { kind: 'NONE' } as const, verdict: 'UNPROVABLE' as const } : catalog.compareInvariants(t, old, definition, true);
    return { term: termKey(t), invariantId: t.invariantId, version: t.version, parentParams: t.params, childParams: old.params, evaluator: comparison.evaluator, definition, verdict: comparison.verdict };
  });
}

/** What a registration commits: one `SemanticProofRef` per proof with a definition, in canonical order. */
export function semanticProofRefs(proofs: readonly NarrowingProof[], terms: readonly StateInvariantTerm[]): SemanticProofRef[] {
  const byKey = new Map(terms.map((t) => [termKey(t), t]));
  const refs: SemanticProofRef[] = [];
  for (const p of proofs) {
    const t = byKey.get(p.term);
    if (p.definition !== null && t !== undefined) refs.push({ definition: p.definition, scope: t.scope });
  }
  return canonicalProofs(refs);
}
