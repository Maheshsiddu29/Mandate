/**
 * The authority ledger engine: decide against one snapshot, commit by
 * compare-and-swap at that snapshot's version (CONC-1;
 * authority-ledger.md §9; architecture.md §6).
 *
 * Every operation runs the same loop, bounded by the caller's retry policy:
 *
 * ```text
 * 1. read the principal's snapshot at version V
 * 2. plan against it: resolve the lineage, check validity, derive the full
 *    charging path, compute every projected balance — all from V
 * 3. refuse, writing nothing, if any rule or capacity fails
 * 4. compareAndAppend(V, head(V), batch)
 * 5. on a conflict: go to 1 — the plan is recomputed from the new snapshot;
 *    nothing computed from V is reused
 * ```
 *
 * The engine never loops unboundedly: after `maxAttempts` conflicts it
 * returns `CONFLICT` and the caller decides. It holds no state of its own, so
 * any number of engines may share a store.
 *
 * Module conformance is checked here, at decision time, against the
 * registry. The ledger's own rules are checked twice: here, to refuse before
 * writing, and by the store's reducer at commit, against the state actually
 * committed to.
 *
 * **Infrastructure boundary (7D.3).** `registerGrant` and `registerPolicy`
 * accept already-derived semantics — the bindings and proofs a registration
 * commits — and check only that every module they name is the registry's
 * current, active one. They do not derive semantics, and they are not an
 * agent's surface: the control engine derives both from the exact module
 * implementations and never takes them from its caller.
 */

import type { LedgerVersion, ObservationId, PrincipalId, ReservationGeneration, ReservationId, AuthorityGrant, PrincipalPolicy } from '@mandate/core';
import type { ChargePlan } from './charge-plan.ts';
import { withPath, type LedgerRefusal, type LedgerResult } from './errors.ts';
import type { LedgerEvent } from './events.ts';
import { MAX_COMMIT_ATTEMPTS } from './limits.ts';
import { applyBatch, applyEvent, deriveReserveEvent } from './reducer.ts';
import { checkBindingOwnersCurrent, checkModuleConformance, checkProofOwnersCurrent, type ModuleRegistry } from './registry.ts';
import type { SemanticProofRef, SemanticTermBinding } from './semantic.ts';
import type { Revocation } from './revocation.ts';
import type { DemandRecord } from './state.ts';
import type { LedgerSnapshot, LedgerStore } from './store.ts';
import { CORE_RULES, type ReducerRules } from './rules.ts';

export interface RetryPolicy {
  /** Commit attempts, 1..`MAX_COMMIT_ATTEMPTS`. There is no default: the caller chooses how long to contend. */
  readonly maxAttempts: number;
}

export type LedgerOutcome =
  | { readonly status: 'COMMITTED'; readonly snapshot: LedgerSnapshot; readonly attempts: number }
  | { readonly status: 'REFUSED'; readonly refusal: LedgerRefusal; readonly attempts: number; readonly version: LedgerVersion }
  /** Every attempt lost a compare-and-swap race. Nothing was written. */
  | { readonly status: 'CONFLICT'; readonly attempts: number };

/** A reconciliation effect to fold (7D decides when one is legal; see events.ts). */
export type AccountingEffect =
  | { readonly kind: 'CONSUME'; readonly reservation: ReservationId; readonly generation: ReservationGeneration; readonly evidence: ObservationId; readonly amounts: readonly bigint[] }
  /** Releases exactly what remains reserved; the amounts are derived, never supplied. */
  | { readonly kind: 'CLOSE'; readonly reservation: ReservationId; readonly generation: ReservationGeneration; readonly evidence: ObservationId }
  | { readonly kind: 'RESTORE'; readonly reservation: ReservationId; readonly generation: ReservationGeneration; readonly evidence: ObservationId; readonly amounts: readonly bigint[] };

type Planner = (snapshot: LedgerSnapshot) => LedgerResult<readonly LedgerEvent[]>;

/** Already-derived semantics a registration commits (infrastructure input; see the module comment). */
export interface RegistrationSemantics {
  /** The exact definition each module-defined term is bound to (7D.3). */
  readonly bindings?: readonly SemanticTermBinding[];
  /** The exact definition that proved each restated invariant (7D.2). */
  readonly proofs?: readonly SemanticProofRef[];
}

function registrationSemantics(registry: ModuleRegistry, semantics: RegistrationSemantics): LedgerResult<{ bindings?: readonly SemanticTermBinding[]; proofs?: readonly SemanticProofRef[] }> {
  const bindings = semantics.bindings ?? [];
  const proofs = semantics.proofs ?? [];
  const bound = checkBindingOwnersCurrent(registry, bindings);
  if (!bound.ok) return bound;
  const proven = checkProofOwnersCurrent(registry, proofs);
  if (!proven.ok) return proven;
  return { ok: true, value: { ...(bindings.length > 0 ? { bindings } : {}), ...(proofs.length > 0 ? { proofs } : {}) } };
}

export class AuthorityLedger {
  readonly #store: LedgerStore;
  readonly #registry: ModuleRegistry;
  readonly #rules: ReducerRules;

  /** `rules` must be the rules the store's reducer applies; the engine uses them to refuse before writing. */
  constructor(store: LedgerStore, registry: ModuleRegistry, rules: ReducerRules = CORE_RULES) {
    this.#store = store;
    this.#registry = registry;
    this.#rules = rules;
  }

  read(principal: PrincipalId): Promise<LedgerSnapshot> {
    return this.#store.read(principal);
  }

