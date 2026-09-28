/**
 * The executable `DomainModule` interface (action-state-model.md §8; DOM-1,
 * DOM-2, PROJ-1, SCOPE-1).
 *
 * A domain module is the only component that knows what an action or a state
 * payload *means*. It is a pure semantic function over explicit inputs:
 *
 * ```text
 * validateAction(action)                 → resources, risk direction, rights and bound values it needs
 * stateRequirements(scope)               → exactly the state it will read, per kind and subject
 * validateStatePayload(state)            → the payload parses under its declared schema
 * project(scope, admitted state)         → typed economic facts: held, pending (worst case), proposed
 * evaluateInvariant(invariant, projection) → HOLDS | VIOLATED | UNKNOWN, for invariants it owns
 * deriveLedgerDemands(action, projection)  → the typed quantities the action must reserve
 * noWeaker(parent, child)                → whether a child's invariant parameters are no weaker
 * ```
 *
 * What a module is deliberately **not** given: network access, wallet keys, a
 * clock, randomness, a database, the ledger, other modules' state, or any
 * state it did not declare. It receives the action, the admitted snapshots
 * it asked for and the unresolved reservations under its own `ModuleRef`, and
 * nothing else (brief §10: no state smuggling).
 *
 * What a module deliberately **cannot** do: authorize. It returns facts,
 * comparisons and demands; the control engine decides ALLOW or REFUSE after
 * every Core requirement, and the ledger decides which targets are charged. A
 * module has no way to name an ancestor, a dimension or a target (brief §20).
 *
 * Every module is bound to exactly one `ModuleRef` — domain, id, version and
 * digest — and one `ImplementationDigest`. The engine resolves an action's
 * `ModuleRef` to exactly that implementation or refuses; there is no
 * "latest" and no fallback (catalog.ts).
 *
 * Everything a module returns is re-validated by the engine (outputs.ts): a
 * module's bug or malice can only produce a refusal, never an authorization
 * a correct module would not produce and never a ledger write.
 */

import type {
  AccountId,
  ActionEnvelope,
  ActionId,
  AuthorityId,
  BoundId,
  BoundValue,
  CanonicalAssetRef,
  EconomicQuantity,
  FinalityLadderId,
  FinalityLevel,
  ImplementationDigest,
  InvariantId,
  InvariantVersion,
  LedgerVersion,
  MarketId,
  ModuleRef,
  PrincipalId,
  QuantityKind,
  Ratio,
  ReservationGeneration,
  ReservationId,
  ResourceId,
  Right,
  StateEnvelope,
  StateId,
  StateInvariantTerm,
  StateKind,
  StateRequirement,
  StateSourceId,
  UnitCode,
} from '@mandate/core';
import type { InvariantNarrowing } from '@mandate/ledger';
import type { ModuleResult } from './errors.ts';

// --- Actions ---------------------------------------------------------------------

/** An action as a module sees it: the envelope, its identity and the payload bytes the envelope's digest commits to. */
export interface ActionContext {
  readonly envelope: ActionEnvelope;
  readonly actionId: ActionId;
  readonly payload: Uint8Array;
}

/** Derived by the module from the payload; never declared by the agent (action-state-model.md §4.1). MIXED is INCREASING. */
export type RiskDirection = 'INCREASING' | 'REDUCING' | 'NEUTRAL';

export type ActionRight = Exclude<Right, 'DELEGATE'>;

/** The action's own value for one per-action bound (authority-model.md §3, "per-action bound"). */
export interface BoundObservation {
  readonly boundId: BoundId;
  readonly value: BoundValue;
}

export interface ActionAnalysis {
  /** Recomputed from the payload; must equal the envelope's (ACTION_RESOURCES_MISMATCH otherwise). */
  readonly target: ResourceId;
  readonly resources: readonly ResourceId[];
  readonly riskDirection: RiskDirection;
  /** Rights the action exercises. Coverage requires each in the effective authority. */
  readonly requiredRights: readonly ActionRight[];
  /** The action's value for every bound it defines. An effective bound the module reports no value for refuses. */
  readonly bounds: readonly BoundObservation[];
  /** A module-specific cap on the authorization's lifetime, or `null` for none. */
  readonly validUntil: bigint | null;
}

// --- State -----------------------------------------------------------------------

