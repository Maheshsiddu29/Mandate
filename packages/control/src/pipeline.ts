/**
 * The pure decision: one ledger snapshot and one request in, a complete
 * decision or a refusal out (brief §25; architecture.md §6).
 *
 * ```text
 *  1. resolve the exact module for the action's ModuleRef
 *  2. the action's own validity: payload digest, window
 *  3. the authority: principal, lineage valid at t, actor = holder, the meet
 *  4. the module's analysis of the action; coverage over the meet
 *  5. every applicable invariant: the lineage's union and the principal policy's
 *  6. participants: the acting module, every invariant's owner, every aggregate's contributors,
 *     and — where an aggregate applies — every module with an unresolved reservation
 *  7. each participant's state requirements, tightened by lineage and policy state policies
 *  8. admission of exactly that state; a binding per admitted snapshot
 *  9. unresolved reservations from the snapshot: each module gets exactly its own
 * 10. projection per participant: held + pending (worst case) + proposed
 * 11. every invariant evaluated on the projection; ALLOW only if all HOLD
 * 12. the acting module's ledger demands → the charge plan (no targets)
 * 13. the ledger derives the charging path and checks availability, against this snapshot
 * 14. the authorization's lifetime: the earliest of every dependency's end
 * ```
 *
 * Everything is computed from the snapshot and the request alone, so the
 * engine can — and on a lost compare-and-swap must — recompute it from a
 * newer snapshot. Nothing computed from one snapshot is carried to the next:
 * a concurrent reservation changes the projection, not just the capacity
 * (brief §26).
 *
 * **Immutable authority semantics (7D.3).** Step 5 takes each invariant
 * together with the binding its registration committed, and step 11
 * evaluates it under exactly that definition (`committedSemantics`): the
 * `ModuleRef` and digest the grant or policy was registered with, loaded or
 * archived, never the module the invariant's name maps to now. An unbound
 * module-defined term, or a committed definition that is not available, is
 * `UNKNOWN`, and the action refuses.
 *
 * The stages that decide what is *seen* — which invariants apply, which
 * reservations are pending, how state is admitted, which definition a term
 * is evaluated under — are one `Pipeline` record, so the mutation suite can
 * replace exactly one and show the others catch it. Production code uses only `PRODUCTION_PIPELINE`; the record is
 * not exported from the package.
 */

import { ok } from '@mandate/kernel';
import {
  actionEnvelopeInputOf,
  actionId,
  actionPayloadDigest,
  moduleRefDigest,
  moduleRefInputOf,
  parseReservationGeneration,
  partyIdInputOf,
  partyIdsEqual,
  quantityInputOf,
  resourceIdInputOf,
  validateActionEnvelope,
  writeStateBinding,
  type ActionEnvelope,
  type ActionId,
  type AuthorityId,
  type Digest32,
  type ImplementationDigest,
  type IntegerInput,
  type LedgerHeadDigest,
  type LedgerVersion,
  type ModuleRef,
  type PrincipalPolicyId,
  type ReservationGeneration,
  type ReservationId,
  type StateBinding,
  type StateInvariantTerm,
  type Tagged,
} from '@mandate/core';
import {
  applyBatch,
  checkLineageValid,
  checkModuleConformance,
  deriveReserveEvent,
  effectiveAuthority,
  resolveLineage,
  validateChargePlan,
  writeChargePlan,
  type ChargePlan,
  type EffectiveAuthority,
  type LedgerEvent,
  type LedgerSnapshot,
  type LedgerState,
  type ModuleRegistry,
  type NodeRecord,
  type ReducerRules,
  type SemanticTermBinding,
  isModuleDefined,
} from '@mandate/ledger';
import { admitNeeds, effectiveNeed, mergeNeeds, prepareStates, statesFor, type Admission, type EffectiveNeed, type PreparedState, type SuppliedState } from './admission.ts';
import {
  AGGREGATE_INVARIANT_ID,
  AGGREGATE_INVARIANT_VERSION,
  aggregateQueryFor,
  aggregateSpecOf,
  distinctQueries,
  evaluateAggregate,
  type AggregateEvaluator,
  type AggregateSpec,
  type ParticipantView,
} from './aggregate.ts';
import type { Evaluator, ModuleCatalog } from './catalog.ts';
import { validateEvaluationContext, type ContextDigest, type EvaluationContext, type EvaluationContextInput } from './context.ts';
import { checkCoverage } from './coverage.ts';
import { ControlTag, controlDigest, controlWriter, sortCanonical } from './encoding.ts';
import { fromLedger, refuse, type ControlResult } from './errors.ts';
import { factsFor, reservationFacts } from './facts.ts';
import { frozenCopy } from './freeze.ts';
import { invariantResultsDigest, invariantVerdict, type InvariantOrigin, type InvariantResult, type InvariantResultsDigest } from './invariants.ts';
import { MAX_INVARIANTS, MAX_PARTICIPANTS } from './limits.ts';
import type { ActionAnalysis, ActionContext, AggregateQuery, DomainModule, LedgerDemand, ModuleProjection, ModuleScope, ProjectionMode, ReservationFact, ScopedAction } from './module.ts';
import { callModule, checkAnalysis, checkDemands, checkEvaluation, checkNeeds, checkProjection } from './outputs.ts';
import { projectionDigest, type ParticipantProjection, type ProjectionDigest, type ProjectionRecord } from './projection.ts';

