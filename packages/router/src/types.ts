import type {
  Amount,
  Bytes32,
  CanonicalAssetId,
  ExecutionCandidate,
  Price,
  UnixSeconds,
  VerificationReceipt,
} from '@mandate/kernel';
import type { RegistryReasonCode } from '@mandate/registry';

export const ROUTER_VERSION = 'mandate-router/2';
export const ROUTE_QUOTE_SCHEMA_VERSION = 1;
export const ROUTING_RECEIPT_SCHEMA_VERSION = 1;

export const MAX_ROUTE_CANDIDATES = 256;
export const MAX_ROUTE_STEPS = 8;

/**
 * Bound on the independently established cost set (finding N-9).
 *
 * Derived from the architecture rather than picked: a `TrustedRouteCost` is keyed
 * by `routeId`, one per route quote, duplicate route ids are refused, and the
 * route set itself is bounded at `MAX_ROUTE_CANDIDATES`. So the largest cost set
 * that can describe a meaningful routing request has exactly
 * `MAX_ROUTE_CANDIDATES` entries; anything beyond that is either duplicate keys
 * or costs for routes that were never offered.
 *
 * It is the same number deliberately, and it is defined in terms of the route
 * bound so the two cannot drift apart.
 */
export const MAX_TRUSTED_ROUTE_COSTS = MAX_ROUTE_CANDIDATES;

export const ProviderClass = {
  RECORDED_REAL: 'RECORDED_REAL',
  SYNTHETIC_TEST: 'SYNTHETIC_TEST',
} as const;
export type ProviderClass = (typeof ProviderClass)[keyof typeof ProviderClass];

export const FillPolicy = {
  FILL_OR_KILL: 'FILL_OR_KILL',
  ALLOW_PARTIAL: 'ALLOW_PARTIAL',
} as const;
export type FillPolicy = (typeof FillPolicy)[keyof typeof FillPolicy];

export const RouteStepKind = { TRADE: 'TRADE' } as const;
export type RouteStepKind = (typeof RouteStepKind)[keyof typeof RouteStepKind];

export interface RouteStep {
  readonly kind: RouteStepKind;
  readonly venue: ExecutionCandidate['venue'];
  readonly chain: ExecutionCandidate['chain'];
  readonly representationId: ExecutionCandidate['representationId'];
}

export interface RouteCosts {
  readonly venueFee: Amount | null;
  readonly executionFee: Amount | null;
  readonly settlementFee: Amount | null;
  readonly routeFee: Amount | null;
}

/** Strictly parsed but never trusted provider proposal. */
export interface ProviderRouteQuote {
  readonly version: number;
  readonly routeId: string;
  readonly providerId: string;
  readonly providerClass: ProviderClass;
  readonly canonicalAsset: CanonicalAssetId;
  readonly representationId: ExecutionCandidate['representationId'];
  readonly issuer: ExecutionCandidate['issuer'];
  readonly chain: ExecutionCandidate['chain'];
  readonly venue: ExecutionCandidate['venue'];
  readonly side: 'BUY' | 'SELL';
  readonly agent: ExecutionCandidate['agent'];
  readonly quantity: Amount;
  readonly executionPrice: Price;
  readonly notional: Amount;
  readonly quoteObservedAtUnixSeconds: UnixSeconds;
  readonly fillPolicy: FillPolicy;
  readonly costs: RouteCosts;
  readonly steps: readonly RouteStep[];
  readonly referenceStateId: string;
  readonly corporateActionEpoch: bigint;
}

/** Fee state established outside an untrusted route provider. */
export interface TrustedRouteCost {
  readonly routeId: string;
  readonly costs: RouteCosts;
  readonly provenanceSourceId: string;
  readonly observedAtUnixSeconds: UnixSeconds;
}

export interface RoutingCandidate {
  readonly version: 1;
  readonly routeId: string;
  readonly providerId: string;
  readonly providerClass: ProviderClass;
  readonly fillPolicy: 'FILL_OR_KILL';
  readonly quoteObservedAtUnixSeconds: UnixSeconds;
  readonly referenceObservedAtUnixSeconds: UnixSeconds;
  readonly referencePrice: Price;
  readonly trustedCostSourceId: string;
  readonly trustedCostObservedAtUnixSeconds: UnixSeconds;
  readonly costs: {
    readonly venueFee: Amount;
    readonly executionFee: Amount;
    readonly settlementFee: Amount;
    readonly routeFee: Amount;
  };
  readonly steps: readonly RouteStep[];
  /**
   * The sum of `costs`, in the notional's unit.
   *
   * Carried on the execution candidate as well, where the kernel reads it. The
   * router establishes it; the router no longer decides whether it is within
   * authority (ADR 0014).
   */
  readonly feeTotal: Amount;
  readonly executionCandidate: ExecutionCandidate;
  readonly kernelCandidateDigest: Bytes32;
  readonly candidateDigest: Bytes32;
}

