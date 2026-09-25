/**
 * The advisory decision path.
 *
 * Reading order for the safety argument:
 *
 * 1. `evaluateRoutes` closes the admissible set. Everything after this line
 *    operates on that array and cannot add to it.
 * 2. A choice — from Jev or from the deterministic baseline — is an *index*
 *    into that array. `selectEvaluated` refuses any index outside it.
 * 3. The selected candidate is verified by the kernel again, against the state
 *    that is current at handoff rather than the state the set was built from.
 *
 * Every failure between steps 1 and 3 resolves to index 0, the deterministic
 * preferred candidate. There is no path that fails a transaction because an
 * optional external service was unavailable, and no path that relaxes a check.
 */

import {
  Decision,
  verify,
  type VerificationReceipt,
  type VerifyRequest,
} from '@mandate/kernel';
import {
  evaluateRoutes,
  selectEvaluated,
  type RouteExclusion,
  type RouteRequest,
  type RoutingCandidate,
  type RoutingEvaluation,
  type RoutingResult,
} from '@mandate/router';
import {
  ChoiceSetStatus,
  buildClosedChoiceSet,
  classifyCardinality,
  resolveChoice,
  type ClosedChoiceSet,
} from './choices.ts';
import { closedChoiceSetDigest, jevDecisionReceiptDigest, jevStateDigest, jevSelectionReceiptDigest } from './encoding.ts';
import { parseJevChoiceResponse } from './parse.ts';
import { buildRequestPayload } from './question.ts';
import {
  DEFAULT_JEV_POLICY,
  JEV_INTEGRATION_VERSION,
  JEV_QUESTION_NAME,
  JEV_QUESTION_SCHEMA_VERSION,
  JEV_RECEIPT_SCHEMA_VERSION,
  JEV_SELECTION_RECEIPT_SCHEMA_VERSION,
  JevFallbackReason,
  JevOutcome,
  SelectionMode,
  type JevAssistedSelectionReceipt,
  type JevChoiceAnswer,
  type JevDecisionReceipt,
  type JevPolicy,
  type JevTransport,
  type JevTransportOutcome,
} from './types.ts';
import type { RouteAdvisoryContext } from './view.ts';

type Verifier = (request: VerifyRequest) => VerificationReceipt;

/** Trusted state and clock as they are at handoff, which may be later than t0. */
export interface HandoffState {
  readonly trustedMarketState: unknown;
  readonly clock: unknown;
}

export interface JevRoutingRequest {
  readonly route: RouteRequest;
  /** `null` runs the deterministic path and records why no call was made. */
  readonly transport: JevTransport | null;
  readonly policy?: Partial<JevPolicy>;
  readonly advisoryByRouteId?: Readonly<Record<string, RouteAdvisoryContext>>;
  /**
   * State to re-verify against before handoff. Defaults to the state the set
   * was built from; supplying a later snapshot is what makes an inference-time
   * state change reject rather than being grandfathered in.
   */
  readonly handoffState?: HandoffState;
  readonly verifier?: Verifier;
}

export interface JevSelectionCommon {
  readonly selectionMode: SelectionMode;
  readonly jevReceipt: JevDecisionReceipt | null;
  readonly routing: RoutingResult;
  readonly handoffVerification: VerificationReceipt | null;
  readonly selectionReceipt: JevAssistedSelectionReceipt | null;
  /** Index 0 of the closed set: what the deterministic path would have chosen. */
  readonly deterministicCandidate: RoutingCandidate | null;
}

export type JevRoutingResult =
  | (JevSelectionCommon & {
      readonly status: 'SELECTED';
      readonly selected: RoutingCandidate;
      readonly handoffVerification: VerificationReceipt;
    })
  | (JevSelectionCommon & {
      readonly status: 'NO_VALID_ROUTE';
      /** Set when the candidate passed at t0 and failed at handoff. */
      readonly handoffRejected: boolean;
    })
  | (JevSelectionCommon & {
      readonly status: 'INVALID_INPUT';
      readonly errors: readonly RouteExclusion[];
    });

interface Decided {
  readonly index: number;
  readonly outcome: JevOutcome;
  readonly mode: SelectionMode;
  readonly fallbackReason: JevFallbackReason | null;
  readonly answer: JevChoiceAnswer | null;
  readonly latencyMs: number | null;
}

function deterministic(reason: JevFallbackReason, mode: SelectionMode = SelectionMode.DETERMINISTIC): Decided {
  return { index: 0, outcome: JevOutcome.FALLBACK, mode, fallbackReason: reason, answer: null, latencyMs: null };
}

/**
 * Bound the call independently of the transport.
 *
 * The client honours its own deadline, but a transport is an interface and an
 * implementation of it may not — one that never settles must not be able to
 * hang a trading path. The timer is always cleared once the race settles, so it
 * holds the event loop for at most the configured deadline.
 */
