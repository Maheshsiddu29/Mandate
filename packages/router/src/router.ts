import {
  Decision,
  compareAmounts,
  mandateDigest,
  parseAmount,
  parseAuthorizationEnvelope,
  parseClock,
  parseEip712Domain,
  parseMandate,
  parseTrustedState,
  trustedStateDigest,
  verify,
  type Amount,
  type AuthorizationEnvelope,
  type CanonicalMandate,
  type Clock,
  type Eip712Domain,
  type TrustedState,
  type UnixSeconds,
  type VerificationReceipt,
  type VerifyRequest,
} from '@mandate/kernel';
import {
  Admissibility,
  deriveRequirements,
  evaluateRepresentation,
  listRepresentations,
  registrySnapshotDigest,
  type Registry,
  type RepresentationDecision,
} from '@mandate/registry';
import { buildRoutingCandidate } from './candidate.ts';
import { parseTrustedRouteCosts } from './cost-state.ts';
import { routingReceiptDigest } from './encoding.ts';
import { parseProviderRouteSet } from './provider.ts';
import {
  ROUTER_VERSION,
  ROUTING_RECEIPT_SCHEMA_VERSION,
  type RouteExclusion,
  type RouteOutcome,
  type RouteQuality,
  type RoutingCandidate,
  type RoutingReceipt,
  type RoutingResult,
} from './types.ts';

export interface RouteRequest {
  readonly mandate: unknown;
  readonly authorization: unknown;
  readonly registry: Registry;
  readonly trustedMarketState: unknown;
  readonly requestedQuantity: unknown;
  readonly routes: unknown;
  readonly trustedCosts: unknown;
  readonly clock: unknown;
  readonly expectedDomain: unknown;
}

type Verifier = (request: VerifyRequest) => VerificationReceipt;

/**
 * One kernel-PASS candidate, with the quality inputs its ranking position was
 * computed from and the receipt that admitted it.
 */
export interface AdmissibleRoute {
  readonly candidate: RoutingCandidate;
  readonly quality: RouteQuality;
  readonly verificationReceipt: VerificationReceipt;
}

/** The parsed, trusted inputs a routing decision was computed over. */
export interface RoutingContext {
  readonly mandate: CanonicalMandate;
  readonly authorization: AuthorizationEnvelope;
  readonly registry: Registry;
  readonly trustedState: TrustedState;
  readonly clock: Clock;
  readonly expectedDomain: Eip712Domain;
  readonly requestedQuantity: Amount;
}

/**
 * A closed admissible set and the inputs that produced it.
 *
 * `admissible` is already in the deterministic ranking order of ADR 0010 —
 * index 0 is the deterministic preferred candidate. Nothing outside this array
 * may become an execution handoff, and the array is complete: every route the
 * registry and the kernel admitted appears in it exactly once.
 */
export interface RoutingEvaluation {
  readonly context: RoutingContext;
  readonly admissible: readonly AdmissibleRoute[];
  readonly outcomes: readonly RouteOutcome[];
}

export type RoutingEvaluationResult =
  | { readonly status: 'EVALUATED'; readonly evaluation: RoutingEvaluation }
  | { readonly status: 'INVALID_INPUT'; readonly errors: readonly RouteExclusion[] };

/**
 * Stage one: parse, filter and rank. No selection and no final verification.
 *
 * Splitting evaluation from selection exists so an advisory selector can be
 * offered the already-closed admissible set without a second ranking
 * implementation. The ranking here is the only ranking in the system.
 */
