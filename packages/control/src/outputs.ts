/**
 * Re-validation of everything a domain module returns (brief §48).
 *
 * A module is trusted to define semantics, not to produce well-formed Core
 * objects. Its outputs are TypeScript values the engine did not construct, so
 * every one is taken apart into its input form and rebuilt through Core's
 * validators: a quantity with a `NaN`, a negative unsigned amount, a mark
 * relabelled as a limit, an unknown resource kind, a requirement Core would
 * refuse — each becomes a refusal naming the module, never an authorization
 * and never a ledger write. A module that throws is refused the same way.
 *
 * Provenance is checked here too: a fact may cite only snapshots admitted to
 * that module and reservations in its scope, a `MARK` valuation must price
 * from an admitted snapshot, and a `PENDING` fact must name the reservation
 * it projects. A module cannot smuggle in state it was not given (brief §10).
 */

import { ok, type Identifier } from '@mandate/kernel';
import {
  QUANTITY_KIND_RULES,
  RESOURCE_KINDS,
  compareBytes,
  encodeWith,
  parseDecimals,
  parseIdentifierAs,
  parseQuantityKind,
  parseUnitCode,
  quantityBoundInputOf,
  quantityInputOf,
  resourceIdInputOf,
  stateRequirementInputOf,
  validateQuantity,
  validateQuantityBound,
  validateRatio,
  validateResourceId,
  validateStateRequirement,
  writeResourceId,
  type ActionId,
  type BoundId,
  type BoundValue,
  type CoreResult,
  type EconomicQuantity,
  type ReservationId,
  type ResourceId,
  type ResourceKind,
  type StateId,
  type StateKind,
  type StateSourceId,
} from '@mandate/core';
import type { InvariantNarrowing } from '@mandate/ledger';
import { refuse, type ControlCode, type ControlResult, type ModuleResult } from './errors.ts';
import {
  MAX_ASSUMPTIONS,
  MAX_DEMANDS,
  MAX_INVARIANT_FACTS,
  MAX_PROJECTION_FACTS,
  MAX_PROJECTION_PAYLOAD_BYTES,
  MAX_PROJECTION_RESOURCES,
  MAX_REQUIREMENTS,
} from './limits.ts';
import type {
  ActionAnalysis,
  ActionContext,
  ActionRight,
  BoundObservation,
  DomainModule,
  EconomicFact,
  FactComponent,
  InvariantEvaluation,
  InvariantFact,
  LedgerDemand,
  Measure,
  ModuleProjection,
  ModuleScope,
  RiskDirection,
  StateNeed,
} from './module.ts';

// --- Calling a module ------------------------------------------------------------

/**
 * Call a module function, turning a throw or a malformed result into a
 * refusal, and a module-reported failure into `code` in the module's
 * namespace.
 */
export function callModule<T>(module: DomainModule, code: ControlCode, path: string, call: () => ModuleResult<T>): ControlResult<T> {
  let r: ModuleResult<T>;
  try {
    r = call();
  } catch {
    return refuse('MODULE_NOT_CONFORMING', 'MODULE_FAULT', path, { origin: 'MODULE', module: module.ref });
  }
  if (typeof r !== 'object' || r === null || typeof r.ok !== 'boolean') {
    return refuse('MODULE_NOT_CONFORMING', 'MODULE_RESULT_MALFORMED', path, { origin: 'MODULE', module: module.ref });
  }
  if (!r.ok) {
    const raw: string = typeof r.error === 'object' && r.error !== null && typeof r.error.reason === 'string' ? r.error.reason : '';
    const reason = parseIdentifierAs<Identifier>(raw, 'reason');
    const sub = typeof r.error === 'object' && r.error !== null && typeof r.error.path === 'string' && r.error.path !== '' ? `.${r.error.path}` : '';
    return refuse(code, reason.ok ? reason.value : 'UNSPECIFIED', `${path}${sub}`, { origin: 'MODULE', module: module.ref });
  }
  return ok(r.value);
}

function bad(module: DomainModule, path: string, reason = 'MODULE_OUTPUT_INVALID'): ControlResult<never> {
  return refuse('MODULE_NOT_CONFORMING', reason, path, { origin: 'MODULE', module: module.ref });
}

function checked<T>(module: DomainModule, path: string, f: () => CoreResult<T>): ControlResult<T> {
  let r: CoreResult<T>;
  try {
    r = f();
  } catch {
    return bad(module, path);
  }
  return r.ok ? r : bad(module, `${path}:${r.error.path}`, r.error.code);
}

