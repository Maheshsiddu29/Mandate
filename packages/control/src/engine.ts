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
  adapterRefsEqual,
  keccakDigest,
  moduleRefDigest,
  policyInvariants,
  writeAdapterRef,
  writeDigest,
  type AccountId,
  type AdapterRef,
  type AuthorityGrant,
  type Digest32,
  type LedgerVersion,
  type ObservationId,
  type PrincipalId,
  type PrincipalPolicy,
  type StateInvariantTerm,
} from '@mandate/core';
import {
  MAX_COMMIT_ATTEMPTS,
  anyAttemptAdmitted,
  applyBatch,
  applyEvent,
  attemptIdFor,
  attemptsOf,
  checkAdapterUsable,
  checkModuleIssuable,
  grantInvariants,
  type AdapterRegistry,
  type ArtifactIdentity,
  type AttemptAdmission,
  type AttemptRecord,
  type DemandRecord,
  type LedgerEvent,
  type LedgerSnapshot,
  type LedgerStore,
  type ModuleRegistry,
  type RetryPolicy,
  type SemanticProofRef,
  type SemanticTermBinding,
  type VenueSlot,
} from '@mandate/ledger';
import { authorizationRecordOf, type AuthorizationRecord } from './authorization.ts';
import { termBindings } from './binding.ts';
import { controlRules, type ModuleCatalog } from './catalog.ts';
import { ControlTag, controlWriter } from './encoding.ts';
import { fromLedger, refusal, type ControlRefusal, type ControlResult } from './errors.ts';
import { narrowingProofs, policyProofs, semanticProofRefs, type NarrowingProof } from './narrowing.ts';
import { PRODUCTION_PIPELINE, decideWith, type AuthorizationRequest, type Decision, type DecisionEnv } from './pipeline.ts';
import { checkPreExecution, evidenceDigest, preExecutionDigest, type PreExecutionRequirement, type PreExecutionResult } from './preexecution.ts';
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

/**
 * What an enforcement adapter asks for when it is ready to create one exact
 * artifact (7E.1). Everything here is the adapter's identity of the artifact
 * and its own pre-execution evidence; nothing in it can widen the
 * authorization, which is re-read from the ledger and revalidated.
 */
export interface AttemptRequest {
  /** The payload, fresh state and issue-time context for revalidation (reservations-reconciliation.md §10a). */
  readonly revalidation: RevalidationRequest;
  /** The adapter performing issuance: must be exactly the authorization's. */
  readonly adapter: AdapterRef;
  readonly venueAccount: AccountId;
  readonly artifact: ArtifactIdentity;
  readonly slot: VenueSlot | null;
  /** The artifact's own expiry, at or before the revalidated lifetime (EXEC-3, EXEC-6). */
  readonly validUntil: bigint;
  /** The adapter descriptor's requirements; the control-evaluated ones are always added. */
  readonly requirements: readonly PreExecutionRequirement[];
  /** The adapter-evaluated results, each with its evidence digest. */
  readonly results: readonly PreExecutionResult[];
}

export type AttemptOutcome =
  | { readonly status: 'ADMITTED'; readonly attempt: AttemptRecord; readonly revalidation: RevalidationResult; readonly preExecution: readonly PreExecutionResult[]; readonly snapshot: LedgerSnapshot; readonly attempts: number }
  /** The reservation already has an admitted attempt: this is it. Nothing new was admitted, and nothing may be. */
  | { readonly status: 'EXISTING'; readonly attempt: AttemptRecord; readonly attempts: number }
  /** Nothing was written. `revalidation` is present when revalidation ran and failed — the case `NEVER_ISSUED` may then close. */
  | { readonly status: 'REFUSED'; readonly refusal: ControlRefusal; readonly revalidation: RevalidationResult | null; readonly attempts: number }
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
  /**
   * The enforcement-adapter registry (7E.1). When present, a new authorization
   * through a retiring, disabled, unregistered or re-digested adapter is
   * refused; issuance (`admitAttempt`) requires it.
   */
  readonly adapters?: AdapterRegistry;
}

