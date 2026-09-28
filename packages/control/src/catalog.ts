/**
 * The module catalog: which executable implementation runs for which exact
 * `ModuleRef` (DOM-2; action-state-model.md §8.1; brief §5).
 *
 * A catalog is built once from the ledger's module registry and a set of
 * implementations, each with its conformance corpus, and is then immutable.
 * It admits an implementation only if
 *
 * - its declared `ModuleRef` is exactly the registered one for its name —
 *   domain and digest included — and its `ImplementationDigest` is registered
 *   as conforming to that digest;
 * - it is structurally a `DomainModule` and passes its conformance corpus,
 *   deterministically (conformance.ts);
 * - no other loaded implementation claims the same `ModuleRef`, and no other
 *   module claims an invariant definition it claims. `core.*` invariants are
 *   Core's, never a module's;
 * - every invariant definition it claims is in its own name: the id is
 *   `<moduleId>.<name>` and the version is the module's version (7D.1). An
 *   `InvariantRef` in a grant or a policy names `(invariantId, version)`, not
 *   a digest, so this is what ties a committed term to exactly one module
 *   name — and, through the registry, to exactly one digest. A newer version,
 *   or another module, can never become the owner of a retired module's
 *   invariant and silently re-prove its history.
 *
 * Resolution is by exact `ModuleRef`. There is no "latest", no fallback to
 * another version and no silent upgrade: a reservation decided under
 * `(perp-policy, 1, digest A)` is evaluated, revalidated and closed under
 * exactly that implementation for its whole lifecycle. A module the registry
 * marks `RETIRING` may still project held and pending state and revalidate
 * existing reservations, but may not make a new decision.
 *
 * **Retired for new use is not unavailable for verification (7D.1).** A
 * `RETIRING` module still resolves for lifecycle and replay, with exactly
 * its own digest and implementation: a ledger whose delegations were proven
 * narrower by its `noWeaker` replays only while its implementation is loaded.
 * A catalog without it — or with anything else in its place — cannot prove
 * those narrowings, and replay refuses. Keeping every module a replayable
 * history depends on is the job of the production module archive, which is
 * not built here.
 *
 * The catalog also answers the ledger's `InvariantOrdering`: the parameters
 * of an invariant are ordered by the `noWeaker` of the one module that owns
 * the invariant's definition — resolved by exact ref, never by name — or by
 * Core for Core's own aggregate invariant.
 */

import { ok } from '@mandate/kernel';
import { moduleRefDigest, moduleRefsEqual, type ModuleRef, type StateInvariantTerm } from '@mandate/core';
import type { InvariantNarrowing, InvariantOrdering, ModuleRegistry, ModuleStatus, ReducerRules } from '@mandate/ledger';
import { AGGREGATE_INVARIANT_ID, AGGREGATE_INVARIANT_VERSION, compareAggregateParams } from './aggregate.ts';
import { checkConformance, type ConformanceVector } from './conformance.ts';
import { refuse, type ControlResult } from './errors.ts';
import type { DomainModule } from './module.ts';
import { callModule, checkNarrowing } from './outputs.ts';

/** Invariant ids in this namespace are defined by Core, and no module may claim one. */
export const CORE_INVARIANT_NAMESPACE = 'core.';

export interface CatalogModule {
  readonly module: DomainModule;
  /** The decision vectors its implementation must pass (action-state-model.md §8.1 `conformanceCorpus`). */
  readonly corpus: readonly ConformanceVector[];
}

interface Entry {
  readonly module: DomainModule;
  readonly status: ModuleStatus;
}

export type Evaluator = { readonly kind: 'CORE' } | { readonly kind: 'MODULE'; readonly module: ModuleRef } | { readonly kind: 'NONE' };

export interface InvariantComparison {
  readonly evaluator: Evaluator;
  readonly verdict: InvariantNarrowing;
}

function refKey(ref: ModuleRef): string {
  return moduleRefDigest(ref);
}

function invariantKey(invariantId: string, version: number): string {
  return JSON.stringify([invariantId, version]);
}

export class ModuleCatalog {
  readonly #registry: ModuleRegistry;
  readonly #entries: ReadonlyMap<string, Entry>;
  readonly #owners: ReadonlyMap<string, string>;

  private constructor(registry: ModuleRegistry, entries: ReadonlyMap<string, Entry>, owners: ReadonlyMap<string, string>) {
    this.#registry = registry;
    this.#entries = entries;
    this.#owners = owners;
  }

  static create(registry: ModuleRegistry, modules: readonly CatalogModule[]): ControlResult<ModuleCatalog> {
    const entries = new Map<string, Entry>();
    const owners = new Map<string, string>();
    for (let i = 0; i < modules.length; i += 1) {
      const path = `modules[${i}]`;
      const { module, corpus } = modules[i] as CatalogModule;
      const conforming = checkConformance(module, registry, corpus, path);
      if (!conforming.ok) return conforming;
      const key = refKey(module.ref);
      if (entries.has(key)) return refuse('MODULE_NOT_CONFORMING', 'DUPLICATE_IMPLEMENTATION', path, { module: module.ref });
      const registration = registry.lookup(module.ref.moduleId, module.ref.moduleVersion);
      if (registration === null) return refuse('MODULE_NOT_CONFORMING', 'MODULE_UNREGISTERED', path, { module: module.ref });
      for (const inv of module.invariants) {
        if (inv.invariantId.startsWith(CORE_INVARIANT_NAMESPACE)) return refuse('MODULE_NOT_CONFORMING', 'CORE_INVARIANT_CLAIMED', path, { module: module.ref });
        if (!inv.invariantId.startsWith(`${module.ref.moduleId}.`) || (inv.version as number) !== (module.ref.moduleVersion as number)) {
          return refuse('MODULE_NOT_CONFORMING', 'INVARIANT_OUTSIDE_MODULE_NAMESPACE', path, { module: module.ref });
        }
        const k = invariantKey(inv.invariantId, inv.version);
        if (owners.has(k)) return refuse('MODULE_NOT_CONFORMING', 'INVARIANT_OWNED_TWICE', path, { module: module.ref });
        owners.set(k, key);
      }
      entries.set(key, { module, status: registration.status });
    }
    return ok(new ModuleCatalog(registry, entries, owners));
  }