function isArray(x: object): x is readonly object[] {
  return Array.isArray(x);
}

function list<T>(module: DomainModule, raw: readonly T[], max: number, path: string): ControlResult<readonly T[]> {
  if (typeof raw !== 'object' || raw === null || !isArray(raw)) return bad(module, path, 'MODULE_OUTPUT_NOT_A_LIST');
  if (raw.length > max) return refuse('RESOURCE_BOUND_EXCEEDED', 'MODULE_OUTPUT_TOO_LARGE', path, { origin: 'MODULE', module: module.ref });
  return ok(raw);
}

function oneOf<T extends string>(module: DomainModule, raw: T, values: readonly T[], path: string): ControlResult<T> {
  return values.includes(raw) ? ok(raw) : bad(module, path);
}

// --- Primitive outputs -----------------------------------------------------------

export function checkQuantity(module: DomainModule, q: EconomicQuantity, path: string): ControlResult<EconomicQuantity> {
  return checked(module, path, () => validateQuantity(quantityInputOf(q), path));
}

export function checkResource<K extends ResourceKind>(module: DomainModule, r: ResourceId<K>, kinds: readonly K[], path: string): ControlResult<ResourceId<K>> {
  if (typeof r !== 'object' || r === null) return bad(module, path);
  return checked(module, path, () => validateResourceId(resourceIdInputOf(r), kinds, path));
}

function checkNullableResource<K extends ResourceKind>(module: DomainModule, r: ResourceId<K> | null, kinds: readonly K[], path: string): ControlResult<ResourceId<K> | null> {
  return r === null ? ok(null) : checkResource(module, r, kinds, path);
}

function checkIdentifier(module: DomainModule, raw: string, path: string): ControlResult<string> {
  return checked(module, path, () => parseIdentifierAs<Identifier>(raw, path));
}

export function checkMeasure(module: DomainModule, m: Measure, path: string): ControlResult<Measure> {
  if (typeof m !== 'object' || m === null) return bad(module, path);
  switch (m.type) {
    case 'QUANTITY': {
      const q = checkQuantity(module, m.quantity, `${path}.quantity`);
      return q.ok ? ok({ type: 'QUANTITY', quantity: q.value }) : q;
    }
    case 'RATIO': {
      const r = checked(module, path, () => validateRatio({ numerator: m.ratio.numerator, scale: m.ratio.scale }, path));
      return r.ok ? ok({ type: 'RATIO', ratio: r.value }) : r;
    }
    case 'TOTAL': {
      const kind = checked(module, path, () => parseQuantityKind(m.kind, `${path}.kind`));
      if (!kind.ok) return kind;
      const unit = checked(module, path, () => parseUnitCode(m.unit, `${path}.unit`));
      if (!unit.ok) return unit;
      const decimals = checked(module, path, () => parseDecimals(m.decimals, `${path}.decimals`));
      if (!decimals.ok) return decimals;
      if (typeof m.atoms !== 'bigint') return bad(module, `${path}.atoms`);
      return ok({ type: 'TOTAL', kind: kind.value, unit: unit.value, decimals: decimals.value, atoms: m.atoms });
    }
    case 'FLAG':
      return typeof m.value === 'boolean' ? ok({ type: 'FLAG', value: m.value }) : bad(module, `${path}.value`);
    default:
      return bad(module, `${path}.type`);
  }
}

function checkNullableMeasure(module: DomainModule, m: Measure | null, path: string): ControlResult<Measure | null> {
  return m === null ? ok(null) : checkMeasure(module, m, path);
}

function sameResourceSet(a: readonly ResourceId[], b: readonly ResourceId[]): boolean {
  if (a.length !== b.length) return false;
  const enc = (xs: readonly ResourceId[]): Uint8Array[] => xs.map((x) => encodeWith(writeResourceId, x)).sort(compareBytes);
  const x = enc(a);
  const y = enc(b);
  return x.every((v, i) => compareBytes(v, y[i] as Uint8Array) === 0);
}

// --- Action analysis -------------------------------------------------------------

const RISK_DIRECTIONS: readonly RiskDirection[] = ['INCREASING', 'REDUCING', 'NEUTRAL'];
const ACTION_RIGHTS: readonly ActionRight[] = ['OPEN_RISK', 'REDUCE_RISK', 'TRANSFER_OUT'];

