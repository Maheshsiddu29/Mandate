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
  type CanonicalMandate,
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

interface Ranked {
  readonly candidate: RoutingCandidate;
  readonly quality: RouteQuality;
  readonly receipt: VerificationReceipt;
}

type Verifier = (request: VerifyRequest) => VerificationReceipt;

export function route(request: RouteRequest, verifier: Verifier = verify): RoutingResult {
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
  const ranked: Ranked[] = [];
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
    ranked.push({ candidate: built.candidate, quality: built.quality, receipt: verification });
  }

  ranked.sort((left, right) => compareRanked(left, right, mandate.value.side));
  const sortedOutcomes = [...outcomes].sort((left, right) => left.routeId < right.routeId ? -1 : left.routeId > right.routeId ? 1 : 0);
  if (ranked.length === 0) {
    return { status: 'NO_VALID_ROUTE', receipt: finishReceipt(request.registry, mandate.value, trustedState.value, clock.value.nowUnixSeconds, sortedOutcomes, [], null, null) };
  }

  const selected = ranked[0] as Ranked;
  const finalVerification = verifier({
    mandate: mandate.value,
    authorization: authorization.value,
    candidate: selected.candidate.executionCandidate,
    trustedState: trustedState.value,
    clock: clock.value,
    expectedDomain: domain.value,
  });
  const rankedDigests = ranked.map((item) => item.candidate.candidateDigest);
  if (finalVerification.decision !== Decision.PASS) {
    const revised = sortedOutcomes.map((outcome) => outcome.candidateDigest === selected.candidate.candidateDigest
      ? excluded(outcome.routeId, [{ code: 'FINAL_REVERIFICATION_FAILED', detail: { receiptDigest: finalVerification.receiptDigest } }], outcome.candidateDigest, finalVerification)
      : outcome);
    return { status: 'NO_VALID_ROUTE', receipt: finishReceipt(request.registry, mandate.value, trustedState.value, clock.value.nowUnixSeconds, revised, rankedDigests, null, finalVerification.receiptDigest) };
  }
  return {
    status: 'SELECTED',
    selected: selected.candidate,
    finalVerificationReceipt: finalVerification,
    receipt: finishReceipt(request.registry, mandate.value, trustedState.value, clock.value.nowUnixSeconds, sortedOutcomes, rankedDigests, selected.candidate.candidateDigest, finalVerification.receiptDigest),
  };
}

function compareRanked(left: Ranked, right: Ranked, side: 'BUY' | 'SELL'): number {
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
  registry: Registry,
  mandate: CanonicalMandate,
  state: TrustedState,
  evaluatedAtUnixSeconds: UnixSeconds,
  outcomes: readonly RouteOutcome[],
  rankedCandidateDigests: RoutingReceipt['rankedCandidateDigests'],
  selectedCandidateDigest: RoutingReceipt['selectedCandidateDigest'],
  finalVerificationReceiptDigest: RoutingReceipt['finalVerificationReceiptDigest'],
): RoutingReceipt {
  const unsigned = {
    version: ROUTING_RECEIPT_SCHEMA_VERSION,
    routerVersion: ROUTER_VERSION,
    mandateDigest: mandateDigest(mandate),
    registrySnapshotDigest: registrySnapshotDigest(registry.snapshot),
    marketStateDigest: trustedStateDigest(state),
    outcomes,
    rankedCandidateDigests,
    selectedCandidateDigest,
    finalVerificationReceiptDigest,
    evaluatedAtUnixSeconds,
  };
  return { ...unsigned, receiptDigest: routingReceiptDigest(unsigned) };
}
