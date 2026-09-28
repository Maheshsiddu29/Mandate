/**
 * The control engine: the orchestration boundary between domain semantics and
 * the authority ledger (brief §25–§31; architecture.md §6).
 *
 * ```text
 * authorizeAndReserve(request)
 *   for attempt in 1..maxAttempts:            bounded, chosen by the caller (7C's RetryPolicy)
 *     snapshot ← store.read(principal)
 *     decision ← decide(snapshot, request)     pure: authority, state, projection, invariants, demand, path
 *     refused  → return REFUSED                nothing written
 *     CAS(snapshot.version, snapshot.head, [RESERVE])
 *       committed → return AUTHORIZED          record bound to the committed version
 *       conflict  → next attempt               everything recomputed from the new snapshot
 *   return CONFLICT (RETRY_EXHAUSTED)          nothing written; not an authority failure
 * ```
 *
 * On a lost compare-and-swap nothing computed from the old snapshot is
 * reused — not the charge plan, and not the projection: a concurrent
 * reservation may have changed the pending set the invariants read, as well
 * as the capacity the ledger checks (brief §26). The ledger's CAS remains
 * the one atomic reservation point.
 *
 * **What this API does not expose.** No function here consumes, releases or
 * restores an amount, and none takes a verdict, a target or an effect from
 * its caller. The ledger's raw accounting reducer (`AuthorityLedger.settle`)
 * stays infrastructure-only (brief §31): the only release this engine can
 * perform is `closeNeverIssued`, the one pre-execution release 7A froze —
 * and only after the engine itself has found revalidation failing, with no
 * consumption on the reservation. A projection never moves authority (brief
 * §53).
 *
 * **Registration derives its own semantics (7D.3).** `registerDelegation`
 * (roots and delegations) and `registerPolicy` take the grant or policy, a
 * time and a retry policy — nothing else. The exact definition of every
 * module-defined term (`termBindings`) and every narrowing proof
 * (`narrowingProofs`, `policyProofs`) are derived here from the catalog's
 * current, active implementations and committed with the registration; no
 * argument, field or option lets a caller name a module, supply a proof or
 * assert a verdict. The ledger's own registration methods, which accept
 * already-derived `RegistrationSemantics`, are infrastructure, not this
 * surface.
 */

import {
  keccakDigest,
  policyInvariants,
  writeDigest,
  type AuthorityGrant,
  type LedgerVersion,
  type ObservationId,
  type PrincipalId,
  type PrincipalPolicy,
  type StateInvariantTerm,
} from '@mandate/core';
import {
  MAX_COMMIT_ATTEMPTS,
  applyBatch,
  applyEvent,
  grantInvariants,
  type DemandRecord,
  type LedgerEvent,
  type LedgerSnapshot,
  type LedgerStore,
  type ModuleRegistry,
  type RetryPolicy,
  type SemanticProofRef,
  type SemanticTermBinding,
} from '@mandate/ledger';
import { authorizationRecordOf, type AuthorizationRecord } from './authorization.ts';
import { termBindings } from './binding.ts';
import { controlRules, type ModuleCatalog } from './catalog.ts';
import { ControlTag, controlWriter } from './encoding.ts';
import { fromLedger, refusal, type ControlRefusal, type ControlResult } from './errors.ts';
import { narrowingProofs, policyProofs, semanticProofRefs, type NarrowingProof } from './narrowing.ts';
import { PRODUCTION_PIPELINE, decideWith, type AuthorizationRequest, type Decision, type DecisionEnv } from './pipeline.ts';
import { revalidateWith, type RevalidationRequest, type RevalidationResult } from './revalidation.ts';

export type AuthorizationOutcome =
  | { readonly status: 'AUTHORIZED'; readonly authorization: AuthorizationRecord; readonly decision: Decision; readonly snapshot: LedgerSnapshot; readonly attempts: number; readonly conflicts: readonly LedgerVersion[] }
  | { readonly status: 'REFUSED'; readonly refusal: ControlRefusal; readonly attempts: number; readonly version: LedgerVersion; readonly conflicts: readonly LedgerVersion[] }
  /** Every attempt lost a race. Nothing was written, and no authority rule was found failing. */
  | { readonly status: 'CONFLICT'; readonly refusal: ControlRefusal; readonly attempts: number; readonly conflicts: readonly LedgerVersion[] };