function checkBoundValue(module: DomainModule, v: BoundValue, path: string): ControlResult<BoundValue> {
  if (typeof v !== 'object' || v === null) return bad(module, path);
  if (v.type === 'QUANTITY') {
    const q = checked(module, path, () => validateQuantityBound(quantityBoundInputOf(v.quantity), path));
    return q.ok ? ok({ type: 'QUANTITY', quantity: q.value }) : q;
  }
  if (v.type === 'RATIO') {
    const r = checked(module, path, () => validateRatio({ numerator: v.ratio.numerator, scale: v.ratio.scale }, path));
    return r.ok ? ok({ type: 'RATIO', ratio: r.value }) : r;
  }
  return bad(module, `${path}.type`);
}

export function checkAnalysis(module: DomainModule, a: ActionAnalysis, action: ActionContext, path: string): ControlResult<ActionAnalysis> {
  if (typeof a !== 'object' || a === null) return bad(module, path);
  const target = checkResource(module, a.target, RESOURCE_KINDS, `${path}.target`);
  if (!target.ok) return target;
  const rawResources = list(module, a.resources, MAX_PROJECTION_RESOURCES, `${path}.resources`);
  if (!rawResources.ok) return rawResources;
  const resources: ResourceId[] = [];
  for (let i = 0; i < rawResources.value.length; i += 1) {
    const r = checkResource(module, rawResources.value[i] as ResourceId, RESOURCE_KINDS, `${path}.resources[${i}]`);
    if (!r.ok) return r;
    resources.push(r.value);
  }
  // The module recomputes target and resources from the payload; the envelope's must agree (action-state-model.md §4.1).
  if (!sameResourceSet([target.value], [action.envelope.target]) || !sameResourceSet(resources, action.envelope.resources)) {
    return refuse('ACTION_INVALID', 'ACTION_RESOURCES_MISMATCH', `${path}.resources`, { module: module.ref });
  }
  const risk = oneOf(module, a.riskDirection, RISK_DIRECTIONS, `${path}.riskDirection`);
  if (!risk.ok) return risk;
  const rights = list(module, a.requiredRights, ACTION_RIGHTS.length, `${path}.requiredRights`);
  if (!rights.ok) return rights;
  for (let i = 0; i < rights.value.length; i += 1) {
    const r = oneOf(module, rights.value[i] as ActionRight, ACTION_RIGHTS, `${path}.requiredRights[${i}]`);
    if (!r.ok) return r;
  }
  if (new Set(rights.value).size !== rights.value.length) return bad(module, `${path}.requiredRights`, 'DUPLICATE_RIGHT');
  const rawBounds = list(module, a.bounds, MAX_PROJECTION_RESOURCES, `${path}.bounds`);
  if (!rawBounds.ok) return rawBounds;
  const bounds: BoundObservation[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawBounds.value.length; i += 1) {
    const b = rawBounds.value[i] as BoundObservation;
    const bp = `${path}.bounds[${i}]`;
    if (typeof b !== 'object' || b === null) return bad(module, bp);
    const id = checked(module, bp, () => parseIdentifierAs<BoundId>(b.boundId, `${bp}.boundId`));
    if (!id.ok) return id;
    if (seen.has(id.value)) return bad(module, bp, 'DUPLICATE_BOUND');
    seen.add(id.value);
    const value = checkBoundValue(module, b.value, `${bp}.value`);
    if (!value.ok) return value;
    bounds.push({ boundId: id.value, value: value.value });
  }
  if (a.validUntil !== null && typeof a.validUntil !== 'bigint') return bad(module, `${path}.validUntil`);
  return ok({ target: target.value, resources, riskDirection: risk.value, requiredRights: [...rights.value], bounds, validUntil: a.validUntil });
}

// --- State needs -----------------------------------------------------------------