/**
 * One state dependency: which kind, about which subject, from which sources,
 * under which requirement. The requirement is the module's default; the
 * engine tightens it with every lineage node's and the principal policy's
 * state policy for the same `(domain, stateKind)` (action-state-model.md
 * §5.4). Core does not interpret `stateKind` or `subject`: the module does.
 */
export interface StateNeed {
  readonly stateKind: StateKind;
  readonly subject: ResourceId;
  /** Configured sources the module accepts for this kind. Empty admits nothing. */
  readonly admittedSources: readonly StateSourceId[];
  readonly requirement: StateRequirement;
}

/** An admitted snapshot, with the payload its envelope's digest commits to. */
export interface AdmittedState {
  readonly envelope: StateEnvelope;
  readonly stateId: StateId;
  readonly payload: Uint8Array;
}

/** A finality ladder the module declares, lowest level first. Only its declarer orders it. */
export interface FinalityLadder {
  readonly ladder: FinalityLadderId;
  readonly levels: readonly FinalityLevel[];
}

// --- Reservations ----------------------------------------------------------------

/** One reserved contribution of an unresolved reservation, as the ledger recorded it. */
export interface ReservationEffect {
  /** The worst case reserved at authorization. */
  readonly quantity: EconomicQuantity;
  readonly market: MarketId | null;
  readonly account: AccountId | null;
  /** Already consumed, at the quantity's decimals. */
  readonly consumed: bigint;
}

/**
 * An unresolved reservation, normalized from the ledger (brief §13). A module
 * never reads the ledger: it receives these, and only those under its own
 * exact `ModuleRef`. Every fact names its reservation and generation, so a
 * generation-`n` fact cannot stand for generation `n + 1` (RECON-2).
 */
export interface ReservationFact {
  readonly reservation: ReservationId;
  readonly generation: ReservationGeneration;
  readonly action: ActionId;
  readonly module: ModuleRef;
  readonly implementation: ImplementationDigest;
  /** Leaf to root. */
  readonly lineage: readonly AuthorityId[];
  readonly status: 'ACTIVE';
  readonly committedAt: LedgerVersion;
  readonly effects: readonly ReservationEffect[];
}

// --- Scope -----------------------------------------------------------------------

/**
 * A Core aggregate the module contributes to: its part of `kind` in `unit`
 * for canonical `asset`, over the listed accounts in its domain.
 */
export interface AggregateQuery {
  readonly kind: QuantityKind;
  readonly unit: UnitCode;
  readonly asset: CanonicalAssetRef;
  readonly accounts: readonly AccountId[];
}

/**
 * Proposal: the action is not yet reserved, and its effect is projected as
 * `PROPOSED`. Revalidation: its own reservation is already among the pending
 * facts, and it is not added again (reservations-reconciliation.md §10a).
 */
export type ProjectionMode = 'PROPOSE' | 'REVALIDATE';

export interface ScopedAction extends ActionContext {
  readonly mode: ProjectionMode;
}

/** Everything a module is asked to account for in one decision, and nothing more. */
export interface ModuleScope {
  readonly principal: PrincipalId;
  /** Only the acting module has an action. */
  readonly action: ScopedAction | null;
  /** Invariants this module owns that apply to the decision. */
  readonly invariants: readonly StateInvariantTerm[];
  readonly aggregates: readonly AggregateQuery[];
  /** Every unresolved reservation of the principal under exactly this `ModuleRef`. */
  readonly reservations: readonly ReservationFact[];
}

// --- Projection ------------------------------------------------------------------

/** Where a fact comes from: held (admitted state), pending (unresolved reservations, worst case), proposed (this action). */
export type FactComponent = 'HELD' | 'PENDING' | 'PROPOSED';

/**
 * A standardized economic fact (brief §14): a typed Core quantity — so kind,
 * unit, decimals, asset and valuation — plus scope and provenance. Facts are
 * components, never totals: an aggregate sums them, so a module that also
 * emitted a total would double count.
 */
export interface EconomicFact {
  readonly component: FactComponent;
  readonly quantity: EconomicQuantity;
  readonly market: MarketId | null;
  readonly account: AccountId | null;
  /** Admitted snapshots it was derived from. A `HELD` fact names at least one. */
  readonly states: readonly StateId[];
  /** Reservations it was derived from. A `PENDING` fact names at least one. */
  readonly reservations: readonly ReservationId[];
}