export function evaluateRoutes(request: RouteRequest, verifier: Verifier = verify): RoutingEvaluationResult {
  const mandate = parseMandate(request.mandate);
  const authorization = parseAuthorizationEnvelope(request.authorization);
  const trustedState = parseTrustedState(request.trustedMarketState);
  const clock = parseClock(request.clock);
  const domain = parseEip712Domain(request.expectedDomain);
  const requestedQuantity = parseAmount(request.requestedQuantity);
  const quotes = parseProviderRouteSet(request.routes);
  const costs = parseTrustedRouteCosts(request.trustedCosts);
  const inputErrors: RouteExclusion[] = [];
  if (!mandate.ok) inputErrors.push(inputError('mandate', mandate.error));
  if (!authorization.ok) inputErrors.push(inputError('authorization', authorization.error));
  if (!trustedState.ok) inputErrors.push(inputError('trustedMarketState', trustedState.error));
  if (!clock.ok) inputErrors.push(inputError('clock', clock.error));
  if (!domain.ok) inputErrors.push(inputError('expectedDomain', domain.error));
  if (!requestedQuantity.ok) inputErrors.push(inputError('requestedQuantity', requestedQuantity.error));
  if (!quotes.ok) inputErrors.push(quotes.error);
  if (!costs.ok) inputErrors.push(costs.error);
  if (inputErrors.length > 0 || !mandate.ok || !authorization.ok || !trustedState.ok || !clock.ok || !domain.ok || !requestedQuantity.ok || !quotes.ok || !costs.ok) {
    return { status: 'INVALID_INPUT', errors: inputErrors };
  }

  const requirements = deriveRequirements(mandate.value, { nowUnixSeconds: clock.value.nowUnixSeconds });
  if (!requirements.ok) return { status: 'INVALID_INPUT', errors: [inputError('requirements', requirements.error)] };
  const discovered = listRepresentations(request.registry, requirements.value.canonicalAsset);
  const decisions = new Map<string, RepresentationDecision>();
  for (const representation of discovered) {
    decisions.set(representation.representationId.value, evaluateRepresentation(request.registry, requirements.value, representation.representationId.value));
  }

  const outcomes: RouteOutcome[] = [];
  const ranked: AdmissibleRoute[] = [];
  const candidateDigests = new Set<string>();
  for (const quote of quotes.value) {
    const registryDecision = decisions.get(quote.representationId);
    if (registryDecision === undefined) {
      outcomes.push(excluded(quote.routeId, [{ code: 'REPRESENTATION_NOT_DISCOVERABLE', detail: { representationId: quote.representationId } }]));
      continue;
    }
    if (registryDecision.status === Admissibility.EXCLUDED) {
      outcomes.push(excluded(quote.routeId, registryDecision.exclusions));
      continue;
    }
    const built = buildRoutingCandidate({
      mandate: mandate.value,
      quote,
      trustedState: trustedState.value,
      trustedCost: costs.value.get(quote.routeId),
      requestedQuantity: requestedQuantity.value,
      nowUnixSeconds: clock.value.nowUnixSeconds,
    });
    if (!built.ok) {
      outcomes.push(excluded(quote.routeId, built.exclusions));
      continue;
    }
    if (candidateDigests.has(built.candidate.candidateDigest)) {
      return { status: 'INVALID_INPUT', errors: [{ code: 'DUPLICATE_CANDIDATE', detail: { candidateDigest: built.candidate.candidateDigest } }] };
    }
    candidateDigests.add(built.candidate.candidateDigest);
    const verification = verifier({
      mandate: mandate.value,
      authorization: authorization.value,
      candidate: built.candidate.executionCandidate,
      trustedState: trustedState.value,
      clock: clock.value,
      expectedDomain: domain.value,
    });
    if (verification.decision === Decision.REJECT) {
      outcomes.push(excluded(quote.routeId, verification.violations.map((violation) => ({ code: violation.code, detail: violation.detail })), built.candidate.candidateDigest, verification));
      continue;
    }
    outcomes.push({
      routeId: quote.routeId,
      status: 'ADMISSIBLE',
      candidateDigest: built.candidate.candidateDigest,
      quality: built.quality,
      verificationReceipt: verification,
    });
    ranked.push({ candidate: built.candidate, quality: built.quality, verificationReceipt: verification });
  }

  ranked.sort((left, right) => compareRanked(left, right, mandate.value.side));
  const sortedOutcomes = [...outcomes].sort((left, right) => left.routeId < right.routeId ? -1 : left.routeId > right.routeId ? 1 : 0);
  return {
    status: 'EVALUATED',
    evaluation: {
      context: {
        mandate: mandate.value,
        authorization: authorization.value,
        registry: request.registry,
        trustedState: trustedState.value,
        clock: clock.value,
        expectedDomain: domain.value,
        requestedQuantity: requestedQuantity.value,
      },
      admissible: ranked,
      outcomes: sortedOutcomes,
    },
  };
}

/**
 * Stage two: re-verify one member of the closed set and build the receipt.
 *
 * `index` must address `evaluation.admissible`. An out-of-range index is a
 * caller defect rather than a financial decision, so it refuses the whole
 * evaluation instead of silently choosing something else.
 */
