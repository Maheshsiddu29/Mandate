/**
 * What it means for a module implementation to be conforming (brief §49;
 * action-state-model.md §8.1).
 *
 * An implementation is admitted to a catalog only if all of these hold:
 *
 * 1. **Declared identity.** Its `ModuleRef` is exactly the one the registry
 *    maps its name to — digest included — and its `ImplementationDigest` is
 *    registered as conforming to that digest.
 * 2. **Shape.** Every function of the `DomainModule` interface is present;
 *    its invariant ids are unique and outside Core's namespace; its finality
 *    ladders and demand measures are well formed, and every demand measure is
 *    ledger-trackable.
 * 3. **Canonical, valid outputs.** On every vector of its conformance corpus,
 *    every output passes the same re-validation the engine applies at
 *    decision time (outputs.ts).
 * 4. **Determinism and purity.** Each vector is run twice on deep-frozen
 *    copies of its inputs; the two runs must produce byte-identical canonical
 *    outputs, must not throw, and must leave the inputs unchanged.
 * 5. **The corpus's expectations.** Requirement counts, invariant outcomes,
 *    demands and narrowing verdicts equal the vector's expected values.
 *
 * A corpus proves only what its vectors exercise (action-state-model.md §8.1:
 * "what the digest cannot prove is that the corpus is complete"). The
 * absence of prohibited dependencies — I/O, clock, randomness, network — is
 * checked structurally over a module's source, as for every package
 * (`structure.test.ts`). Registry governance is not solved here (open
 * question 16).
 */

import { ByteWriter, ok } from '@mandate/kernel';
import {
  QUANTITY_KIND_RULES,
  moduleRefInputOf,
  moduleRefsEqual,
  parseIdentifierAs,
  parseNonZeroDigest,
  parseQuantityKind,
  parseUnitCode,
  validateModuleRef,
  writeResourceId,
  writeStateRequirement,
  type FinalityLadderId,
  type ImplementationDigest,
  type InvariantId,
  type QuantityKind,
  type StateInvariantTerm,
} from '@mandate/core';
import type { InvariantNarrowing, ModuleRegistry } from '@mandate/ledger';
import { refuse, type ControlResult } from './errors.ts';
import { deepFreeze, frozenCopy, sameBytes } from './freeze.ts';
import { MAX_FINALITY_LEVELS } from './limits.ts';
import { DOMAIN_MODULE_FUNCTIONS, type AdmittedState, type DomainModule, type InvariantOutcome, type ModuleScope, type StateNeed } from './module.ts';
import { callModule, checkAnalysis, checkDemands, checkEvaluation, checkNarrowing, checkNeeds, checkProjection } from './outputs.ts';
import { writeModuleProjection } from './projection.ts';
import { writeMeasure, writeStrList } from './encoding.ts';

export interface ExpectedDemand {
  readonly kind: QuantityKind;
  readonly unit: string;
  readonly decimals: number;
  readonly atoms: bigint;
}

export interface ConformanceVector {
  readonly name: string;
  readonly scope: ModuleScope;
  readonly states: readonly AdmittedState[];
  readonly expect: {
    readonly requirements: number;
    /** One outcome per `scope.invariants`, in order. */
    readonly invariants: readonly InvariantOutcome[];
    /** The demands of a proposing action, in order; `null` when the vector has no proposal. */
    readonly demands: readonly ExpectedDemand[] | null;
  };
  readonly narrowing: readonly { readonly parent: StateInvariantTerm; readonly child: StateInvariantTerm; readonly expect: InvariantNarrowing }[];
}

function notConforming(module: DomainModule, reason: string, path: string): ControlResult<never> {
  return refuse('MODULE_NOT_CONFORMING', reason, path, { origin: 'MODULE', module: module.ref });
}