export type CloseOutcome =
  | { readonly status: 'CLOSED'; readonly evidence: ObservationId; readonly revalidation: RevalidationResult; readonly snapshot: LedgerSnapshot; readonly attempts: number }
  /** Idempotent: the reservation is already closed with nothing consumed. Nothing was written. */
  | { readonly status: 'ALREADY_CLOSED'; readonly attempts: number }
  | { readonly status: 'REFUSED'; readonly refusal: ControlRefusal; readonly attempts: number }
  | { readonly status: 'CONFLICT'; readonly refusal: ControlRefusal; readonly attempts: number };

export type RegistrationOutcome =
  | {
      readonly status: 'REGISTERED';
      readonly proofs: readonly NarrowingProof[];
      /** The exact definition each module-defined term was bound to, as committed (7D.3). */
      readonly bindings: readonly SemanticTermBinding[];
      readonly snapshot: LedgerSnapshot;
      readonly attempts: number;
    }
  | { readonly status: 'REFUSED'; readonly refusal: ControlRefusal; readonly attempts: number }
  | { readonly status: 'CONFLICT'; readonly refusal: ControlRefusal; readonly attempts: number };

function retryRefusal(retry: RetryPolicy): ControlRefusal | null {
  const max = retry.maxAttempts;
  return Number.isSafeInteger(max) && max >= 1 && max <= MAX_COMMIT_ATTEMPTS ? null : refusal('REQUEST_INVALID', 'RETRY_POLICY_INVALID', 'retry.maxAttempts');
}

function exhausted(): ControlRefusal {
  return refusal('RETRY_EXHAUSTED', 'CAS_CONFLICT', 'ledger', { detail: { kind: 'NONE' } });
}

/**
 * The internal evidence of a `NEVER_ISSUED` close: the reservation, its
 * generation, the authorization and the failed revalidation. It occupies the
 * ledger's observation slot under its own domain tag, so it can never equal a
 * real observation's identity.
 */
export function neverIssuedEvidence(record: AuthorizationRecord, revalidation: RevalidationResult): ObservationId {
  const w = controlWriter(ControlTag.NEVER_ISSUED);
  writeDigest(w, record.reservation);
  w.u64(record.generation);
  writeDigest(w, record.id);
  writeDigest(w, revalidation.id);
  return keccakDigest<ObservationId>(w.finish());
}

export interface ControlEngineOptions {
  readonly store: LedgerStore;
  readonly registry: ModuleRegistry;
  readonly catalog: ModuleCatalog;
}

export class ControlEngine {
  readonly #store: LedgerStore;
  readonly #env: DecisionEnv;
  readonly #catalog: ModuleCatalog;

  /**
   * The store must apply `controlRules(catalog)` at commit (catalog.ts);
   * otherwise a delegation the catalog proves narrower is refused by the
   * store as `LEDGER_CONFLICT` — fail closed.
   */
  constructor(o: ControlEngineOptions) {
    this.#store = o.store;
    this.#catalog = o.catalog;
    this.#env = Object.freeze({ catalog: o.catalog, registry: o.registry, rules: controlRules(o.catalog) });
  }

  read(principal: PrincipalId): Promise<LedgerSnapshot> {
    return this.#store.read(principal);
  }