export function checkNeeds(module: DomainModule, raw: readonly StateNeed[], path: string): ControlResult<readonly StateNeed[]> {
  const needs = list(module, raw, MAX_REQUIREMENTS, path);
  if (!needs.ok) return needs;
  const out: StateNeed[] = [];
  for (let i = 0; i < needs.value.length; i += 1) {
    const n = needs.value[i] as StateNeed;
    const np = `${path}[${i}]`;
    if (typeof n !== 'object' || n === null) return bad(module, np);
    const stateKind = checked(module, np, () => parseIdentifierAs<StateKind>(n.stateKind, `${np}.stateKind`));
    if (!stateKind.ok) return stateKind;
    const subject = checkResource(module, n.subject, RESOURCE_KINDS, `${np}.subject`);
    if (!subject.ok) return subject;
    const rawSources = list(module, n.admittedSources, 32, `${np}.admittedSources`);
    if (!rawSources.ok) return rawSources;
    const sources: StateSourceId[] = [];
    for (let j = 0; j < rawSources.value.length; j += 1) {
      const s = checked(module, np, () => parseIdentifierAs<StateSourceId>(rawSources.value[j] as string, `${np}.admittedSources[${j}]`));
      if (!s.ok) return s;
      if (!sources.includes(s.value)) sources.push(s.value);
    }
    sources.sort();
    if (typeof n.requirement !== 'object' || n.requirement === null) return bad(module, `${np}.requirement`);
    const requirement = checked(module, np, () => validateStateRequirement(stateRequirementInputOf(n.requirement), `${np}.requirement`));
    if (!requirement.ok) return requirement;
    // A finality level is only comparable on a ladder the module declares.
    const f = requirement.value.minFinality;
    const ladder = module.finalityLadders.find((l) => l.ladder === f.ladder);
    if (ladder === undefined || !ladder.levels.includes(f.level)) return bad(module, `${np}.requirement.minFinality`, 'FINALITY_LADDER_UNDECLARED');
    out.push({ stateKind: stateKind.value, subject: subject.value, admittedSources: sources, requirement: requirement.value });
  }
  return ok(out);
}

// --- Projection ------------------------------------------------------------------

const COMPONENTS: readonly FactComponent[] = ['HELD', 'PENDING', 'PROPOSED'];

interface Provenance {
  readonly states: ReadonlySet<StateId>;
  readonly reservations: ReadonlySet<ReservationId>;
  /** Actions whose own limit price a `LIMIT` valuation may cite: this action and every pending one in scope. */
  readonly actions: ReadonlySet<ActionId>;
}

function checkProvenance(module: DomainModule, states: readonly StateId[], reservations: readonly ReservationId[], p: Provenance, path: string): ControlResult<{ states: StateId[]; reservations: ReservationId[] }> {
  const s = list(module, states, MAX_REQUIREMENTS, `${path}.states`);
  if (!s.ok) return s;
  const r = list(module, reservations, MAX_PROJECTION_FACTS, `${path}.reservations`);
  if (!r.ok) return r;
  for (const id of s.value) if (!p.states.has(id)) return bad(module, `${path}.states`, 'STATE_NOT_ADMITTED_TO_MODULE');
  for (const id of r.value) if (!p.reservations.has(id)) return bad(module, `${path}.reservations`, 'RESERVATION_NOT_IN_SCOPE');
  return ok({ states: [...new Set(s.value)].sort(), reservations: [...new Set(r.value)].sort() });
}

function checkValuationSource(module: DomainModule, q: EconomicQuantity, p: Provenance, path: string): ControlResult<true> {
  const v = q.valuation;
  if (v === null) return ok(true);
  switch (v.source.kind) {
    case 'STATE':
      return p.states.has(v.source.stateId) ? ok(true) : bad(module, `${path}.valuation.source`, 'VALUATION_STATE_NOT_ADMITTED');
    case 'ACTION':
      return p.actions.has(v.source.actionId) ? ok(true) : bad(module, `${path}.valuation.source`, 'VALUATION_ACTION_NOT_IN_SCOPE');
    case 'OBSERVATION':
      // No observation is applied before execution; a fill price here would be invented.
      return bad(module, `${path}.valuation.source`, 'VALUATION_OBSERVATION_UNAVAILABLE');
  }
}