export type ChargePlanDigest = Tagged<Digest32, 'ChargePlanDigest'>;

export interface AuthorizationRequest {
  readonly action: ActionEnvelope;
  /** The payload the action's `payloadDigest` commits to. */
  readonly payload: Uint8Array;
  /** Explicit, never defaulted: 1 for a first reservation (RECON-2). */
  readonly generation: IntegerInput;
  readonly states: readonly SuppliedState[];
  readonly context: EvaluationContextInput;
}

export interface DecisionEnv {
  readonly catalog: ModuleCatalog;
  readonly registry: ModuleRegistry;
  /** The reducer rules of the store the decision will be committed to. */
  readonly rules: ReducerRules;
}

export interface ApplicableInvariant {
  readonly origin: InvariantOrigin;
  readonly term: StateInvariantTerm;
  /** The exact definition the term's registration committed (7D.3); `null` for a Core term. */
  readonly binding: SemanticTermBinding | null;
}

/** Which implementation interprets a module-defined term, or why none may. */
export type SemanticResolution = { readonly ok: true; readonly module: DomainModule } | { readonly ok: false; readonly reason: string };
export type SemanticResolver = (invariant: ApplicableInvariant, catalog: ModuleCatalog) => SemanticResolution;

/** The stages whose replacement changes what a decision sees. */
export interface Pipeline {
  readonly applicable: (effective: EffectiveAuthority) => readonly ApplicableInvariant[];
  readonly facts: (state: LedgerState) => ControlResult<readonly ReservationFact[]>;
  readonly admit: (needs: readonly EffectiveNeed[], prepared: readonly PreparedState[], ctx: EvaluationContext, path: string) => ControlResult<readonly Admission[]>;
  readonly aggregate: AggregateEvaluator;
  readonly semantics: SemanticResolver;
}

/** Every lineage invariant (the union over the lineage), then every principal-global one, each with its committed binding. */
export function applicableInvariants(effective: EffectiveAuthority): readonly ApplicableInvariant[] {
  return [
    ...effective.invariants.map((b) => ({ origin: 'LINEAGE' as const, term: b.term, binding: b.binding })),
    ...effective.principalInvariants.map((b) => ({ origin: 'POLICY' as const, term: b.term, binding: b.binding })),
  ];
}

/**
 * SEMANTIC-AUTH-1…3: a module-defined term is interpreted by exactly the
 * definition its registration committed — resolved by exact `ModuleRef`
 * among the loaded and archived implementations, with no registry lookup
 * and no name resolution — or by nothing. A `core.*` term other than the
 * aggregate has no definition anywhere.
 */