  /** The decision against the current snapshot, reserving nothing. */
  async decide(request: AuthorizationRequest): Promise<ControlResult<Decision>> {
    const snapshot = await this.#store.read(request.action.principal);
    return decideWith(PRODUCTION_PIPELINE, snapshot, request, this.#env);
  }

  async authorizeAndReserve(request: AuthorizationRequest, retry: RetryPolicy): Promise<AuthorizationOutcome> {
    const bad = retryRefusal(retry);
    if (bad !== null) return { status: 'REFUSED', refusal: bad, attempts: 0, version: 0n as LedgerVersion, conflicts: [] };
    const conflicts: LedgerVersion[] = [];
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const snapshot = await this.#store.read(request.action.principal);
      // Everything recomputed from this snapshot: authority, state, pending set, projection, invariants, plan.
      const decision = decideWith(PRODUCTION_PIPELINE, snapshot, request, this.#env);
      if (!decision.ok) return { status: 'REFUSED', refusal: decision.error, attempts: attempt, version: snapshot.version, conflicts };
      const result = await this.#store.compareAndAppend(snapshot.principal, snapshot.version, snapshot.head, [decision.value.event]);
      if (result.status === 'COMMITTED') {
        const record = authorizationRecordOf(decision.value, result.snapshot);
        if (!record.ok) return { status: 'REFUSED', refusal: record.error, attempts: attempt, version: result.snapshot.version, conflicts };
        return { status: 'AUTHORIZED', authorization: record.value, decision: decision.value, snapshot: result.snapshot, attempts: attempt, conflicts };
      }
      if (result.status === 'REFUSED') {
        // The decision validated this batch against the snapshot the store has just refused it at: their rules disagree.
        const r = fromLedger(result.refusal, 'commit');
        return { status: 'REFUSED', refusal: { ...r, code: 'LEDGER_CONFLICT' }, attempts: attempt, version: snapshot.version, conflicts };
      }
      conflicts.push(snapshot.version);
    }
    return { status: 'CONFLICT', refusal: exhausted(), attempts: retry.maxAttempts, conflicts };
  }

  /** Revalidate an authorization against the current snapshot. Changes nothing. */
  async revalidate(record: AuthorizationRecord, request: RevalidationRequest): Promise<ControlResult<RevalidationResult>> {
    const snapshot = await this.#store.read(record.principal);
    return revalidateWith(PRODUCTION_PIPELINE, snapshot, record, request, this.#env);
  }

  /**
   * Close a reservation `NEVER_ISSUED` (reservations-reconciliation.md §4):
   * the engine revalidates it itself and closes it only if revalidation
   * fails, no consumption was ever recorded, and it is still the active
   * reservation at the authorization's generation. Everything reserved is
   * released, on every leg. In 7D no artifact can exist — there is no
   * `ADMIT_ATTEMPT` yet — so the ledger itself is the evidence that none was
   * issued; 7E must add "no attempt admitted" to these preconditions.
   * Idempotent: closing a closed, unconsumed reservation again writes nothing.
   */
  async closeNeverIssued(record: AuthorizationRecord, request: RevalidationRequest, retry: RetryPolicy): Promise<CloseOutcome> {
    const bad = retryRefusal(retry);
    if (bad !== null) return { status: 'REFUSED', refusal: bad, attempts: 0 };
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const snapshot = await this.#store.read(record.principal);
      const r = snapshot.state.reservations.get(record.reservation);
      if (r === undefined || r.generation !== record.generation || r.action !== record.actionId) {
        return { status: 'REFUSED', refusal: refusal('RESERVATION_NOT_ACTIVE', 'RESERVATION_UNKNOWN', 'authorization.reservation'), attempts: attempt };
      }
      const unconsumed = r.demands.every((d: DemandRecord) => d.consumed === 0n);
      if (r.status === 'CLOSED') {
        if (unconsumed && r.demands.every((d: DemandRecord) => d.released === d.reserved)) return { status: 'ALREADY_CLOSED', attempts: attempt };
        return { status: 'REFUSED', refusal: refusal('RESERVATION_NOT_ACTIVE', 'RESERVATION_CLOSED', 'authorization.reservation'), attempts: attempt };
      }
      if (!unconsumed) return { status: 'REFUSED', refusal: refusal('EXECUTION_EVIDENCE_EXISTS', 'CONSUMPTION_RECORDED', 'authorization.reservation'), attempts: attempt };
      const revalidation = revalidateWith(PRODUCTION_PIPELINE, snapshot, record, request, this.#env);
      if (!revalidation.ok) return { status: 'REFUSED', refusal: revalidation.error, attempts: attempt };
      if (revalidation.value.status === 'PASSED') {
        return { status: 'REFUSED', refusal: refusal('REVALIDATION_PASSED', 'AUTHORIZATION_STILL_VALID', 'revalidation'), attempts: attempt };
      }
      const evidence = neverIssuedEvidence(record, revalidation.value);
      const event: LedgerEvent = {
        kind: 'CLOSE',
        at: revalidation.value.evaluatedAt,
        reservation: record.reservation,
        generation: record.generation,
        evidence,
        amounts: r.demands.map((d: DemandRecord) => d.reserved - d.consumed),
      };
      const checked = applyBatch(snapshot.state, [event], this.#env.rules);
      if (!checked.ok) return { status: 'REFUSED', refusal: fromLedger(checked.error, 'close'), attempts: attempt };
      const result = await this.#store.compareAndAppend(snapshot.principal, snapshot.version, snapshot.head, [event]);
      if (result.status === 'COMMITTED') return { status: 'CLOSED', evidence, revalidation: revalidation.value, snapshot: result.snapshot, attempts: attempt };
      if (result.status === 'REFUSED') return { status: 'REFUSED', refusal: { ...fromLedger(result.refusal, 'commit'), code: 'LEDGER_CONFLICT' }, attempts: attempt };
    }
    return { status: 'CONFLICT', refusal: exhausted(), attempts: retry.maxAttempts };
  }

  /**
   * Register a grant — a root or a delegation — binding each module-defined
   * term to its current, active definition (binding.ts) and proving any
   * restated invariant with different parameters no weaker by that same
   * definition (narrowing.ts). The caller supplies only the grant; the
   * bindings and verdicts are the catalog's, and the store's reducer
   * re-checks them at commit.
   */
  async registerDelegation(grant: AuthorityGrant, at: bigint, retry: RetryPolicy): Promise<RegistrationOutcome> {
    return this.#register(grant.principal, retry, grantInvariants(grant), 'grant.terms', (snapshot, bindings) => {
      const parent = grant.lineage.kind === 'DELEGATION' ? snapshot.state.nodes.get(grant.lineage.parent) : undefined;
      return parent === undefined ? [] : narrowingProofs(parent.grant, grant, this.#catalog, { parent: parent.bindings, child: bindings });
    }, (bindings, refs) => ({ kind: 'REGISTER_GRANT', at, grant, ...semanticsOf(bindings, refs) }));
  }

  /**
   * Register the principal policy, or replace it, under the ledger's
   * baseline rules: each module-defined principal-global term is bound to its
   * current, active definition, and each one restated after activity is
   * proven no stronger under that definition (7D.1). An existing policy's
   * terms keep their committed meaning until a policy registered here
   * replaces them.
   */
  async registerPolicy(policy: PrincipalPolicy, at: bigint, retry: RetryPolicy): Promise<RegistrationOutcome> {
    return this.#register(policy.principal, retry, policyInvariants(policy), 'policy.terms', (snapshot, bindings) => policyProofs(snapshot.state, policy, this.#catalog, bindings), (bindings, refs) => ({
      kind: 'REGISTER_POLICY',
      at,
      policy,
      ...semanticsOf(bindings, refs),
    }));
  }

  async #register(
    principal: PrincipalId,
    retry: RetryPolicy,
    invariants: readonly StateInvariantTerm[],
    termsPath: string,
    prove: (snapshot: LedgerSnapshot, bindings: readonly SemanticTermBinding[]) => readonly NarrowingProof[],
    eventOf: (bindings: readonly SemanticTermBinding[], proofs: readonly SemanticProofRef[]) => LedgerEvent,
  ): Promise<RegistrationOutcome> {
    const bad = retryRefusal(retry);
    if (bad !== null) return { status: 'REFUSED', refusal: bad, attempts: 0 };
    // What each term means: the current, active owner of its definition, fixed from now on (7D.3).
    const bindings = termBindings(invariants, this.#catalog, termsPath);
    if (!bindings.ok) return { status: 'REFUSED', refusal: bindings.error, attempts: 0 };
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const snapshot = await this.#store.read(principal);
      const proofs = prove(snapshot, bindings.value);
      // Committed with the registration: exactly whose semantics proved each narrowing (7D.2).
      const refs = semanticProofRefs(proofs, invariants);
      const event = eventOf(bindings.value, refs);
      // The reducer's own rules, against this snapshot, before anything is written.
      const checked = applyEvent(snapshot.state, event, (snapshot.version + 1n) as LedgerVersion, this.#env.rules);
      if (!checked.ok) {
        const r = fromLedger(checked.error, '');
        const detail = checked.error.code === 'DELEGATION_REFUSED' ? { kind: 'DELEGATION' as const, violations: checked.error.violations, proofs } : r.detail;
        return { status: 'REFUSED', refusal: { ...r, detail }, attempts: attempt };
      }
      // Defence in depth: only an active comparator's NO_WEAKER is ever committed as a new proof.
      const unproven = proofs.find((p) => p.verdict !== 'NO_WEAKER');
      if (unproven !== undefined) {
        return { status: 'REFUSED', refusal: refusal('SEMANTIC_NARROWING_UNPROVABLE', 'COMPARATOR_NOT_ACTIVE', `${termsPath}.${unproven.invariantId}`, { detail: { kind: 'DELEGATION', violations: [], proofs } }), attempts: attempt };
      }
      const result = await this.#store.compareAndAppend(snapshot.principal, snapshot.version, snapshot.head, [event]);
      if (result.status === 'COMMITTED') return { status: 'REGISTERED', proofs, bindings: bindings.value, snapshot: result.snapshot, attempts: attempt };
      if (result.status === 'REFUSED') return { status: 'REFUSED', refusal: { ...fromLedger(result.refusal, 'commit'), code: 'LEDGER_CONFLICT' }, attempts: attempt };
    }
    return { status: 'CONFLICT', refusal: exhausted(), attempts: retry.maxAttempts };
  }
}

function semanticsOf(bindings: readonly SemanticTermBinding[], proofs: readonly SemanticProofRef[]): { bindings?: readonly SemanticTermBinding[]; proofs?: readonly SemanticProofRef[] } {
  return { ...(bindings.length > 0 ? { bindings } : {}), ...(proofs.length > 0 ? { proofs } : {}) };
}
