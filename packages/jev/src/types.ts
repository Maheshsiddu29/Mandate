/**
 * Types for the optional Jev advisory decision layer (ADR 0012, ADR 0013).
 *
 * Nothing in this package authorizes anything. Every type here describes either
 * an outbound projection of already-verified facts, or an inbound answer that
 * is only ever used as a key into a locally held array.
 */

import type { Bytes32 } from '@mandate/kernel';

export const JEV_INTEGRATION_VERSION = 'mandate-jev/1';
export const JEV_QUESTION_SCHEMA_VERSION = 1;
export const JEV_RECEIPT_SCHEMA_VERSION = 1;
export const JEV_SELECTION_RECEIPT_SCHEMA_VERSION = 1;

/** The question key used in every request. Local, never read from a response. */
export const JEV_QUESTION_NAME = 'route_selection';

/** Always present, always the last option. */
export const ABSTAIN_CHOICE_ID = 'ABSTAIN';

/** TypeSafe documents at most 255 options on a `choice` question. */
export const JEV_MAX_CHOICE_OPTIONS = 255;

/** One option is reserved for ABSTAIN, so this many candidates may be offered. */
export const JEV_MAX_CANDIDATES = JEV_MAX_CHOICE_OPTIONS - 1;

/** Below this, deterministic selection is the whole answer and no call is made. */
export const JEV_MIN_CANDIDATES = 2;

export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const DEFAULT_MODEL = 'jev-latest';

/**
 * How long a trading path may wait for optional advice. This is a policy
 * choice, not a measurement of Jev's latency — see docs/jev-characterization.md.
 */
export const DEFAULT_TIMEOUT_MS = 2_000;

export const SelectionMode = {
  /** No Jev call was made: disabled, or the cardinality made advice pointless. */
  DETERMINISTIC: 'DETERMINISTIC',
  /** Jev chose a candidate and the confidence policy accepted it. */
  JEV_ASSISTED: 'JEV_ASSISTED',
  /** Jev explicitly declined to advise. */
  JEV_ABSTAINED: 'JEV_ABSTAINED',
  /** Jev was called and something went wrong. */
  JEV_FALLBACK: 'JEV_FALLBACK',
} as const;
export type SelectionMode = (typeof SelectionMode)[keyof typeof SelectionMode];

export const JevOutcome = {
  SELECTED: 'SELECTED',
  ABSTAIN: 'ABSTAIN',
  FALLBACK: 'FALLBACK',
} as const;
export type JevOutcome = (typeof JevOutcome)[keyof typeof JevOutcome];

/**
 * Stable integration reason codes. Every one of these resolves to the
 * deterministic candidate; none of them can fail an otherwise valid
 * transaction or relax a check.
 */
export const JevFallbackReason = {
  JEV_DISABLED: 'JEV_DISABLED',
  CARDINALITY_BELOW_MINIMUM: 'CARDINALITY_BELOW_MINIMUM',
  CARDINALITY_UNSUPPORTED: 'CARDINALITY_UNSUPPORTED',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  AUTH_FAILED: 'AUTH_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  REQUEST_REJECTED: 'REQUEST_REJECTED',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  UNEXPECTED_STATUS: 'UNEXPECTED_STATUS',
  INVALID_JSON: 'INVALID_JSON',
  SCHEMA_MISMATCH: 'SCHEMA_MISMATCH',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  CHOICE_OUT_OF_SET: 'CHOICE_OUT_OF_SET',
  CONFIDENCE_BELOW_THRESHOLD: 'CONFIDENCE_BELOW_THRESHOLD',
  TRANSPORT_EXCEPTION: 'TRANSPORT_EXCEPTION',
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
} as const;
export type JevFallbackReason = (typeof JevFallbackReason)[keyof typeof JevFallbackReason];

/**
 * Locally assigned advisory context. Closed vocabularies only: a route
 * provider's free text can never become a value here, and anything
 * unrecognized normalizes to UNKNOWN, which carries no signal.
 */