export function committedSemantics(a: ApplicableInvariant, catalog: ModuleCatalog): SemanticResolution {
  if (!isModuleDefined(a.term)) return { ok: false, reason: 'INVARIANT_DEFINITION_UNRESOLVED' };
  if (a.binding === null) return { ok: false, reason: 'SEMANTIC_BINDING_MISSING' };
  const m = catalog.resolveDefinition(a.binding.definition);
  return m === null ? { ok: false, reason: 'SEMANTIC_DEFINITION_UNAVAILABLE' } : { ok: true, module: m };
}

export const PRODUCTION_PIPELINE: Pipeline = Object.freeze({
  applicable: applicableInvariants,
  facts: (state: LedgerState) => reservationFacts(state),
  admit: admitNeeds,
  aggregate: evaluateAggregate,
  semantics: committedSemantics,
});

/** Every `ModuleRef` with an unresolved reservation, once each, in canonical order. */
function activeModules(facts: readonly ReservationFact[]): readonly ModuleRef[] {
  const byKey = new Map<string, ModuleRef>();
  for (const f of facts) byKey.set(moduleRefDigest(f.module), f.module);
  return [...byKey.keys()].sort().map((k) => byKey.get(k) as ModuleRef);
}

// --- Projection and invariants (shared with revalidation) ----------------------

interface ParticipantDraft {
  readonly module: DomainModule;
  readonly acting: boolean;
  readonly invariants: StateInvariantTerm[];
  readonly aggregates: AggregateQuery[];
}

export interface StateEvaluation {
  readonly admissions: readonly Admission[];
  readonly participants: readonly ParticipantProjection[];
  readonly projection: ProjectionRecord;
  readonly projectionDigest: ProjectionDigest;
  readonly results: readonly InvariantResult[];
  readonly actingProjection: ModuleProjection;
}

export interface EvaluationInput {
  readonly snapshot: LedgerSnapshot;
  readonly effective: EffectiveAuthority;
  readonly acting: DomainModule;
  readonly action: ScopedAction;
  readonly prepared: readonly PreparedState[];
  readonly ctx: EvaluationContext;
  readonly catalog: ModuleCatalog;
}

function sameTerm(a: StateInvariantTerm, b: StateInvariantTerm): boolean {
  return a.invariantId === b.invariantId && a.version === b.version && a.params === b.params && a.scope.length === b.scope.length && a.scope.every((s, i) => {
    const t = b.scope[i];
    return t !== undefined && s.domain === t.domain && s.kind === t.kind && s.localId === t.localId;
  });
}

/**
 * Steps 5–11 for one acting module and mode: admission, projection over
 * `S ⊕ Pending(L)` and every applicable invariant. Returns the complete
 * evidence; the verdict is taken by the caller.
 */