export function selectEvaluated(evaluation: RoutingEvaluation, index: number, verifier: Verifier = verify): RoutingResult {
  const { context, admissible, outcomes } = evaluation;
  if (admissible.length === 0) {
    return { status: 'NO_VALID_ROUTE', receipt: finishReceipt(context, outcomes, [], null, null) };
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= admissible.length) {
    return { status: 'INVALID_INPUT', errors: [{ code: 'INPUT_INVALID', detail: { input: 'selectedIndex', cause: String(index) } }] };
  }

  const selected = admissible[index] as AdmissibleRoute;
  const finalVerification = verifier({
    mandate: context.mandate,
    authorization: context.authorization,
    candidate: selected.candidate.executionCandidate,
    trustedState: context.trustedState,
    clock: context.clock,
    expectedDomain: context.expectedDomain,
  });
  const rankedDigests = admissible.map((item) => item.candidate.candidateDigest);
  if (finalVerification.decision !== Decision.PASS) {
    const revised = outcomes.map((outcome) => outcome.candidateDigest === selected.candidate.candidateDigest
      ? excluded(outcome.routeId, [{ code: 'FINAL_REVERIFICATION_FAILED', detail: { receiptDigest: finalVerification.receiptDigest } }], outcome.candidateDigest, finalVerification)
      : outcome);
    return { status: 'NO_VALID_ROUTE', receipt: finishReceipt(context, revised, rankedDigests, null, finalVerification.receiptDigest) };
  }
  return {
    status: 'SELECTED',
    selected: selected.candidate,
    finalVerificationReceipt: finalVerification,
    receipt: finishReceipt(context, outcomes, rankedDigests, selected.candidate.candidateDigest, finalVerification.receiptDigest),
  };
}

/**
 * The deterministic baseline: evaluate, take the top-ranked candidate, and
 * re-verify it. This is the only selection policy in the system; anything
 * advisory reuses these two stages rather than re-implementing either.
 */
export function route(request: RouteRequest, verifier: Verifier = verify): RoutingResult {
  const evaluated = evaluateRoutes(request, verifier);
  if (evaluated.status === 'INVALID_INPUT') return evaluated;
  return selectEvaluated(evaluated.evaluation, 0, verifier);
}

function compareRanked(left: AdmissibleRoute, right: AdmissibleRoute, side: 'BUY' | 'SELL'): number {
  const economic = compareAmounts(left.quality.economicValue, right.quality.economicValue);
  if (economic.ok && economic.value !== 0) return side === 'BUY' ? economic.value : -economic.value;
  if (left.quality.executionDeviationBps !== right.quality.executionDeviationBps) return left.quality.executionDeviationBps < right.quality.executionDeviationBps ? -1 : 1;
  if (left.quality.quoteAgeSeconds !== right.quality.quoteAgeSeconds) return left.quality.quoteAgeSeconds < right.quality.quoteAgeSeconds ? -1 : 1;
  if (left.quality.routeSteps !== right.quality.routeSteps) return left.quality.routeSteps - right.quality.routeSteps;
  return left.candidate.candidateDigest < right.candidate.candidateDigest ? -1 : left.candidate.candidateDigest > right.candidate.candidateDigest ? 1 : 0;
}

function excluded(routeId: string, exclusions: readonly RouteExclusion[], candidateDigest: RouteOutcome['candidateDigest'] = null, verificationReceipt: VerificationReceipt | null = null): RouteOutcome {
  return { routeId, status: 'EXCLUDED', candidateDigest, exclusions: canonicalExclusions(exclusions), verificationReceipt };
}

function canonicalExclusions(exclusions: readonly RouteExclusion[]): RouteExclusion[] {
  const keyed = new Map<string, RouteExclusion>();
  for (const item of exclusions) {
    const key = `${item.code}:${Object.entries(item.detail).sort().map(([name, value]) => `${name}=${value}`).join('|')}`;
    if (!keyed.has(key)) keyed.set(key, item);
  }
  return [...keyed.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, item]) => item);
}

function inputError(input: string, cause: string): RouteExclusion {
  return { code: 'INPUT_INVALID', detail: { input, cause } };
}

function finishReceipt(
  context: RoutingContext,
  outcomes: readonly RouteOutcome[],
  rankedCandidateDigests: RoutingReceipt['rankedCandidateDigests'],
  selectedCandidateDigest: RoutingReceipt['selectedCandidateDigest'],
  finalVerificationReceiptDigest: RoutingReceipt['finalVerificationReceiptDigest'],
): RoutingReceipt {
  const unsigned = {
    version: ROUTING_RECEIPT_SCHEMA_VERSION,
    routerVersion: ROUTER_VERSION,
    mandateDigest: mandateDigest(context.mandate),
    registrySnapshotDigest: registrySnapshotDigest(context.registry.snapshot),
    marketStateDigest: trustedStateDigest(context.trustedState),
    requestedQuantity: context.requestedQuantity,
    outcomes,
    rankedCandidateDigests,
    selectedCandidateDigest,
    finalVerificationReceiptDigest,
    evaluatedAtUnixSeconds: context.clock.nowUnixSeconds as UnixSeconds,
  };
  return { ...unsigned, receiptDigest: routingReceiptDigest(unsigned) };
}