export function checkProjection(module: DomainModule, p: ModuleProjection, scope: ModuleScope, admitted: readonly StateId[], path: string): ControlResult<ModuleProjection> {
  if (typeof p !== 'object' || p === null) return bad(module, path);
  const actions = new Set<ActionId>(scope.reservations.map((r) => r.action));
  if (scope.action !== null) actions.add(scope.action.actionId);
  const prov: Provenance = { states: new Set(admitted), reservations: new Set(scope.reservations.map((r) => r.reservation)), actions };
  const proposing = scope.action !== null && scope.action.mode === 'PROPOSE';

  const rawFacts = list(module, p.facts, MAX_PROJECTION_FACTS, `${path}.facts`);
  if (!rawFacts.ok) return rawFacts;
  const facts: EconomicFact[] = [];
  for (let i = 0; i < rawFacts.value.length; i += 1) {
    const f = rawFacts.value[i] as EconomicFact;
    const fp = `${path}.facts[${i}]`;
    if (typeof f !== 'object' || f === null) return bad(module, fp);
    const component = oneOf(module, f.component, COMPONENTS, `${fp}.component`);
    if (!component.ok) return component;
    if (component.value === 'PROPOSED' && !proposing) return bad(module, fp, 'PROPOSED_FACT_WITHOUT_PROPOSAL');
    const quantity = checkQuantity(module, f.quantity, `${fp}.quantity`);
    if (!quantity.ok) return quantity;
    const valuation = checkValuationSource(module, quantity.value, prov, `${fp}.quantity`);
    if (!valuation.ok) return valuation;
    const market = checkNullableResource(module, f.market, ['MARKET'] as const, `${fp}.market`);
    if (!market.ok) return market;
    const account = checkNullableResource(module, f.account, ['ACCOUNT'] as const, `${fp}.account`);
    if (!account.ok) return account;
    const pr = checkProvenance(module, f.states, f.reservations, prov, fp);
    if (!pr.ok) return pr;
    if (component.value === 'HELD' && pr.value.states.length === 0) return bad(module, fp, 'HELD_FACT_WITHOUT_STATE');
    if (component.value === 'PENDING' && pr.value.reservations.length === 0) return bad(module, fp, 'PENDING_FACT_WITHOUT_RESERVATION');
    facts.push({ component: component.value, quantity: quantity.value, market: market.value, account: account.value, states: pr.value.states, reservations: pr.value.reservations });
  }

  const rawInv = list(module, p.invariantFacts, MAX_INVARIANT_FACTS, `${path}.invariantFacts`);
  if (!rawInv.ok) return rawInv;
  const invariantFacts: InvariantFact[] = [];
  for (let i = 0; i < rawInv.value.length; i += 1) {
    const f = rawInv.value[i] as InvariantFact;
    const fp = `${path}.invariantFacts[${i}]`;
    if (typeof f !== 'object' || f === null) return bad(module, fp);
    const factId = checkIdentifier(module, f.factId, `${fp}.factId`);
    if (!factId.ok) return factId;
    const subject = checkNullableResource(module, f.subject, RESOURCE_KINDS, `${fp}.subject`);
    if (!subject.ok) return subject;
    const value = checkMeasure(module, f.value, `${fp}.value`);
    if (!value.ok) return value;
    if (value.value.type === 'QUANTITY') {
      const v = checkValuationSource(module, value.value.quantity, prov, `${fp}.value.quantity`);
      if (!v.ok) return v;
    }
    const pr = checkProvenance(module, f.states, f.reservations, prov, fp);
    if (!pr.ok) return pr;
    invariantFacts.push({ factId: factId.value, subject: subject.value, value: value.value, states: pr.value.states, reservations: pr.value.reservations });
  }

  const rawResources = list(module, p.resources, MAX_PROJECTION_RESOURCES, `${path}.resources`);
  if (!rawResources.ok) return rawResources;
  const resources: ResourceId[] = [];
  for (let i = 0; i < rawResources.value.length; i += 1) {
    const r = checkResource(module, rawResources.value[i] as ResourceId, RESOURCE_KINDS, `${path}.resources[${i}]`);
    if (!r.ok) return r;
    resources.push(r.value);
  }
  const rawAssumptions = list(module, p.assumptions, MAX_ASSUMPTIONS, `${path}.assumptions`);
  if (!rawAssumptions.ok) return rawAssumptions;
  const assumptions: string[] = [];
  for (let i = 0; i < rawAssumptions.value.length; i += 1) {
    const a = checkIdentifier(module, rawAssumptions.value[i] as string, `${path}.assumptions[${i}]`);
    if (!a.ok) return a;
    assumptions.push(a.value);
  }
  if (!(p.payload instanceof Uint8Array)) return bad(module, `${path}.payload`);
  if (p.payload.length > MAX_PROJECTION_PAYLOAD_BYTES) return refuse('RESOURCE_BOUND_EXCEEDED', 'MODULE_OUTPUT_TOO_LARGE', `${path}.payload`, { origin: 'MODULE', module: module.ref });
  return ok({ facts, invariantFacts, resources, assumptions, payload: new Uint8Array(p.payload) });
}