export function evaluateState(p: Pipeline, input: EvaluationInput): ControlResult<StateEvaluation> {
  const { snapshot, effective, acting, action, prepared, ctx, catalog } = input;
  const applicable = p.applicable(effective);
  if (applicable.length > MAX_INVARIANTS) return refuse('RESOURCE_BOUND_EXCEEDED', 'TOO_MANY_INVARIANTS', 'invariants');
  const facts = p.facts(snapshot.state);
  if (!facts.ok) return facts;

  // --- participants
  const drafts = new Map<string, ParticipantDraft>();
  const join = (module: DomainModule, acting: boolean): ParticipantDraft => {
    const key = moduleRefDigest(module.ref);
    let d = drafts.get(key);
    if (d === undefined) {
      d = { module, acting, invariants: [], aggregates: [] };
      drafts.set(key, d);
    }
    return d;
  };
  join(acting, true);
  interface Pending {
    readonly origin: InvariantOrigin;
    readonly term: StateInvariantTerm;
    readonly kind: 'AGGREGATE' | 'MODULE' | 'UNRESOLVED';
    readonly spec: AggregateSpec | null;
    readonly owner: DomainModule | null;
    readonly reason: string;
  }
  const plan: Pending[] = [];
  for (const a of applicable) {
    const t = a.term;
    if (t.invariantId === AGGREGATE_INVARIANT_ID && t.version === AGGREGATE_INVARIANT_VERSION) {
      const spec = aggregateSpecOf(t);
      if (!spec.ok) {
        plan.push({ origin: a.origin, term: t, kind: 'UNRESOLVED', spec: null, owner: null, reason: spec.error });
        continue;
      }
      plan.push({ origin: a.origin, term: t, kind: 'AGGREGATE', spec: spec.value, owner: null, reason: '' });
      continue;
    }
    // The committed definition, never the name's current owner (7D.3).
    const resolved = p.semantics(a, catalog);
    if (!resolved.ok) {
      plan.push({ origin: a.origin, term: t, kind: 'UNRESOLVED', spec: null, owner: null, reason: resolved.reason });
      continue;
    }
    const owner = resolved.module;
    const d = join(owner, false);
    if (!d.invariants.some((x) => sameTerm(x, t))) d.invariants.push(t);
    plan.push({ origin: a.origin, term: t, kind: 'MODULE', spec: null, owner, reason: '' });
  }
  // Aggregate scope is closed: its contributors, the acting module and every module with an
  // unresolved reservation are each asked for their part, so no pending activity drops out of an
  // aggregate because its module is not listed. A module that cannot be resolved is simply absent;
  // the aggregate then evaluates UNKNOWN.
  const active = activeModules(facts.value);
  for (const x of plan) {
    if (x.kind !== 'AGGREGATE') continue;
    const spec = x.spec as AggregateSpec;
    const consulted = new Map<string, ModuleRef>();
    for (const r of [...spec.params.contributors, ...active, acting.ref]) consulted.set(moduleRefDigest(r), r);
    for (const r of consulted.values()) {
      const m = catalog.resolveForLifecycle(r, 'invariant.contributor');
      if (m.ok) join(m.value, false).aggregates.push(aggregateQueryFor(spec, r));
    }
  }
  if (drafts.size > MAX_PARTICIPANTS) return refuse('RESOURCE_BOUND_EXCEEDED', 'TOO_MANY_PARTICIPANTS', 'participants');
  const ordered = [...drafts.keys()].sort().map((k) => drafts.get(k) as ParticipantDraft);

  // --- scopes and requirements
  const scopes = new Map<string, { scope: ModuleScope; foreign: readonly ReservationId[] }>();
  const needs: EffectiveNeed[] = [];
  for (const d of ordered) {
    const key = moduleRefDigest(d.module.ref);
    const mine = factsFor(d.module.ref, facts.value);
    const scope = frozenCopy<ModuleScope>({
      principal: snapshot.principal,
      action: d.acting ? action : null,
      invariants: d.invariants,
      aggregates: distinctQueries(d.aggregates),
      reservations: mine.own,
    });
    scopes.set(key, { scope, foreign: mine.foreign });
    const path = `participants.${d.module.ref.moduleId}@${d.module.ref.moduleVersion}`;
    const raw = callModule(d.module, d.acting ? 'ACTION_INVALID' : 'INVARIANT_UNKNOWN', `${path}.stateRequirements`, () => d.module.stateRequirements(scope));
    if (!raw.ok) return raw;
    const checked = checkNeeds(d.module, raw.value, `${path}.stateRequirements`);
    if (!checked.ok) return checked;
    for (let i = 0; i < checked.value.length; i += 1) {
      const n = effectiveNeed(d.module, checked.value[i] as (typeof checked.value)[number], effective.statePolicies, `${path}.stateRequirements[${i}]`);
      if (!n.ok) return n;
      needs.push(n.value);
    }
  }
  const merged = mergeNeeds(needs, 'requirements');
  if (!merged.ok) return merged;

  // --- admission
  const admissions = p.admit(merged.value, prepared, ctx, 'state');
  if (!admissions.ok) return admissions;
  for (const a of admissions.value) {
    const m = a.need.module;
    const state = frozenCopy(a.state);
    const valid = callModule(m, 'STATE_INVALID', `state.${a.need.label}`, () => m.validateStatePayload(state));
    if (!valid.ok) return valid;
  }

  // --- projection
  const participants: ParticipantProjection[] = [];
  const views: ParticipantView[] = [];
  let actingProjection: ModuleProjection | null = null;
  for (const d of ordered) {
    const { scope, foreign } = scopes.get(moduleRefDigest(d.module.ref)) as { scope: ModuleScope; foreign: readonly ReservationId[] };
    const states = frozenCopy([...statesFor(d.module, admissions.value)]);
    const path = `participants.${d.module.ref.moduleId}@${d.module.ref.moduleVersion}.project`;
    const raw = callModule(d.module, 'INVARIANT_UNKNOWN', path, () => d.module.project(scope, states));
    if (!raw.ok) return raw;
    const projection = checkProjection(d.module, raw.value, scope, states.map((s) => s.stateId), path);
    if (!projection.ok) return projection;
    if (d.acting) actingProjection = projection.value;
    participants.push({
      module: d.module.ref,
      implementation: d.module.implementation,
      acting: d.acting,
      states: states.map((s) => s.stateId).sort(),
      reservations: scope.reservations.map((r) => r.reservation),
      foreignPending: [...foreign].sort(),
      projection: projection.value,
    });
    views.push({ module: d.module.ref, projection: projection.value, admitted: new Map(states.map((x) => [x.stateId, x.envelope])) });
  }
  const record: ProjectionRecord = { ledgerVersion: snapshot.version, participants };
  const digest = projectionDigest(record);

  // --- invariants: every one, not only up to the first failure
  const results: InvariantResult[] = [];
  const result = (x: Pending, evaluator: Evaluator, e: Pick<InvariantResult, 'outcome' | 'reason' | 'observed' | 'bound' | 'states' | 'reservations'>): void => {
    results.push({ origin: x.origin, term: x.term, evaluator, ...e, projection: digest, ledgerVersion: snapshot.version });
  };
  for (const x of plan) {
    if (x.kind === 'UNRESOLVED') {
      result(x, { kind: 'NONE' }, { outcome: 'UNKNOWN', reason: x.reason, observed: null, bound: null, states: [], reservations: [] });
    } else if (x.kind === 'AGGREGATE') {
      result(x, { kind: 'CORE' }, p.aggregate(x.spec as AggregateSpec, views, active));
    } else {
      const owner = x.owner as DomainModule;
      const part = participants.find((q) => moduleRefDigest(q.module) === moduleRefDigest(owner.ref)) as ParticipantProjection;
      const evidence = { states: part.states, reservations: part.reservations };
      if (part.foreignPending.length > 0) {
        // Unresolved reservations in its domain under another ModuleRef: its view of the domain is incomplete.
        result(x, { kind: 'MODULE', module: owner.ref }, { outcome: 'UNKNOWN', reason: 'PENDING_UNDER_OTHER_MODULE', observed: null, bound: null, ...evidence });
        continue;
      }
      const frozen = frozenCopy(part.projection);
      const e = callModule(owner, 'INVARIANT_UNKNOWN', `invariants.${x.term.invariantId}`, () => owner.evaluateInvariant(x.term, frozen));
      const checked = e.ok ? checkEvaluation(owner, e.value, `invariants.${x.term.invariantId}`) : e;
      if (!checked.ok) result(x, { kind: 'MODULE', module: owner.ref }, { outcome: 'UNKNOWN', reason: checked.error.reason, observed: null, bound: null, ...evidence });
      else result(x, { kind: 'MODULE', module: owner.ref }, { ...checked.value, ...evidence });
    }
  }
  return ok({ admissions: admissions.value, participants, projection: record, projectionDigest: digest, results, actingProjection: actingProjection as ModuleProjection });
}

