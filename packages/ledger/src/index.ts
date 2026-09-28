/**
 * @mandate/ledger — the Mandate Core v1 authority graph and principal-wide
 * global authority ledger (Phase 7C).
 *
 * The authority graph (registration, lineage, revocation, the delegation
 * subset check and the action-time meet), the ledger's closed event
 * vocabulary and hash chain, the pure reducer over it, atomic charging of
 * every leg of a charging path — lineage then principal policy — the
 * compare-and-swap store contract with an in-memory reference store, the
 * module-registry conformance lookup, and the engine that decides against one
 * snapshot and commits at its version.
 *
 * What is not here: domain modules, projection, state admission, invariant
 * evaluation, the reservation lifecycle and reconciliation rules (7D), any
 * venue, network or chain access, and a durable store. The ledger knows
 * typed quantities, dimensions and scopes; it knows nothing about spot,
 * perps, options, lending or any other domain.
 *
 * Dependencies: `@mandate/core` and `@mandate/kernel` only (ADR 0021).
 */

export * from './errors.ts';
export * from './limits.ts';
export { LedgerTag, rescaleExact, compareScaled } from './encoding.ts';
export * from './pmap.ts';
export * from './revocation.ts';
export * from './charge-plan.ts';
export {
  availableOf,
  emptyLedgerState,
  encodeLedgerState,
  epochIndex,
  genesisHead,
  ledgerStateDigest,
  nodeTargetKey,
  policyDimensionIdentity,
  policyTargetKey,
  targetKeyOf,
  type ActionRecord,
  type CapacitySource,
  type DemandRecord,
  type LedgerState,
  type LedgerStateDigest,
  type LegRecord,
  type NodeRecord,
  type PolicyDimensionIdentity,
  type PolicyRecord,
  type ReservationRecord,
  type ReservationStatus,
  type TargetBalance,
} from './state.ts';
export { checkDelegationSubset, compareBoundValues, delegateDepth, dimensionsComparable, setMemberKeys } from './subset.ts';
export { checkGrantRegistration, checkLineageValid, checkRevocation, effectiveDepths, resolveLineage } from './graph.ts';
export * from './meet.ts';
export { checkAvailability, contributionMatches, deriveLegs, type LegDraft } from './charging.ts';
export * from './events.ts';
export * from './reducer.ts';
export * from './registry.ts';
export * from './store.ts';
export * from './memory-store.ts';
export * from './engine.ts';