export const VenueReliability = {
  ESTABLISHED: 'ESTABLISHED',
  PROVISIONAL: 'PROVISIONAL',
  DEGRADED: 'DEGRADED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type VenueReliability = (typeof VenueReliability)[keyof typeof VenueReliability];

export const QuoteFirmness = {
  FIRM: 'FIRM',
  INDICATIVE: 'INDICATIVE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type QuoteFirmness = (typeof QuoteFirmness)[keyof typeof QuoteFirmness];

/**
 * The entire outbound projection of one candidate.
 *
 * Built field by field from verified values. It carries no address, no
 * identifier that means anything outside this process, no principal or agent
 * identity, and no provider-authored string. Integers leave as decimal strings
 * so a bigint never becomes a float in transit.
 */
export interface JevCandidateView {
  readonly choiceId: string;
  readonly allInCostAtoms: string;
  readonly costUnit: string;
  readonly costDecimals: number;
  readonly explicitFeeTotalAtoms: string;
  readonly executionDeviationBps: string;
  readonly quoteAgeSeconds: string;
  readonly routeStepCount: number;
  readonly providerClass: 'RECORDED_REAL' | 'SYNTHETIC_TEST';
  readonly venueReliability: VenueReliability;
  readonly quoteFirmness: QuoteFirmness;
  readonly fillPolicy: 'FILL_OR_KILL';
}

/** The state document sent to Jev. Whitelisted fields only. */
export interface JevState {
  readonly schema: string;
  readonly side: 'BUY' | 'SELL';
  readonly costUnit: string;
  readonly costDecimals: number;
  readonly candidateCount: number;
  readonly candidates: readonly JevCandidateView[];
}

export interface JevChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export interface JevRequestPayload {
  readonly state: JevState;
  readonly model: string;
  readonly questions: Readonly<Record<string, JevChoiceQuestion>>;
}

/**
 * A parsed, bounded Jev answer. `choice` is a string and nothing more — it is
 * resolved by local lookup and is never parsed as a candidate field.
 */
export interface JevChoiceAnswer {
  readonly model: string;
  readonly choice: string;
  readonly probabilities: ReadonlyMap<string, number>;
  readonly confidence: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export type JevTransportOutcome =
  | { readonly ok: true; readonly body: unknown; readonly latencyMs: number }
  | { readonly ok: false; readonly reason: JevFallbackReason; readonly detail: string; readonly latencyMs: number };

/**
 * The seam every Jev caller goes through, including the adversarial stubs.
 *
 * A transport returns a body it makes no claims about. All validation happens
 * on this side of the seam.
 */
export interface JevTransport {
  send(payload: JevRequestPayload, timeoutMs: number): Promise<JevTransportOutcome>;
}

export interface JevModelDescriptor {
  readonly name: string;
  readonly description: string | null;
  readonly releaseDate: string | null;
}

export interface JevPolicy {
  readonly enabled: boolean;
  readonly model: string;
  readonly timeoutMs: number;
  /**
   * Null means no threshold: every in-set choice is accepted and the observed
   * confidence is recorded. A threshold is only defensible once the
   * distribution has been measured (ADR 0013).
   */
  readonly minimumConfidence: number | null;
  /**
   * When set, a model outside this list is refused before any request is made.
   * Populated from `GET /v1/models`.
   */
  readonly allowedModels: readonly string[] | null;
}

export const DEFAULT_JEV_POLICY: JevPolicy = {
  enabled: true,
  model: DEFAULT_MODEL,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  minimumConfidence: null,
  allowedModels: null,
};

/**
 * The advisory record of one Jev decision.
 *
 * It is not an authorization and no verifier reads it. It exists so a bad
 * advisory selection can be attributed later, which needs the model identity,
 * the exact closed set the advice was given over, the answer, and the time.
 * It holds no credentials.
 */
export interface JevDecisionReceipt {
  readonly version: number;
  readonly integrationVersion: string;
  readonly questionSchemaVersion: number;

  readonly closedCandidateSetDigest: Bytes32;
  readonly candidateIds: readonly string[];
  readonly candidateDigests: readonly Bytes32[];
  readonly stateDigest: Bytes32;

  readonly modelRequested: string;
  /** Null when no response was obtained. An alias may resolve to a different ID. */
  readonly modelReturned: string | null;

  readonly selectedChoice: string | null;
  readonly confidence: number | null;
  readonly probabilities: readonly (readonly [string, number])[];

  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number | null;

  readonly outcome: JevOutcome;
  readonly fallbackReason: JevFallbackReason | null;
  readonly selectionMode: SelectionMode;

  readonly evaluatedAtUnixSeconds: bigint;
  readonly receiptDigest: Bytes32;
}

/**
 * The Phase 5 selection receipt: the one record that binds the deterministic
 * routing receipt, the advisory decision receipt and the handoff verification
 * together.
 *
 * It exists because the Phase 4 routing receipt must not change — its encoding
 * is a committed compatibility surface — and because a reviewer needs to see,
 * in one place, what the deterministic path would have chosen and what was
 * actually selected. When those digests differ, a model changed the answer.
 */
export interface JevAssistedSelectionReceipt {
  readonly version: number;
  readonly integrationVersion: string;
  readonly selectionMode: SelectionMode;

  readonly routingReceiptDigest: Bytes32;
  readonly jevReceiptDigest: Bytes32 | null;

  readonly deterministicCandidateDigest: Bytes32 | null;
  readonly selectedCandidateDigest: Bytes32 | null;

  readonly handoffVerificationReceiptDigest: Bytes32 | null;
  readonly handoffDecision: 'PASS' | 'REJECT' | 'NONE';

  readonly evaluatedAtUnixSeconds: bigint;
  readonly receiptDigest: Bytes32;
}