// --- The decision ----------------------------------------------------------------

export interface Decision {
  readonly principal: LedgerSnapshot['principal'];
  /** The snapshot the whole decision was computed from. */
  readonly ledgerVersion: LedgerVersion;
  readonly ledgerHead: LedgerHeadDigest;
  readonly evaluatedAt: bigint;
  readonly context: ContextDigest;
  readonly action: ActionEnvelope;
  readonly actionId: ActionId;
  readonly generation: ReservationGeneration;
  readonly module: ModuleRef;
  readonly implementation: ImplementationDigest;
  readonly analysis: ActionAnalysis;
  /** Leaf to root. */
  readonly lineage: readonly AuthorityId[];
  readonly policy: PrincipalPolicyId;
  readonly effective: EffectiveAuthority;
  readonly admissions: readonly Admission[];
  /** Canonical order. */
  readonly bindings: readonly StateBinding[];
  readonly projection: ProjectionRecord;
  readonly projectionDigest: ProjectionDigest;
  readonly invariants: readonly InvariantResult[];
  readonly invariantResultsDigest: InvariantResultsDigest;
  readonly demands: readonly LedgerDemand[];
  readonly plan: ChargePlan;
  readonly planDigest: ChargePlanDigest;
  /** The `RESERVE` the ledger derived for the plan against this snapshot. */
  readonly event: Extract<LedgerEvent, { kind: 'RESERVE' }>;
  /** The earliest end of every dependency (brief §33). */
  readonly validUntil: bigint;
}

