/**
 * @mandate/control — the Mandate Core v1 invariant and reservation engine
 * (Phase 7D).
 *
 * Turns principal authority, an agent's action, trusted current state and a
 * domain module's semantics into either a refusal or an atomically reserved,
 * state-bound, exactly identified authorization:
 *
 * ```text
 * action → exact DomainModule → validate → state requirements → admission
 *        → worst-case projection (held + pending + proposed) → lineage and principal-global invariants
 *        → ledger demands → charge plan → atomic reservation by CAS → ExecutionAuthorization
 * ```
 *
 * Domain modules provide economic meaning; this package, over the authority
 * ledger, controls authorization. It performs no I/O, reads no clock, calls
 * no venue, network or chain, and implements no production domain module.
 * The ledger's raw accounting reducer is not re-exported and no function here
 * moves an amount of authority on a caller's say-so.
 *
 * Dependencies: `@mandate/ledger`, `@mandate/core` and `@mandate/kernel`
 * (ADR 0025).
 */

export * from './errors.ts';
export * from './limits.ts';
export { ControlTag, statePayloadDigest } from './encoding.ts';
export * from './module.ts';
export { CORE_INVARIANT_NAMESPACE, ModuleCatalog, controlRules, type ArchivedModules, type CatalogModule, type Evaluator, type InvariantComparison } from './catalog.ts';
export { EMPTY_ARCHIVE, ReferenceModuleArchive, type ArchivedModule, type ModuleArchive } from './archive.ts';
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
export { narrowingProofs, policyProofs, semanticProofRefs, type NarrowingProof } from './narrowing.ts';
export { termBindings } from './binding.ts';
export { authorizationLifetime, chargePlanDigest, decide, type AuthorizationRequest, type ChargePlanDigest, type Decision, type DecisionEnv } from './pipeline.ts';
export { authorizationRecordOf, encodeAuthorizationRecord, type AuthorizationId, type AuthorizationRecord } from './authorization.ts';
export { type RevalidationId, type RevalidationRequest, type RevalidationResult } from './revalidation.ts';
export { ControlEngine, neverIssuedEvidence, type AttemptOutcome, type AttemptRequest, type AuthorizationOutcome, type CloseOutcome, type ControlEngineOptions, type RegistrationOutcome } from './engine.ts';
export {
  ADAPTER_EVALUATED,
  CONTROL_EVALUATED,
  PRE_EXECUTION_KINDS,
  RESERVED_KINDS,
  canonicalResults,
  checkPreExecution,
  evidenceDigest,
  preExecutionDigest,
  type PreExecutionDigest,
  type PreExecutionKind,
  type PreExecutionOutcome,
  type PreExecutionRequirement,
  type PreExecutionResult,
} from './preexecution.ts';