export interface RouteQuality {
  readonly economicValue: Amount;
  readonly executionDeviationBps: bigint;
  readonly quoteAgeSeconds: bigint;
  readonly routeSteps: number;
  readonly explicitFeeTotal: Amount;
}

export type RoutingReasonCode =
  | RegistryReasonCode
  | 'MALFORMED_PROVIDER_RESPONSE'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'DUPLICATE_ROUTE_ID'
  | 'DUPLICATE_CANDIDATE'
  | 'REPRESENTATION_NOT_DISCOVERABLE'
  | 'PROVIDER_IDENTITY_MISMATCH'
  | 'REQUESTED_QUANTITY_MISMATCH'
  | 'PARTIAL_FILL_UNSUPPORTED'
  | 'UNKNOWN_COST'
  | 'UNTRUSTED_COST_MISMATCH'
  | 'COST_UNIT_MISMATCH'
  | 'COST_OVERFLOW'
  | 'COST_STATE_STALE'
  | 'COST_STATE_FUTURE'
  // REGISTRY_SNAPSHOT_MISMATCH and REGISTRY_SNAPSHOT_UNKNOWN are kernel reason
  // codes (MND-STATE-009/010), reached through `RegistryReasonCode`. They used to
  // be router-local literals with no definition behind them, which meant a
  // routing refusal carried a code an integrator could not look up.
  | 'HANDOFF_TIME_REGRESSED'
  | 'HANDOFF_STATE_MISSING'
  | 'QUOTE_STALE'
  | 'QUOTE_FROM_FUTURE'
  | 'FINAL_REVERIFICATION_FAILED'
  | 'INPUT_INVALID';

export interface RouteExclusion {
  readonly code: RoutingReasonCode;
  readonly detail: Readonly<Record<string, string>>;
}

export type RouteOutcome =
  | {
      readonly routeId: string;
      readonly status: 'EXCLUDED';
      readonly candidateDigest: Bytes32 | null;
      readonly exclusions: readonly RouteExclusion[];
      readonly verificationReceipt: VerificationReceipt | null;
    }
  | {
      readonly routeId: string;
      readonly status: 'ADMISSIBLE';
      readonly candidateDigest: Bytes32;
      readonly quality: RouteQuality;
      readonly verificationReceipt: VerificationReceipt;
    };

export interface RoutingReceipt {
  readonly version: number;
  readonly routerVersion: string;
  readonly mandateDigest: Bytes32;
  readonly registrySnapshotDigest: Bytes32;
  readonly marketStateDigest: Bytes32;
  readonly requestedQuantity: Amount;
  readonly outcomes: readonly RouteOutcome[];
  readonly rankedCandidateDigests: readonly Bytes32[];
  readonly selectedCandidateDigest: Bytes32 | null;
  readonly finalVerificationReceiptDigest: Bytes32 | null;
  readonly evaluatedAtUnixSeconds: UnixSeconds;
  /** Digest of the state the handoff re-verification actually read. */
  readonly handoffStateDigest: Bytes32 | null;
  /** The instant the handoff re-verification was performed at. */
  readonly handoffAtUnixSeconds: UnixSeconds | null;
  readonly receiptDigest: Bytes32;
}

export type RoutingResult =
  | { readonly status: 'SELECTED'; readonly selected: RoutingCandidate; readonly finalVerificationReceipt: VerificationReceipt; readonly receipt: RoutingReceipt }
  | {
      readonly status: 'NO_VALID_ROUTE';
      readonly receipt: RoutingReceipt;
      /**
       * The handoff re-verification, when one ran and refused.
       *
       * Null when there was nothing to re-verify. Carried so a caller can tell
       * "nothing was admissible" from "the winner stopped being admissible
       * between evaluation and handoff" without re-deriving it.
       */
      readonly finalVerificationReceipt: VerificationReceipt | null;
    }
  | { readonly status: 'INVALID_INPUT'; readonly errors: readonly RouteExclusion[] };