  #resolve(ref: ModuleRef, path: string, allowRetiring: boolean): ControlResult<DomainModule> {
    const registration = this.#registry.lookup(ref.moduleId, ref.moduleVersion);
    if (registration === null) return refuse('MODULE_NOT_FOUND', 'MODULE_UNREGISTERED', path, { module: ref });
    // Same name, another digest: a different semantic module, never a substitute (DOM-2).
    if (!moduleRefsEqual(registration.module, ref)) return refuse('MODULE_NOT_FOUND', 'MODULE_DIGEST_MISMATCH', path, { module: ref });
    if (registration.status === 'RETIRING' && !allowRetiring) return refuse('MODULE_NOT_FOUND', 'MODULE_RETIRING', path, { module: ref });
    const entry = this.#entries.get(refKey(ref));
    if (entry === undefined) return refuse('MODULE_NOT_FOUND', 'NO_CONFORMING_IMPLEMENTATION', path, { module: ref });
    // The loaded implementation declares exactly this ref and is still registered as conforming to it.
    if (!moduleRefsEqual(entry.module.ref, ref) || !registration.implementations.includes(entry.module.implementation)) {
      return refuse('MODULE_NOT_CONFORMING', 'MODULE_IMPLEMENTATION_UNREGISTERED', path, { module: ref });
    }
    return ok(entry.module);
  }

  /** The implementation for a new decision under `ref`: registered, exact, conforming, not retiring. */
  resolveForDecision(ref: ModuleRef, path = 'action.module'): ControlResult<DomainModule> {
    return this.#resolve(ref, path, false);
  }

  /** The implementation for an existing lifecycle under `ref` (projection of held or pending state, revalidation). */
  resolveForLifecycle(ref: ModuleRef, path = 'module'): ControlResult<DomainModule> {
    return this.#resolve(ref, path, true);
  }

  /** The module that defines `(invariantId, version)`, or `null`. */
  invariantOwner(invariantId: string, version: number): DomainModule | null {
    const key = this.#owners.get(invariantKey(invariantId, version));
    return key === undefined ? null : ((this.#entries.get(key) as Entry).module);
  }

  /** Every loaded implementation, in canonical order of its `ModuleRef` digest. */
  modules(): readonly DomainModule[] {
    return [...this.#entries.keys()].sort().map((k) => (this.#entries.get(k) as Entry).module);
  }

  /**
   * Whether `child`'s parameters are no weaker than `parent`'s, by the
   * definition that owns the invariant: Core's aggregate comparator, or the
   * exact owning module's `noWeaker`. `forNewDecision` additionally requires
   * the owner to be `ACTIVE`; replay does not, so retiring a module never
   * makes a committed history unreplayable.
   */
  compareInvariants(parent: StateInvariantTerm, child: StateInvariantTerm, forNewDecision = false): InvariantComparison {
    if (parent.invariantId !== child.invariantId || parent.version !== child.version) return { evaluator: { kind: 'NONE' }, verdict: 'UNPROVABLE' };
    if (parent.invariantId === AGGREGATE_INVARIANT_ID && parent.version === AGGREGATE_INVARIANT_VERSION) {
      return { evaluator: { kind: 'CORE' }, verdict: compareAggregateParams(parent, child) };
    }
    const owner = this.invariantOwner(parent.invariantId, parent.version);
    if (owner === null) return { evaluator: { kind: 'NONE' }, verdict: 'UNPROVABLE' };
    const resolved = forNewDecision ? this.resolveForDecision(owner.ref, 'invariant.owner') : this.resolveForLifecycle(owner.ref, 'invariant.owner');
    if (!resolved.ok) return { evaluator: { kind: 'MODULE', module: owner.ref }, verdict: 'UNPROVABLE' };
    const verdict = callModule(owner, 'SEMANTIC_NARROWING_UNPROVABLE', 'noWeaker', () => owner.noWeaker(parent, child));
    if (!verdict.ok) return { evaluator: { kind: 'MODULE', module: owner.ref }, verdict: 'UNPROVABLE' };
    const checked = checkNarrowing(owner, verdict.value, 'noWeaker');
    return { evaluator: { kind: 'MODULE', module: owner.ref }, verdict: checked.ok ? checked.value : 'UNPROVABLE' };
  }

  /** The ledger's `InvariantOrdering` for this catalog. */
  invariantOrdering(): InvariantOrdering {
    return { noWeaker: (parent, child) => this.compareInvariants(parent, child).verdict };
  }
}

/**
 * The reducer rules a ledger store must be configured with for delegations
 * this catalog proves narrower to be registrable — and, later, replayable.
 */
export function controlRules(catalog: ModuleCatalog): ReducerRules {
  return Object.freeze({ invariantOrdering: catalog.invariantOrdering() });
}