/** Rules 1 and 2: identity and shape, with no module function called. */
export function checkModuleStructure(module: DomainModule, registry: ModuleRegistry, path: string): ControlResult<true> {
  if (typeof module !== 'object' || module === null) return refuse('MODULE_NOT_CONFORMING', 'NOT_A_MODULE', path);
  const ref = validateModuleRef(moduleRefInputOf(module.ref), `${path}.ref`);
  if (!ref.ok || !moduleRefsEqual(ref.value, module.ref)) return refuse('MODULE_NOT_CONFORMING', 'MODULE_REF_INVALID', `${path}.ref`);
  for (const f of DOMAIN_MODULE_FUNCTIONS) {
    if (typeof module[f] !== 'function') return notConforming(module, 'FUNCTION_MISSING', `${path}.${f}`);
  }
  const impl = parseNonZeroDigest<ImplementationDigest>(module.implementation, `${path}.implementation`);
  if (!impl.ok) return notConforming(module, 'IMPLEMENTATION_DIGEST_INVALID', `${path}.implementation`);
  const registration = registry.lookup(module.ref.moduleId, module.ref.moduleVersion);
  if (registration === null) return notConforming(module, 'MODULE_UNREGISTERED', `${path}.ref`);
  // The implementation's declared ref must be exactly the registered one: a patched module under an old name is refused.
  if (!moduleRefsEqual(registration.module, module.ref)) return notConforming(module, 'MODULE_DIGEST_MISMATCH', `${path}.ref`);
  if (!registration.implementations.includes(module.implementation)) return notConforming(module, 'MODULE_IMPLEMENTATION_UNREGISTERED', `${path}.implementation`);

  const seen = new Set<string>();
  for (let i = 0; i < module.invariants.length; i += 1) {
    const inv = module.invariants[i];
    const ip = `${path}.invariants[${i}]`;
    if (inv === undefined || !parseIdentifierAs<InvariantId>(inv.invariantId, ip).ok || !Number.isSafeInteger(inv.version) || inv.version < 0) {
      return notConforming(module, 'INVARIANT_DEFINITION_INVALID', ip);
    }
    const k = JSON.stringify([inv.invariantId, inv.version]);
    if (seen.has(k)) return notConforming(module, 'INVARIANT_DEFINED_TWICE', ip);
    seen.add(k);
  }
  const ladders = new Set<string>();
  for (let i = 0; i < module.finalityLadders.length; i += 1) {
    const l = module.finalityLadders[i];
    const lp = `${path}.finalityLadders[${i}]`;
    if (l === undefined || !parseIdentifierAs<FinalityLadderId>(l.ladder, lp).ok || ladders.has(l.ladder)) return notConforming(module, 'FINALITY_LADDER_INVALID', lp);
    ladders.add(l.ladder);
    if (l.levels.length === 0 || l.levels.length > MAX_FINALITY_LEVELS || new Set(l.levels).size !== l.levels.length) return notConforming(module, 'FINALITY_LADDER_INVALID', lp);
    for (const level of l.levels) if (!parseIdentifierAs(level, lp).ok) return notConforming(module, 'FINALITY_LADDER_INVALID', lp);
  }
  for (let i = 0; i < module.demandMeasures.length; i += 1) {
    const m = module.demandMeasures[i];
    const mp = `${path}.demandMeasures[${i}]`;
    if (m === undefined) return notConforming(module, 'DEMAND_MEASURE_INVALID', mp);
    const kind = parseQuantityKind(m.kind, mp);
    if (!kind.ok || !parseUnitCode(m.unit, mp).ok) return notConforming(module, 'DEMAND_MEASURE_INVALID', mp);
    // A module may never declare that it charges a floating value (decision 10).
    if (!QUANTITY_KIND_RULES[kind.value].ledgerTrackable) return notConforming(module, 'DEMAND_MEASURE_NOT_LEDGER_TRACKABLE', mp);
  }
  return ok(true);
}

function writeNeed(w: ByteWriter, n: StateNeed): void {
  w.str(n.stateKind);
  writeResourceId(w, n.subject);
  writeStrList(w, n.admittedSources);
  writeStateRequirement(w, n.requirement);
}

interface VectorRun {
  readonly bytes: Uint8Array;
  readonly requirements: number;
  readonly invariants: readonly InvariantOutcome[];
  readonly demands: readonly ExpectedDemand[] | null;
  readonly narrowing: readonly InvariantNarrowing[];
}