async function withDeadline(work: Promise<JevTransportOutcome>, timeoutMs: number): Promise<JevTransportOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<JevTransportOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: JevFallbackReason.TIMEOUT, detail: `deadline ${timeoutMs}ms exceeded`, latencyMs: timeoutMs }), timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function consult(
  transport: JevTransport,
  policy: JevPolicy,
  evaluation: RoutingEvaluation,
  set: ClosedChoiceSet,
): Promise<Decided> {
  const payload = buildRequestPayload(evaluation.context.mandate, set, policy.model);
  let outcome: JevTransportOutcome;
  try {
    outcome = await withDeadline(Promise.resolve(transport.send(payload, policy.timeoutMs)), policy.timeoutMs);
  } catch {
    // A transport that throws rather than returning is still just an
    // unavailable transport, not a financial event.
    return deterministic(JevFallbackReason.TRANSPORT_EXCEPTION, SelectionMode.JEV_FALLBACK);
  }
  if (!outcome.ok) {
    return { index: 0, outcome: JevOutcome.FALLBACK, mode: SelectionMode.JEV_FALLBACK, fallbackReason: outcome.reason, answer: null, latencyMs: outcome.latencyMs };
  }
  const parsed = parseJevChoiceResponse(outcome.body, JEV_QUESTION_NAME);
  if (!parsed.ok) {
    return { index: 0, outcome: JevOutcome.FALLBACK, mode: SelectionMode.JEV_FALLBACK, fallbackReason: parsed.reason, answer: null, latencyMs: outcome.latencyMs };
  }
  const answer = parsed.value;
  const resolved = resolveChoice(set, answer.choice);
  if (resolved.kind === 'ABSTAIN') {
    return { index: 0, outcome: JevOutcome.ABSTAIN, mode: SelectionMode.JEV_ABSTAINED, fallbackReason: null, answer, latencyMs: outcome.latencyMs };
  }
  if (resolved.kind === 'OUT_OF_SET') {
    return { index: 0, outcome: JevOutcome.FALLBACK, mode: SelectionMode.JEV_FALLBACK, fallbackReason: JevFallbackReason.CHOICE_OUT_OF_SET, answer, latencyMs: outcome.latencyMs };
  }
  if (policy.minimumConfidence !== null && answer.confidence < policy.minimumConfidence) {
    return { index: 0, outcome: JevOutcome.FALLBACK, mode: SelectionMode.JEV_FALLBACK, fallbackReason: JevFallbackReason.CONFIDENCE_BELOW_THRESHOLD, answer, latencyMs: outcome.latencyMs };
  }
  return { index: resolved.index, outcome: JevOutcome.SELECTED, mode: SelectionMode.JEV_ASSISTED, fallbackReason: null, answer, latencyMs: outcome.latencyMs };
}