export function chargePlanDigest(plan: ChargePlan): ChargePlanDigest {
  const w = controlWriter(ControlTag.CHARGE_PLAN);
  writeChargePlan(w, plan);
  return controlDigest<ChargePlanDigest>(w);
}

/**
 * An authorization cannot outlive anything it depends on: the action's
 * expiry, every lineage node's, the module's own cap, and every binding
 * whose dependency must still hold at execution by expiring with its state
 * (`BOUNDED_BY_FRESHNESS`: `min(observedAt + maxAge, validUntil)`,
 * action-state-model.md §5.5). Bindings enforced by an artifact field, or
 * needed pre-trade only, are re-admitted at issue instead (§10a).
 */
export function authorizationLifetime(action: ActionEnvelope, effective: EffectiveAuthority, analysis: ActionAnalysis, bindings: readonly StateBinding[]): bigint {
  let end = action.expiresAt < effective.validity.expiresAt ? action.expiresAt : effective.validity.expiresAt;
  if (analysis.validUntil !== null && analysis.validUntil < end) end = analysis.validUntil;
  return bindingLifetime(bindings, end);
}

/** `end`, shortened to the earliest `BOUNDED_BY_FRESHNESS` expiry among `bindings`. */
export function bindingLifetime(bindings: readonly StateBinding[], end: bigint): bigint {
  let out = end;
  for (const b of bindings) {
    if (b.requirement.atExecution.kind !== 'BOUNDED_BY_FRESHNESS') continue;
    const f = b.requirement.freshness;
    if (f.kind === 'AGE' || f.kind === 'VERSION') {
      const stale = b.observedAt + f.maxAgeSeconds;
      if (stale < out) out = stale;
    }
    if (b.validUntil !== null && b.validUntil < out) out = b.validUntil;
  }
  return out;
}

