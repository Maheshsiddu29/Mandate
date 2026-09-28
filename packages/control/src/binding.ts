/**
 * Semantic term bindings for new authority (Phase 7D.3; SEMANTIC-AUTH-1…3).
 *
 * A grant's or policy's module-defined invariant names `(invariantId,
 * version)` — a human-readable name, not a security identity. What the term
 * *means* is the exact definition that owns it: a `ModuleRef` with its
 * digest. This file derives, for a grant or policy being registered, one
 * ledger `SemanticTermBinding` per module-defined term:
 *
 * ```text
 * term (invariantId, version, scope) → catalog.bindingFor → current, active, conforming owner
 *                                    → SemanticTermBinding { definition: exact ModuleRef + id + version, scope }
 * ```
 *
 * The registration event commits the bindings; from then on the term is
 * evaluated under exactly that definition (pipeline.ts `committedSemantics`)
 * and never under whatever module the name maps to later.
 *
 * **Which terms are bound.**
 *
 * | term                                  | bound? | why |
 * | ------------------------------------- | ------ | --- |
 * | `STATE_INVARIANT` outside `core.*`    | yes    | interpretation, evaluation, state requirements and ordering are a module's |
 * | `STATE_INVARIANT` in `core.*`         | no     | Core's own definition (the aggregate), fixed by Core's version; nothing else may claim `core.*` |
 * | `STATE_POLICY`                        | no     | Core-typed sources and `StateRequirement`, compared and enforced by Core's admission |
 * | `BOUND`                               | no     | Core-typed value compared by Core; the action's parameter is read by the acting module, which is named by exact `ModuleRef` in the action and the `MODULES` set |
 * | `SET`, `RIGHT`, `TIME_WINDOW`, `LEDGER_DIMENSION`, validity | no | Core semantics throughout; `MODULES` members are already exact `ModuleRef`s |
 *
 * **Trust boundary.** Nothing here takes a binding, a proof or a verdict
 * from a caller: the catalog derives the binding from the implementations it
 * admitted, and the ledger's reducer re-checks its structure at commit and
 * at every replay.
 */

import { ok } from '@mandate/kernel';
import type { StateInvariantTerm } from '@mandate/core';
import { canonicalBindings, type SemanticTermBinding } from '@mandate/ledger';
import type { ModuleCatalog } from './catalog.ts';
import type { ControlResult } from './errors.ts';

/** The binding of every module-defined term in `terms`, in canonical order, or why one cannot be bound. */
export function termBindings(terms: readonly StateInvariantTerm[], catalog: ModuleCatalog, path: string): ControlResult<readonly SemanticTermBinding[]> {
  const out: SemanticTermBinding[] = [];
  for (let i = 0; i < terms.length; i += 1) {
    const t = terms[i] as StateInvariantTerm;
    const definition = catalog.bindingFor(t.invariantId, t.version, `${path}.invariant[${i}]`);
    if (!definition.ok) return definition;
    if (definition.value !== null) out.push({ definition: definition.value, scope: t.scope });
  }
  return ok(canonicalBindings(out));
}
