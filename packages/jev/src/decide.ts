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
 *    the caller supplies for handoff. That state is **required**: it used to
 *    default to the evaluation state, which made the check a tautology
 *    (ADR 0016).
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
  type HandoffInputs,
  type RouteExclusion,
  type RouteRequest,
  type RoutingCandidate,
  type RoutingEvaluation,
  type RoutingResult,
} from '@mandate/router';
import { AdvisoryCircuit } from './availability.ts';
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

/**
 * Trusted state and clock as they are at handoff, which may be later than t0.
 *
 * Mandatory since Phase 5R. It used to default to the evaluation state, which
 * made the re-verification a tautology (ADR 0016).
 */
export type HandoffState = HandoffInputs;

export interface JevRoutingRequest {
  readonly route: RouteRequest;
  /** `null` runs the deterministic path and records why no call was made. */
  readonly transport: JevTransport | null;
  readonly policy?: Partial<JevPolicy>;
  readonly advisoryByRouteId?: Readonly<Record<string, RouteAdvisoryContext>>;
  /**
   * State to re-verify against before handoff. **Required.**
   *
   * A caller that genuinely has only one snapshot passes it twice, which is a
   * visible decision. A caller that cannot obtain fresh state has nothing to
   * pass, and the decision fails rather than silently reusing evaluation state.
   */
  readonly handoffState: HandoffState;
  /**
   * Optional latency guard for a sustained outage. Purely local, and it cannot
   * change which candidates are permitted (`availability.ts`).
   */
  readonly circuit?: AdvisoryCircuit;
  /** Milliseconds for the circuit's own bookkeeping. Defaults to `Date.now`. */
  readonly nowMs?: () => number;
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
  const nowMs = request.nowMs ?? (() => Date.now());
  const circuit = request.circuit;
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
  } else if (circuit !== undefined && !circuit.shouldAttempt(nowMs())) {
    // Sustained outage: skip the call rather than paying the deadline again.
    // The result is the same index 0 every other fallback reason produces.
    decided = deterministic(JevFallbackReason.CIRCUIT_OPEN, SelectionMode.JEV_FALLBACK);
  } else {
    decided = await consult(request.transport, policy, evaluation, set);
    if (circuit !== undefined) {
      // An abstention is a working model, not a failure.
      if (decided.outcome === JevOutcome.FALLBACK) circuit.recordFailure(nowMs());
      else circuit.recordSuccess();
    }
  }

  let routing = selectEvaluated(evaluation, decided.index, request.handoffState, verifier);

  // If the advisory choice fails handoff re-verification, fall back to index 0
  // and verify *that* — rather than ending the decision.
  //
  // ADR 0013 says every failure selects index 0, and this path was the one
  // exception: a hostile or merely unlucky model could turn an executable
  // decision into NO_VALID_ROUTE where the deterministic path would have
  // executed (finding F-13). Index 0 is a member of the same closed set and is
  // re-verified on the same handoff state, so nothing is relaxed — the model
  // simply no longer holds availability authority.
  if (routing.status === 'NO_VALID_ROUTE' && decided.index !== 0 && evaluation.admissible.length > 0) {
    const deterministicRouting = selectEvaluated(evaluation, 0, request.handoffState, verifier);
    if (deterministicRouting.status === 'SELECTED') {
      routing = deterministicRouting;
      decided = {
        ...decided,
        index: 0,
        outcome: JevOutcome.FALLBACK,
        mode: SelectionMode.JEV_FALLBACK,
        fallbackReason: JevFallbackReason.HANDOFF_REJECTED_FALLBACK,
      };
    }
  }
  const jevReceipt = decisionReceipt(evaluation, set, policy, decided);

  // There is exactly one handoff re-verification and the router performs it,
  // inside `selectEvaluated`, against the state supplied for the handoff. This
  // layer used to run a second one of its own; two implementations of one safety
  // check is the differential-consistency risk the pressure test warned about,
  // so the advisory layer now reports the router's verdict rather than repeating
  // the work.
  const handoffVerification = routing.status === 'SELECTED'
    ? routing.finalVerificationReceipt
    : routing.status === 'NO_VALID_ROUTE' ? routing.finalVerificationReceipt : null;

  if (routing.status !== 'SELECTED') {
    return {
      status: routing.status === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'NO_VALID_ROUTE',
      errors: routing.status === 'INVALID_INPUT' ? routing.errors : [],
      // True when a candidate passed at evaluation and stopped passing at
      // handoff, as distinct from nothing having been admissible at all.
      handoffRejected: handoffVerification !== null && handoffVerification.decision !== Decision.PASS,
      selectionMode: decided.mode,
      jevReceipt,
      routing,
      handoffVerification,
      selectionReceipt: selectionReceipt(evaluation, routing, jevReceipt, handoffVerification, deterministicCandidate),
      deterministicCandidate,
    } as JevRoutingResult;
  }

  const common = {
    selectionMode: decided.mode,
    jevReceipt,
    routing,
    handoffVerification: routing.finalVerificationReceipt,
    selectionReceipt: selectionReceipt(evaluation, routing, jevReceipt, routing.finalVerificationReceipt, deterministicCandidate),
    deterministicCandidate,
  };
  return { ...common, status: 'SELECTED', selected: routing.selected, handoffVerification: routing.finalVerificationReceipt };
}