/** Validate the request's own shape: a well-formed envelope, payload bytes and an explicit generation. */
function checkRequest(request: AuthorizationRequest): ControlResult<{ action: ActionEnvelope; payload: Uint8Array; generation: ReservationGeneration }> {
  if (typeof request !== 'object' || request === null) return refuse('REQUEST_INVALID', 'WRONG_TYPE', 'request');
  let action: ActionEnvelope;
  try {
    const v = validateActionEnvelope(actionEnvelopeInputOf(request.action), 'request.action');
    if (!v.ok) return refuse('REQUEST_INVALID', v.error.code, v.error.path);
    action = v.value;
  } catch {
    return refuse('REQUEST_INVALID', 'WRONG_TYPE', 'request.action');
  }
  if (!(request.payload instanceof Uint8Array)) return refuse('REQUEST_INVALID', 'WRONG_TYPE', 'request.payload');
  const generation = parseReservationGeneration(request.generation, 'request.generation');
  if (!generation.ok) return refuse('REQUEST_INVALID', generation.error.code, generation.error.path);
  return ok({ action, payload: new Uint8Array(request.payload), generation: generation.value });
}

export interface ResolvedAuthority {
  readonly lineage: readonly NodeRecord[];
  readonly effective: EffectiveAuthority;
}

/** Principal, lineage validity at `t`, actor = holder, and the meet. */
export function resolveAuthority(snapshot: LedgerSnapshot, action: ActionEnvelope, t: bigint): ControlResult<ResolvedAuthority> {
  const s = snapshot.state;
  if (!partyIdsEqual(action.principal, snapshot.principal)) return refuse('AUTHORITY_INVALID', 'PRINCIPAL_MISMATCH', 'action.principal');
  if (s.policy === null) return refuse('AUTHORITY_INVALID', 'PRINCIPAL_POLICY_MISSING', 'action.principal');
  const lineage = resolveLineage(s, action.authority, 'action.authority');
  if (!lineage.ok) return { ok: false, error: fromLedger(lineage.error, '') };
  const valid = checkLineageValid(s, lineage.value, t, 'action.authority');
  if (!valid.ok) return { ok: false, error: fromLedger(valid.error, '') };
  const leaf = lineage.value[0] as NodeRecord;
  if (!partyIdsEqual(action.actor, leaf.grant.holder)) return refuse('AUTHORITY_INVALID', 'ACTOR_NOT_HOLDER', 'action.actor');
  const effective = effectiveAuthority(lineage.value, s.policy.policy, 'action.authority', s.policy.bindings);
  if (!effective.ok) return { ok: false, error: fromLedger(effective.error, '') };
  return ok({ lineage: lineage.value, effective: effective.value });
}