/** The control-evaluated requirements every attempt carries, about its reservation. */
function controlRequirements(subject: string): readonly PreExecutionRequirement[] {
  return [
    { kind: 'STATE_REVALIDATION', subject },
    { kind: 'MODULE_TRUST', subject },
    { kind: 'ADAPTER_TRUST', subject },
  ];
}

function adapterDigestOf(a: AdapterRef): Digest32 {
  const w = controlWriter(ControlTag.PRE_EXECUTION_EVIDENCE);
  writeAdapterRef(w, a);
  return keccakDigest<Digest32>(w.finish());
}

export class ControlEngine {
  readonly #store: LedgerStore;
  readonly #env: DecisionEnv;
  readonly #catalog: ModuleCatalog;
  readonly #registry: ModuleRegistry;
  readonly #adapters: AdapterRegistry | null;

  /**
   * The store must apply `controlRules(catalog)` at commit (catalog.ts);
   * otherwise a delegation the catalog proves narrower is refused by the
   * store as `LEDGER_CONFLICT` — fail closed.
   */
  constructor(o: ControlEngineOptions) {
    this.#store = o.store;
    this.#catalog = o.catalog;
    this.#registry = o.registry;
    this.#adapters = o.adapters ?? null;
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
      // 7E.1: an otherwise authorized action through a retiring, disabled, unknown or re-digested adapter
      // reserves nothing. Checked after the decision, so every 7D refusal keeps its precedence.
      if (this.#adapters !== null) {
        const usable = checkAdapterUsable(this.#adapters, request.action.adapter, 'DECISION', 'action.adapter');
        if (!usable.ok) return { status: 'REFUSED', refusal: fromLedger(usable.error, ''), attempts: attempt, version: snapshot.version, conflicts };
      }
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
      // 7E.1 (7D.1 R5): once an attempt was admitted an artifact may exist, and the ledger is no longer
      // evidence that none was issued. Nothing — a crash, a timeout, a failed revalidation — changes that.
      if (anyAttemptAdmitted(snapshot.state, record.reservation)) {
        return { status: 'REFUSED', refusal: refusal('NEVER_ISSUED_FORBIDDEN', 'ATTEMPT_ADMITTED', 'authorization.reservation'), attempts: attempt };
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
   * Admit one issuance attempt for an authorization (7E.1; the frozen 7D.1
   * precondition): the boundary an enforcement adapter must cross **before**
   * any signing key is used. In one decision against one snapshot:
   *
   * 1. if the reservation already has an attempt, return it (`EXISTING`) —
   *    one generation never yields a second, independent attempt;
   * 2. the adapter is exactly the authorization's and is usable for issuance
   *    (active or retiring, never disabled or re-digested);
   * 3. the reservation's module may carry it to issuance (never disabled);
   * 4. the authorization revalidates at the issue time (reservation active at
   *    its generation, lineage valid, state re-admitted or refreshed and every
   *    invariant re-run over the current pending set);
   * 5. the artifact's expiry is inside the revalidated lifetime;
   * 6. every pre-execution requirement — Core's own and the adapter's — is
   *    `PASS`;
   * 7. the `ADMIT_ATTEMPT` event, naming the exact artifact and slot, commits
   *    by compare-and-swap; the ledger re-derives the attempt id and refuses a
   *    reused artifact or slot.
   *
   * A failure before the commit writes nothing, and — because no attempt
   * exists — `closeNeverIssued` may then close the reservation. After the
   * commit it may not, ever. A lost race re-runs everything from the new
   * snapshot.
   */
  async admitAttempt(record: AuthorizationRecord, request: AttemptRequest, retry: RetryPolicy): Promise<AttemptOutcome> {
    const bad = retryRefusal(retry);
    if (bad !== null) return { status: 'REFUSED', refusal: bad, revalidation: null, attempts: 0 };
    const adapters = this.#adapters;
    if (adapters === null) return { status: 'REFUSED', refusal: refusal('REQUEST_INVALID', 'ADAPTER_REGISTRY_MISSING', 'engine.adapters'), revalidation: null, attempts: 0 };
    const refused = (r: ControlRefusal, attempt: number, revalidation: RevalidationResult | null = null): AttemptOutcome => ({ status: 'REFUSED', refusal: r, revalidation, attempts: attempt });
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const snapshot = await this.#store.read(record.principal);
      const existing = attemptsOf(snapshot.state, record.reservation);
      if (existing.length > 0) return { status: 'EXISTING', attempt: existing[existing.length - 1] as AttemptRecord, attempts: attempt };

      if (!adapterRefsEqual(request.adapter, record.adapter)) return refused(refusal('ADAPTER_NOT_USABLE', 'ADAPTER_MISMATCH', 'request.adapter'), attempt);
      const usable = checkAdapterUsable(adapters, request.adapter, 'ATTEMPT', 'request.adapter');
      if (!usable.ok) return refused(fromLedger(usable.error, ''), attempt);
      const issuable = checkModuleIssuable(this.#registry, record.module, 'authorization.module');
      if (!issuable.ok) return refused(fromLedger(issuable.error, ''), attempt);

      const revalidation = revalidateWith(PRODUCTION_PIPELINE, snapshot, record, request.revalidation, this.#env);
      if (!revalidation.ok) return refused(revalidation.error, attempt);
      const v = revalidation.value;
      if (v.status === 'FAILED') return refused(v.refusal, attempt, v);
      const t = v.evaluatedAt;
      if (request.validUntil <= t) return refused(refusal('REQUEST_INVALID', 'ARTIFACT_ALREADY_EXPIRED', 'request.validUntil'), attempt);
      if (request.validUntil > v.validUntil) return refused(refusal('REQUEST_INVALID', 'ARTIFACT_OUTLIVES_AUTHORIZATION', 'request.validUntil'), attempt);

      const subject = record.reservation;
      const control: PreExecutionResult[] = [
        { kind: 'STATE_REVALIDATION', subject, outcome: 'PASS', reason: v.refreshed ? 'REFRESHED' : 'READMITTED', evidence: evidenceDigest('STATE_REVALIDATION', subject, [v.id]) },
        { kind: 'MODULE_TRUST', subject, outcome: 'PASS', reason: 'ISSUABLE', evidence: evidenceDigest('MODULE_TRUST', subject, [moduleRefDigest(record.module)]) },
        { kind: 'ADAPTER_TRUST', subject, outcome: 'PASS', reason: 'USABLE', evidence: evidenceDigest('ADAPTER_TRUST', subject, [adapterDigestOf(request.adapter)]) },
      ];
      const pre = checkPreExecution([...controlRequirements(subject), ...request.requirements], control, request.results);
      if (!pre.ok) return refused(pre.error, attempt, v);

      const base = { reservation: record.reservation, generation: record.generation, action: record.actionId, module: record.module, adapter: record.adapter, authorization: record.executionId, ordinal: 1 };
      const admission: AttemptAdmission = {
        attempt: attemptIdFor(base),
        ...base,
        venueAccount: request.venueAccount,
        artifact: { kind: request.artifact.kind, id: new Uint8Array(request.artifact.id) },
        slot: request.slot,
        validUntil: request.validUntil,
        requirements: preExecutionDigest(pre.value),
        revalidation: v.id,
      };
      const event: LedgerEvent = { kind: 'ADMIT_ATTEMPT', at: t, admission };
      const checked = applyBatch(snapshot.state, [event], this.#env.rules);
      if (!checked.ok) return refused(fromLedger(checked.error, 'attempt'), attempt, v);
      const result = await this.#store.compareAndAppend(snapshot.principal, snapshot.version, snapshot.head, [event]);
      if (result.status === 'COMMITTED') {
        const committed = result.snapshot.state.attempts.get(admission.attempt) as AttemptRecord;
        return { status: 'ADMITTED', attempt: committed, revalidation: v, preExecution: pre.value, snapshot: result.snapshot, attempts: attempt };
      }
      if (result.status === 'REFUSED') return refused({ ...fromLedger(result.refusal, 'commit'), code: 'LEDGER_CONFLICT' }, attempt, v);
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
