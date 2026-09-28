/**
 * @mandate/control — the Mandate Core v1 invariant and reservation engine
 * (Phase 7D).
 *
 * The version-bound `DomainModule` contract, re-validation of everything a
 * module returns, conformance, the module catalog that resolves an exact
 * `ModuleRef` to exactly one conforming implementation, the explicit
 * evaluation context, state admission and bindings, and reservation facts.
 *
 * Dependencies: `@mandate/ledger`, `@mandate/core` and `@mandate/kernel`
 * (ADR 0025).
 */

export * from './errors.ts';
export * from './limits.ts';
export { ControlTag, statePayloadDigest } from './encoding.ts';
export * from './module.ts';
export { CORE_INVARIANT_NAMESPACE, ModuleCatalog, controlRules, type CatalogModule, type Evaluator, type InvariantComparison } from './catalog.ts';
export { checkConformance, checkModuleStructure, type ConformanceVector, type ExpectedDemand } from './conformance.ts';
export { validateEvaluationContext, type ContextDigest, type EvaluationContext, type EvaluationContextInput, type StateSourceConfig, type StateSourceConfigInput } from './context.ts';
export { readmitBinding, tightenRequirement, type Admission, type EffectiveNeed, type SuppliedState } from './admission.ts';
export {
  AGGREGATE_INVARIANT_ID,
  AGGREGATE_INVARIANT_VERSION,
  MAX_AGGREGATE_CONTRIBUTORS,
  compareAggregateParams,
  decodeAggregateParams,
  encodeAggregateParams,
  type AggregateParams,
} from './aggregate.ts';
export { reservationFacts } from './facts.ts';
export { encodeProjectionRecord, projectionDigest, stateDependencyDigest, type ParticipantProjection, type ProjectionDigest, type ProjectionRecord } from './projection.ts';
export { invariantResultsDigest, type InvariantOrigin, type InvariantResult, type InvariantResultsDigest } from './invariants.ts';
export { narrowingProofs, type NarrowingProof } from './narrowing.ts';