function decisionReceipt(evaluation: RoutingEvaluation, set: ClosedChoiceSet, policy: JevPolicy, decided: Decided): JevDecisionReceipt {
  const answer = decided.answer;
  const unsigned = {
    version: JEV_RECEIPT_SCHEMA_VERSION,
    integrationVersion: JEV_INTEGRATION_VERSION,
    questionSchemaVersion: JEV_QUESTION_SCHEMA_VERSION,
    closedCandidateSetDigest: closedChoiceSetDigest(set),
    candidateIds: set.candidateIds,
    candidateDigests: set.routes.map((item) => item.candidate.candidateDigest),
    stateDigest: jevStateDigest(buildRequestPayload(evaluation.context.mandate, set, policy.model).state),
    modelRequested: policy.model,
    // An alias moves; the returned identifier is what actually answered.
    modelReturned: answer?.model ?? null,
    selectedChoice: answer?.choice ?? null,
    confidence: answer?.confidence ?? null,
    probabilities: answer === null ? [] : [...answer.probabilities.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    inputTokens: answer?.inputTokens ?? null,
    outputTokens: answer?.outputTokens ?? null,
    latencyMs: decided.latencyMs,
    outcome: decided.outcome,
    fallbackReason: decided.fallbackReason,
    selectionMode: decided.mode,
    evaluatedAtUnixSeconds: evaluation.context.clock.nowUnixSeconds,
  };
  return { ...unsigned, receiptDigest: jevDecisionReceiptDigest(unsigned) };
}

function selectionReceipt(
  evaluation: RoutingEvaluation,
  routing: RoutingResult,
  jevReceipt: JevDecisionReceipt,
  handoff: VerificationReceipt | null,
  deterministicCandidate: RoutingCandidate | null,
): JevAssistedSelectionReceipt | null {
  if (routing.status === 'INVALID_INPUT') return null;
  const unsigned = {
    version: JEV_SELECTION_RECEIPT_SCHEMA_VERSION,
    integrationVersion: JEV_INTEGRATION_VERSION,
    selectionMode: jevReceipt.selectionMode,
    routingReceiptDigest: routing.receipt.receiptDigest,
    jevReceiptDigest: jevReceipt.receiptDigest,
    deterministicCandidateDigest: deterministicCandidate?.candidateDigest ?? null,
    selectedCandidateDigest: routing.status === 'SELECTED' ? routing.selected.candidateDigest : null,
    handoffVerificationReceiptDigest: handoff?.receiptDigest ?? null,
    handoffDecision: handoff === null ? ('NONE' as const) : handoff.decision,
    evaluatedAtUnixSeconds: evaluation.context.clock.nowUnixSeconds,
  };
  return { ...unsigned, receiptDigest: jevSelectionReceiptDigest(unsigned) };
}

/**
 * Run the deterministic pipeline, optionally consult Jev over the closed set,
 * and re-verify whatever was chosen before handing it off.
 */
export async function selectWithJev(request: JevRoutingRequest): Promise<JevRoutingResult> {
  const policy: JevPolicy = { ...DEFAULT_JEV_POLICY, ...request.policy };
  const verifier = request.verifier ?? verify;

  const evaluated = evaluateRoutes(request.route, verifier);
  if (evaluated.status === 'INVALID_INPUT') {
    return {
      status: 'INVALID_INPUT',
      errors: evaluated.errors,
      selectionMode: SelectionMode.DETERMINISTIC,
      jevReceipt: null,
      routing: evaluated,
      handoffVerification: null,
      selectionReceipt: null,
      deterministicCandidate: null,
    };
  }

  const evaluation = evaluated.evaluation;
  const set = buildClosedChoiceSet(evaluation.admissible, request.advisoryByRouteId ?? {});
  const deterministicCandidate = evaluation.admissible[0]?.candidate ?? null;

  const cardinality = classifyCardinality(set.routes.length);
  let decided: Decided;
  if (!policy.enabled || request.transport === null) {
    decided = deterministic(JevFallbackReason.JEV_DISABLED);
  } else if (cardinality === ChoiceSetStatus.BELOW_MINIMUM) {
    decided = deterministic(JevFallbackReason.CARDINALITY_BELOW_MINIMUM);
  } else if (cardinality === ChoiceSetStatus.UNSUPPORTED) {
    // The set is not truncated to fit the API. The advisory layer is skipped.
    decided = deterministic(JevFallbackReason.CARDINALITY_UNSUPPORTED, SelectionMode.JEV_FALLBACK);
  } else if (policy.allowedModels !== null && !policy.allowedModels.includes(policy.model)) {
    decided = deterministic(JevFallbackReason.MODEL_UNAVAILABLE, SelectionMode.JEV_FALLBACK);
  } else {
    decided = await consult(request.transport, policy, evaluation, set);
  }

  const routing = selectEvaluated(evaluation, decided.index, verifier);
  const jevReceipt = decisionReceipt(evaluation, set, policy, decided);

  if (routing.status !== 'SELECTED') {
    return {
      status: routing.status === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'NO_VALID_ROUTE',
      errors: routing.status === 'INVALID_INPUT' ? routing.errors : [],
      handoffRejected: false,
      selectionMode: decided.mode,
      jevReceipt,
      routing,
      handoffVerification: null,
      selectionReceipt: selectionReceipt(evaluation, routing, jevReceipt, null, deterministicCandidate),
      deterministicCandidate,
    } as JevRoutingResult;
  }

  // Mandatory, unconditional, and against the state that is current now — not
  // the state the closed set was built from. A choice made before a corporate
  // action, a halt or a price move does not survive it.
  const handoffVerification = verifier({
    mandate: evaluation.context.mandate,
    authorization: evaluation.context.authorization,
    candidate: routing.selected.executionCandidate,
    trustedState: request.handoffState?.trustedMarketState ?? evaluation.context.trustedState,
    clock: request.handoffState?.clock ?? evaluation.context.clock,
    expectedDomain: evaluation.context.expectedDomain,
  });

  const common = {
    selectionMode: decided.mode,
    jevReceipt,
    routing,
    handoffVerification,
    selectionReceipt: selectionReceipt(evaluation, routing, jevReceipt, handoffVerification, deterministicCandidate),
    deterministicCandidate,
  };

  if (handoffVerification.decision !== Decision.PASS) {
    return { ...common, status: 'NO_VALID_ROUTE', handoffRejected: true };
  }
  return { ...common, status: 'SELECTED', selected: routing.selected, handoffVerification };
}