  async #commit(principal: PrincipalId, retry: RetryPolicy, plan: Planner): Promise<LedgerOutcome> {
    const max = retry.maxAttempts;
    if (!Number.isSafeInteger(max) || max < 1 || max > MAX_COMMIT_ATTEMPTS) {
      return { status: 'REFUSED', refusal: { code: 'RETRY_POLICY_INVALID', path: 'retry.maxAttempts', node: null }, attempts: 0, version: 0n as LedgerVersion };
    }
    for (let attempt = 1; attempt <= max; attempt += 1) {
      const snapshot = await this.#store.read(principal);
      // Recomputed from this snapshot on every attempt.
      const events = plan(snapshot);
      if (!events.ok) return { status: 'REFUSED', refusal: events.error, attempts: attempt, version: snapshot.version };
      const projected = applyBatch(snapshot.state, events.value, this.#rules);
      if (!projected.ok) return { status: 'REFUSED', refusal: projected.error, attempts: attempt, version: snapshot.version };
      const result = await this.#store.compareAndAppend(principal, snapshot.version, snapshot.head, events.value);
      if (result.status === 'COMMITTED') return { status: 'COMMITTED', snapshot: result.snapshot, attempts: attempt };
      if (result.status === 'REFUSED') return { status: 'REFUSED', refusal: result.refusal, attempts: attempt, version: snapshot.version };
    }
    return { status: 'CONFLICT', attempts: max };
  }

  /**
   * Register the principal's first policy, or replace it (7C refuses a new
   * dimension once anything was reserved; 7D.1 a new or tightened invariant).
   * `semantics.bindings` name the exact definition of each module-defined
   * term (7D.3), and `semantics.proofs` the exact definition proving each
   * restated invariant no stronger (7D.2). Every module named must be the
   * registry's current, active one: new authority is never bound, and a new
   * proof never made, under retired or remapped semantics.
   */
  registerPolicy(policy: PrincipalPolicy, at: bigint, retry: RetryPolicy, semantics: RegistrationSemantics = {}): Promise<LedgerOutcome> {
    return this.#commit(policy.principal, retry, () => {
      const s = registrationSemantics(this.#registry, semantics);
      return s.ok ? { ok: true, value: [{ kind: 'REGISTER_POLICY', at, policy, ...s.value }] } : s;
    });
  }

  /** Register a grant; `semantics` as for `registerPolicy`, proofs being for each invariant the grant narrows. */
  registerGrant(grant: AuthorityGrant, at: bigint, retry: RetryPolicy, semantics: RegistrationSemantics = {}): Promise<LedgerOutcome> {
    return this.#commit(grant.principal, retry, () => {
      const s = registrationSemantics(this.#registry, semantics);
      return s.ok ? { ok: true, value: [{ kind: 'REGISTER_GRANT', at, grant, ...s.value }] } : s;
    });
  }

  /** Several registrations as one atomic batch: all are registered, or none. */
  registerAll(principal: PrincipalId, events: readonly Extract<LedgerEvent, { kind: 'REGISTER_POLICY' | 'REGISTER_GRANT' | 'REVOKE' }>[], retry: RetryPolicy): Promise<LedgerOutcome> {
    return this.#commit(principal, retry, () => ({ ok: true, value: events }));
  }

  revoke(principal: PrincipalId, revocation: Revocation, at: bigint, retry: RetryPolicy): Promise<LedgerOutcome> {
    return this.#commit(principal, retry, () => ({ ok: true, value: [{ kind: 'REVOKE', at, revocation }] }));
  }

  /** Reserve every leg of a plan's charging path atomically, or nothing. */
  reserve(plan: ChargePlan, at: bigint, retry: RetryPolicy): Promise<LedgerOutcome> {
    return this.#commit(plan.principal, retry, (snapshot) => {
      const conformance = checkModuleConformance(this.#registry, plan.module, plan.implementation);
      if (!conformance.ok) return conformance;
      const event = deriveReserveEvent(snapshot.state, plan, at);
      return event.ok ? { ok: true, value: [event.value] } : event;
    });
  }

  /**
   * Fold accounting effects as one atomic batch — for example a final
   * observation's `CONSUME` and `CLOSE` together. The accounting primitive
   * only: which effects an observation implies is 7D's.
   */
  settle(principal: PrincipalId, effects: readonly AccountingEffect[], at: bigint, retry: RetryPolicy): Promise<LedgerOutcome> {
    return this.#commit(principal, retry, (snapshot) => {
      const version = (snapshot.version + 1n) as LedgerVersion;
      let draft = snapshot.state;
      const events: LedgerEvent[] = [];
      for (let i = 0; i < effects.length; i += 1) {
        const f = effects[i] as AccountingEffect;
        let event: LedgerEvent;
        if (f.kind === 'CLOSE') {
          const r = draft.reservations.get(f.reservation);
          const amounts = r === undefined ? [] : r.demands.map((d: DemandRecord) => d.reserved - d.consumed);
          event = { kind: 'CLOSE', at, reservation: f.reservation, generation: f.generation, evidence: f.evidence, amounts };
        } else {
          event = { kind: f.kind, at, reservation: f.reservation, generation: f.generation, evidence: f.evidence, amounts: f.amounts };
        }
        const next = applyEvent(draft, event, version, this.#rules);
        if (!next.ok) return { ok: false, error: withPath(next.error, `effects[${i}]`) };
        draft = next.value;
        events.push(event);
      }
      return { ok: true, value: events };
    });
  }
}