// --- Invariant evaluation --------------------------------------------------------

const OUTCOMES: readonly InvariantEvaluation['outcome'][] = ['HOLDS', 'VIOLATED', 'UNKNOWN'];

export function checkEvaluation(module: DomainModule, e: InvariantEvaluation, path: string): ControlResult<InvariantEvaluation> {
  if (typeof e !== 'object' || e === null) return bad(module, path);
  const outcome = oneOf(module, e.outcome, OUTCOMES, `${path}.outcome`);
  if (!outcome.ok) return outcome;
  const reason = checkIdentifier(module, e.reason, `${path}.reason`);
  if (!reason.ok) return reason;
  const observed = checkNullableMeasure(module, e.observed, `${path}.observed`);
  if (!observed.ok) return observed;
  const bound = checkNullableMeasure(module, e.bound, `${path}.bound`);
  if (!bound.ok) return bound;
  return ok({ outcome: outcome.value, reason: reason.value, observed: observed.value, bound: bound.value });
}

// --- Demands ---------------------------------------------------------------------

/**
 * A module's demands, checked against what the ledger may be asked to hold:
 * ledger-trackable, strictly positive, in a measure the module declared, and
 * — at authorization, before any fill — valued only at the action's own limit
 * price. A marked value is never a demand: marked exposure is an invariant,
 * not a counter (decision 10, Phase 7B.1 ruling 2).
 */
export function checkDemands(module: DomainModule, raw: readonly LedgerDemand[], action: ActionContext, path: string): ControlResult<readonly LedgerDemand[]> {
  const demands = list(module, raw, MAX_DEMANDS, path);
  if (!demands.ok) return demands;
  if (demands.value.length === 0) return refuse('DEMAND_INVALID', 'NO_DEMAND', path, { origin: 'MODULE', module: module.ref });
  const out: LedgerDemand[] = [];
  for (let i = 0; i < demands.value.length; i += 1) {
    const d = demands.value[i] as LedgerDemand;
    const dp = `${path}[${i}]`;
    if (typeof d !== 'object' || d === null) return bad(module, dp);
    const q = checkQuantity(module, d.quantity, `${dp}.quantity`);
    if (!q.ok) return q;
    const quantity = q.value;
    const rule = QUANTITY_KIND_RULES[quantity.kind];
    if (!rule.ledgerTrackable || (quantity.kind === 'PNL' && quantity.valuation !== null)) {
      return refuse('DEMAND_INVALID', 'DEMAND_NOT_LEDGER_TRACKABLE', `${dp}.quantity.kind`, { module: module.ref });
    }
    if (quantity.atoms <= 0n) return refuse('DEMAND_INVALID', 'DEMAND_NOT_POSITIVE', `${dp}.quantity.atoms`, { module: module.ref });
    if (!module.demandMeasures.some((m) => m.kind === quantity.kind && m.unit === quantity.unit)) {
      return refuse('DEMAND_INVALID', 'DEMAND_MEASURE_UNDECLARED', `${dp}.quantity`, { module: module.ref });
    }
    const v = quantity.valuation;
    if (v !== null && (v.basis !== 'LIMIT' || v.source.kind !== 'ACTION' || v.source.actionId !== action.actionId)) {
      return refuse('DEMAND_INVALID', 'DEMAND_VALUATION_NOT_ACTION_LIMIT', `${dp}.quantity.valuation`, { module: module.ref });
    }
    const market = checkNullableResource(module, d.market, ['MARKET'] as const, `${dp}.market`);
    if (!market.ok) return market;
    const account = checkNullableResource(module, d.account, ['ACCOUNT'] as const, `${dp}.account`);
    if (!account.ok) return account;
    if (typeof d.required !== 'boolean') return bad(module, `${dp}.required`);
    out.push({ quantity, market: market.value, account: account.value, required: d.required });
  }
  return ok(out);
}

// --- Narrowing -------------------------------------------------------------------

const NARROWINGS: readonly InvariantNarrowing[] = ['NO_WEAKER', 'WEAKER', 'UNPROVABLE'];

export function checkNarrowing(module: DomainModule, v: InvariantNarrowing, path: string): ControlResult<InvariantNarrowing> {
  return oneOf(module, v, NARROWINGS, path);
}