/**
 * A typed value with no floating point. `TOTAL` is a typed sum of parts, its
 * valuation carried by the evidence rather than the value: a module's own
 * total, or Core's principal-global aggregate, whose marked parts must share
 * one admitted valuation context (7D.1, aggregate.ts) named by the snapshots
 * the result cites.
 */
export type Measure =
  | { readonly type: 'QUANTITY'; readonly quantity: EconomicQuantity }
  | { readonly type: 'RATIO'; readonly ratio: Ratio }
  | { readonly type: 'TOTAL'; readonly kind: QuantityKind; readonly unit: UnitCode; readonly decimals: number; readonly atoms: bigint }
  | { readonly type: 'FLAG'; readonly value: boolean };

/**
 * A module-owned fact whose meaning is bound by the module's `ModuleRef`:
 * account leverage, a health factor, an option's delta. Core never compares
 * two modules' invariant facts.
 */
export interface InvariantFact {
  /** An identifier in the module's own vocabulary. */
  readonly factId: string;
  readonly subject: ResourceId | null;
  readonly value: Measure;
  readonly states: readonly StateId[];
  readonly reservations: readonly ReservationId[];
}

export interface ModuleProjection {
  readonly facts: readonly EconomicFact[];
  readonly invariantFacts: readonly InvariantFact[];
  /** Every resource the projection concerns. */
  readonly resources: readonly ResourceId[];
  /** The worst-case assumptions the projection made, as identifiers in the module's vocabulary (PROJ-1). */
  readonly assumptions: readonly string[];
  /** The module's own canonical bytes for anything else it projected; opaque to Core, digested into the projection. */
  readonly payload: Uint8Array;
}

// --- Invariants, demands, narrowing ----------------------------------------------

export type InvariantOutcome = 'HOLDS' | 'VIOLATED' | 'UNKNOWN';

export interface InvariantEvaluation {
  readonly outcome: InvariantOutcome;
  /** An identifier in the module's vocabulary; an `UNKNOWN` names what was missing. */
  readonly reason: string;
  readonly observed: Measure | null;
  readonly bound: Measure | null;
}

/** An invariant definition a module ships (action-state-model.md §7). */
export interface InvariantDefinitionRef {
  readonly invariantId: InvariantId;
  readonly version: InvariantVersion;
}

/**
 * A quantitative authority demand. It says *what* the action needs, never
 * *where* to charge it: the ledger derives every charged target from the
 * lineage and the principal policy.
 */
export interface LedgerDemand {
  readonly quantity: EconomicQuantity;
  readonly market: MarketId | null;
  readonly account: AccountId | null;
  /** Must match a dimension granted on the lineage (LEDGER-5). */
  readonly required: boolean;
}

/** A measure the module may demand. A demand in any other measure is refused. */
export interface DemandMeasure {
  readonly kind: QuantityKind;
  readonly unit: UnitCode;
}

export interface DomainModule {
  readonly ref: ModuleRef;
  readonly implementation: ImplementationDigest;
  readonly invariants: readonly InvariantDefinitionRef[];
  readonly finalityLadders: readonly FinalityLadder[];
  readonly demandMeasures: readonly DemandMeasure[];

  validateAction(action: ActionContext): ModuleResult<ActionAnalysis>;
  stateRequirements(scope: ModuleScope): ModuleResult<readonly StateNeed[]>;
  validateStatePayload(state: AdmittedState): ModuleResult<true>;
  project(scope: ModuleScope, states: readonly AdmittedState[]): ModuleResult<ModuleProjection>;
  evaluateInvariant(invariant: StateInvariantTerm, projection: ModuleProjection): ModuleResult<InvariantEvaluation>;
  deriveLedgerDemands(action: ActionContext, projection: ModuleProjection): ModuleResult<readonly LedgerDemand[]>;
  noWeaker(parent: StateInvariantTerm, child: StateInvariantTerm): ModuleResult<InvariantNarrowing>;
}

export const DOMAIN_MODULE_FUNCTIONS = [
  'validateAction',
  'stateRequirements',
  'validateStatePayload',
  'project',
  'evaluateInvariant',
  'deriveLedgerDemands',
  'noWeaker',
] as const;