/** One run of one vector on fresh frozen copies: every output validated and canonically encoded. */
function runVector(module: DomainModule, vector: ConformanceVector, path: string): ControlResult<VectorRun> {
  const scope = frozenCopy(vector.scope);
  const states = frozenCopy([...vector.states]);
  const payloads = states.map((s) => new Uint8Array(s.payload));
  const actionPayload = scope.action === null ? null : new Uint8Array(scope.action.payload);
  const w = new ByteWriter();

  const needs = callModule(module, 'STATE_INVALID', `${path}.stateRequirements`, () => module.stateRequirements(scope));
  if (!needs.ok) return needs;
  const checkedNeeds = checkNeeds(module, needs.value, `${path}.stateRequirements`);
  if (!checkedNeeds.ok) return checkedNeeds;
  w.u32(checkedNeeds.value.length);
  for (const n of checkedNeeds.value) writeNeed(w, n);

  for (let i = 0; i < states.length; i += 1) {
    const valid = callModule(module, 'STATE_INVALID', `${path}.validateStatePayload[${i}]`, () => module.validateStatePayload(states[i] as AdmittedState));
    if (!valid.ok) return valid;
  }
  const projection = callModule(module, 'INVARIANT_UNKNOWN', `${path}.project`, () => module.project(scope, states));
  if (!projection.ok) return projection;
  const checked = checkProjection(module, projection.value, scope, states.map((s) => s.stateId), `${path}.project`);
  if (!checked.ok) return checked;
  writeModuleProjection(w, checked.value);
  const frozenProjection = deepFreeze(checked.value);

  const invariants: InvariantOutcome[] = [];
  for (let i = 0; i < scope.invariants.length; i += 1) {
    const term = scope.invariants[i] as StateInvariantTerm;
    const e = callModule(module, 'INVARIANT_UNKNOWN', `${path}.evaluateInvariant[${i}]`, () => module.evaluateInvariant(term, frozenProjection));
    if (!e.ok) return e;
    const ce = checkEvaluation(module, e.value, `${path}.evaluateInvariant[${i}]`);
    if (!ce.ok) return ce;
    w.str(ce.value.outcome).str(ce.value.reason);
    if (ce.value.observed !== null) writeMeasure(w, ce.value.observed);
    if (ce.value.bound !== null) writeMeasure(w, ce.value.bound);
    invariants.push(ce.value.outcome);
  }

  let demands: ExpectedDemand[] | null = null;
  const action = scope.action;
  if (action !== null && action.mode === 'PROPOSE') {
    const analysis = callModule(module, 'ACTION_INVALID', `${path}.validateAction`, () => module.validateAction(action));
    if (!analysis.ok) return analysis;
    const ca = checkAnalysis(module, analysis.value, action, `${path}.validateAction`);
    if (!ca.ok) return ca;
    const d = callModule(module, 'DEMAND_INVALID', `${path}.deriveLedgerDemands`, () => module.deriveLedgerDemands(action, frozenProjection));
    if (!d.ok) return d;
    const cd = checkDemands(module, d.value, action, `${path}.deriveLedgerDemands`);
    if (!cd.ok) return cd;
    demands = cd.value.map((x) => ({ kind: x.quantity.kind, unit: x.quantity.unit, decimals: x.quantity.decimals, atoms: x.quantity.atoms }));
    for (const x of demands) w.str(x.kind).str(x.unit).u8(x.decimals).u256(x.atoms);
  }

  const narrowing: InvariantNarrowing[] = [];
  for (let i = 0; i < vector.narrowing.length; i += 1) {
    const n = frozenCopy({ ...(vector.narrowing[i] as ConformanceVector['narrowing'][number]) });
    const v = callModule(module, 'SEMANTIC_NARROWING_UNPROVABLE', `${path}.noWeaker[${i}]`, () => module.noWeaker(n.parent, n.child));
    if (!v.ok) return v;
    const cv = checkNarrowing(module, v.value, `${path}.noWeaker[${i}]`);
    if (!cv.ok) return cv;
    w.str(cv.value);
    narrowing.push(cv.value);
  }

  // Byte payloads cannot be frozen; they are compared instead.
  if (states.some((s, i) => !sameBytes(s.payload, payloads[i] as Uint8Array)) || (action !== null && actionPayload !== null && !sameBytes(action.payload, actionPayload))) {
    return notConforming(module, 'INPUT_MUTATED', path);
  }
  return ok({ bytes: w.finish(), requirements: checkedNeeds.value.length, invariants, demands, narrowing });
}

function sameDemands(a: readonly ExpectedDemand[] | null, b: readonly ExpectedDemand[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((x, i) => {
    const y = b[i] as ExpectedDemand;
    return x.kind === y.kind && x.unit === y.unit && x.decimals === y.decimals && x.atoms === y.atoms;
  });
}

/** Rules 1–5. A module passes only if every rule holds on every vector. */
export function checkConformance(module: DomainModule, registry: ModuleRegistry, corpus: readonly ConformanceVector[], path = 'module'): ControlResult<true> {
  const structure = checkModuleStructure(module, registry, path);
  if (!structure.ok) return structure;
  for (let i = 0; i < corpus.length; i += 1) {
    const vector = corpus[i] as ConformanceVector;
    const vp = `${path}.corpus[${i}]`;
    const first = runVector(module, vector, vp);
    if (!first.ok) return notConforming(module, first.error.reason, first.error.path);
    const second = runVector(module, vector, vp);
    if (!second.ok || !sameBytes(first.value.bytes, second.value.bytes)) return notConforming(module, 'NONDETERMINISTIC', vp);
    const r = first.value;
    const e = vector.expect;
    if (
      r.requirements !== e.requirements ||
      r.invariants.length !== e.invariants.length ||
      r.invariants.some((o, j) => o !== e.invariants[j]) ||
      !sameDemands(r.demands, e.demands) ||
      r.narrowing.some((v, j) => v !== vector.narrowing[j]?.expect)
    ) {
      return notConforming(module, 'CORPUS_MISMATCH', vp);
    }
  }
  return ok(true);
}