export function decideWith(p: Pipeline, snapshot: LedgerSnapshot, request: AuthorizationRequest, env: DecisionEnv): ControlResult<Decision> {
  const ctx = validateEvaluationContext(request.context);
  if (!ctx.ok) return ctx;
  const t = ctx.value.evaluationTime;
  const req = checkRequest(request);
  if (!req.ok) return req;
  const { action, payload, generation } = req.value;

  // 1. the exact module; never a fallback
  const acting = env.catalog.resolveForDecision(action.module);
  if (!acting.ok) return acting;
  const module = acting.value;

  // 2. the action itself
  const digest = actionPayloadDigest(action.module, payload);
  if (!digest.ok) return refuse('ACTION_INVALID', digest.error.code, 'request.payload');
  if (digest.value !== action.payloadDigest) return refuse('ACTION_INVALID', 'PAYLOAD_DIGEST_MISMATCH', 'request.payload');
  if (t < action.validFrom) return refuse('ACTION_INVALID', 'ACTION_NOT_YET_VALID', 'action.validFrom');
  if (t >= action.expiresAt) return refuse('ACTION_INVALID', 'ACTION_EXPIRED', 'action.expiresAt');

  // 3. the authority
  const authority = resolveAuthority(snapshot, action, t);
  if (!authority.ok) return authority;
  const { lineage, effective } = authority.value;

  // 4. the module's reading of the action, and coverage over the meet
  const id = actionId(action);
  const context: ActionContext = frozenCopy({ envelope: action, actionId: id, payload });
  const analysis = callModule(module, 'ACTION_INVALID', 'module.validateAction', () => module.validateAction(context));
  if (!analysis.ok) return analysis;
  const checkedAnalysis = checkAnalysis(module, analysis.value, context, 'module.validateAction');
  if (!checkedAnalysis.ok) return checkedAnalysis;
  const coverage = checkCoverage(effective, action, checkedAnalysis.value, t);
  if (!coverage.ok) return coverage;

  // 5–11. state, projection, invariants
  const prepared = prepareStates(request.states, 'request.states');
  if (!prepared.ok) return prepared;
  const scoped: ScopedAction = frozenCopy({ ...context, mode: 'PROPOSE' as ProjectionMode });
  const evaluation = evaluateState(p, { snapshot, effective, acting: module, action: scoped, prepared: prepared.value, ctx: ctx.value, catalog: env.catalog });
  if (!evaluation.ok) return evaluation;
  const verdict = invariantVerdict(evaluation.value.results);
  if (!verdict.ok) return verdict;

  // 12. demand → charge plan; the module never names a target
  const actingProjection = frozenCopy(evaluation.value.actingProjection);
  const demands = callModule(module, 'DEMAND_INVALID', 'module.deriveLedgerDemands', () => module.deriveLedgerDemands(context, actingProjection));
  if (!demands.ok) return demands;
  const checkedDemands = checkDemands(module, demands.value, context, 'module.deriveLedgerDemands');
  if (!checkedDemands.ok) return checkedDemands;
  const plan = validateChargePlan({
    principal: partyIdInputOf(action.principal),
    authority: action.authority,
    actor: partyIdInputOf(action.actor),
    action: id,
    generation,
    module: moduleRefInputOf(module.ref),
    implementation: module.implementation,
    contributions: checkedDemands.value.map((d) => ({
      quantity: quantityInputOf(d.quantity),
      market: d.market === null ? null : resourceIdInputOf(d.market),
      account: d.account === null ? null : resourceIdInputOf(d.account),
      required: d.required,
    })),
  });
  if (!plan.ok) return { ok: false, error: fromLedger(plan.error, 'plan') };
  const conformance = checkModuleConformance(env.registry, plan.value.module, plan.value.implementation);
  if (!conformance.ok) return { ok: false, error: fromLedger(conformance.error, '') };

  // 13. the ledger derives the whole charging path and checks it against this snapshot
  const event = deriveReserveEvent(snapshot.state, plan.value, t);
  if (!event.ok) return { ok: false, error: fromLedger(event.error, '') };
  const applied = applyBatch(snapshot.state, [event.value], env.rules);
  if (!applied.ok) return { ok: false, error: fromLedger(applied.error, '') };

  // 14. lifetime
  const bindings = sortCanonical(
    evaluation.value.admissions.map((a) => a.binding),
    writeStateBinding,
  );
  const validUntil = authorizationLifetime(action, effective, checkedAnalysis.value, bindings);
  if (validUntil <= t) return refuse('AUTHORIZATION_EXPIRED', 'LIFETIME_EMPTY', 'validUntil');

  return ok({
    principal: snapshot.principal,
    ledgerVersion: snapshot.version,
    ledgerHead: snapshot.head,
    evaluatedAt: t,
    context: ctx.value.digest,
    action,
    actionId: id,
    generation,
    module: module.ref,
    implementation: module.implementation,
    analysis: checkedAnalysis.value,
    lineage: lineage.map((n) => n.id),
    policy: (snapshot.state.policy as NonNullable<LedgerState['policy']>).id,
    effective,
    admissions: evaluation.value.admissions,
    bindings,
    projection: evaluation.value.projection,
    projectionDigest: evaluation.value.projectionDigest,
    invariants: evaluation.value.results,
    invariantResultsDigest: invariantResultsDigest(evaluation.value.results),
    demands: checkedDemands.value,
    plan: plan.value,
    planDigest: chargePlanDigest(plan.value),
    event: event.value,
    validUntil,
  });
}

/** The production decision. */
export function decide(snapshot: LedgerSnapshot, request: AuthorizationRequest, env: DecisionEnv): ControlResult<Decision> {
  return decideWith(PRODUCTION_PIPELINE, snapshot, request, env);
}
