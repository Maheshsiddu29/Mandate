import {
  UINT256_MAX,
  candidateDigest as digestKernelCandidate,
  canonicalAssetIdEquals,
  deviationBps,
  findRepresentation,
  parseCandidate,
  partyIdEquals,
  type Amount,
  type CanonicalMandate,
  type TrustedState,
  type UnixSeconds,
} from '@mandate/kernel';
import { routingCandidateDigest } from './encoding.ts';
import type {
  ProviderRouteQuote,
  RouteCosts,
  RouteExclusion,
  RouteQuality,
  RoutingCandidate,
  TrustedRouteCost,
} from './types.ts';

export type CandidateBuildResult =
  | { readonly ok: true; readonly candidate: RoutingCandidate; readonly quality: RouteQuality }
  | { readonly ok: false; readonly exclusions: readonly RouteExclusion[] };

function exclusion(code: RouteExclusion['code'], detail: Readonly<Record<string, string>> = {}): RouteExclusion {
  return { code, detail };
}

function knownCosts(costs: RouteCosts): costs is RoutingCandidate['costs'] {
  return costs.venueFee !== null && costs.executionFee !== null && costs.settlementFee !== null && costs.routeFee !== null;
}

function sameAmount(left: Amount, right: Amount): boolean {
  return left.unit === right.unit && left.decimals === right.decimals && left.atoms === right.atoms;
}

function validateCosts(
  quoteCosts: RouteCosts,
  trusted: TrustedRouteCost | undefined,
  notional: Amount,
): { readonly ok: true; readonly costs: RoutingCandidate['costs']; readonly total: Amount } | { readonly ok: false; readonly exclusions: readonly RouteExclusion[] } {
  if (!knownCosts(quoteCosts) || trusted === undefined || !knownCosts(trusted.costs)) {
    return { ok: false, exclusions: [exclusion('UNKNOWN_COST')] };
  }
  const names = ['venueFee', 'executionFee', 'settlementFee', 'routeFee'] as const;
  const failures: RouteExclusion[] = [];
  for (const name of names) {
    const quoted = quoteCosts[name];
    const established = trusted.costs[name];
    if (established === null) continue;
    if (!sameAmount(quoted, established)) failures.push(exclusion('UNTRUSTED_COST_MISMATCH', { component: name }));
    if (quoted.unit !== notional.unit || quoted.decimals !== notional.decimals) failures.push(exclusion('COST_UNIT_MISMATCH', { component: name }));
  }
  if (failures.length > 0) return { ok: false, exclusions: failures };
  const atoms = names.reduce((sum, name) => sum + quoteCosts[name].atoms, 0n);
  if (atoms > UINT256_MAX) return { ok: false, exclusions: [exclusion('COST_OVERFLOW')] };
  return { ok: true, costs: quoteCosts, total: { unit: notional.unit, decimals: notional.decimals, atoms } };
}

function validateIdentity(quote: ProviderRouteQuote, mandate: CanonicalMandate, state: TrustedState): RouteExclusion[] {
  const failures: RouteExclusion[] = [];
  if (!canonicalAssetIdEquals(quote.canonicalAsset, mandate.canonicalAsset)) failures.push(exclusion('PROVIDER_IDENTITY_MISMATCH', { field: 'canonicalAsset' }));
  if (quote.side !== mandate.side) failures.push(exclusion('PROVIDER_IDENTITY_MISMATCH', { field: 'side' }));
  if (!partyIdEquals(quote.agent, mandate.agent)) failures.push(exclusion('PROVIDER_IDENTITY_MISMATCH', { field: 'agent' }));
  if (quote.referenceStateId !== state.stateId) failures.push(exclusion('PROVIDER_IDENTITY_MISMATCH', { field: 'referenceStateId' }));
  const representation = findRepresentation(state, quote.representationId);
  if (representation === undefined) failures.push(exclusion('REPRESENTATION_NOT_DISCOVERABLE', { representationId: quote.representationId }));
  else {
    if (!canonicalAssetIdEquals(representation.value.canonicalAsset, mandate.canonicalAsset)) failures.push(exclusion('PROVIDER_IDENTITY_MISMATCH', { field: 'representationCanonicalAsset' }));
    if (representation.value.issuer !== quote.issuer) failures.push(exclusion('PROVIDER_IDENTITY_MISMATCH', { field: 'issuer' }));
    if (representation.value.chain !== quote.chain) failures.push(exclusion('PROVIDER_IDENTITY_MISMATCH', { field: 'chain' }));
  }
  if (quote.steps.some((step) => step.representationId !== quote.representationId || step.chain !== quote.chain || step.venue !== quote.venue)) {
    failures.push(exclusion('PROVIDER_IDENTITY_MISMATCH', { field: 'steps' }));
  }
  return failures;
}

export function buildRoutingCandidate(input: {
  readonly mandate: CanonicalMandate;
  readonly quote: ProviderRouteQuote;
  readonly trustedState: TrustedState;
  readonly trustedCost: TrustedRouteCost | undefined;
  readonly requestedQuantity: Amount;
  readonly nowUnixSeconds: UnixSeconds;
}): CandidateBuildResult {
  const { mandate, quote, trustedState, trustedCost, requestedQuantity, nowUnixSeconds } = input;
  const failures = validateIdentity(quote, mandate, trustedState);
  if (!sameAmount(quote.quantity, requestedQuantity)) failures.push(exclusion('REQUESTED_QUANTITY_MISMATCH'));
  if (quote.fillPolicy !== 'FILL_OR_KILL') failures.push(exclusion('PARTIAL_FILL_UNSUPPORTED'));
  const age = nowUnixSeconds - quote.quoteObservedAtUnixSeconds;
  if (age < 0n) failures.push(exclusion('QUOTE_FROM_FUTURE', { ageSeconds: String(age) }));
  else if (age > mandate.maxPriceAgeSeconds) failures.push(exclusion('QUOTE_STALE', { ageSeconds: String(age), maximumSeconds: String(mandate.maxPriceAgeSeconds) }));
  const market = trustedState.market;
  if (market === null || market.value.referencePrice === null) failures.push(exclusion('MARKET_STATE_UNKNOWN'));
  if (trustedCost !== undefined) {
    const costAge = nowUnixSeconds - trustedCost.observedAtUnixSeconds;
    if (costAge < 0n) failures.push(exclusion('COST_STATE_FUTURE', { ageSeconds: String(costAge) }));
    else if (costAge > mandate.maxPriceAgeSeconds) failures.push(exclusion('COST_STATE_STALE', { ageSeconds: String(costAge), maximumSeconds: String(mandate.maxPriceAgeSeconds) }));
  }
  const costs = validateCosts(quote.costs, trustedCost, quote.notional);
  if (!costs.ok) failures.push(...costs.exclusions);
  if (failures.length > 0 || market === null || market.value.referencePrice === null || !costs.ok || trustedCost === undefined) {
    return { ok: false, exclusions: canonicalize(failures) };
  }

  const parsed = parseCandidate({
    version: 1,
    representationId: quote.representationId,
    canonicalAsset: quote.canonicalAsset,
    issuer: quote.issuer,
    chain: quote.chain,
    venue: quote.venue,
    side: quote.side,
    agent: quote.agent,
    quantity: quote.quantity,
    executionPrice: quote.executionPrice,
    notional: quote.notional,
    referenceStateId: quote.referenceStateId,
    corporateActionEpoch: quote.corporateActionEpoch,
  });
  if (!parsed.ok) return { ok: false, exclusions: [exclusion(parsed.error)] };
  const deviation = deviationBps(parsed.value.executionPrice, market.value.referencePrice);
  if (!deviation.ok) return { ok: false, exclusions: [exclusion(deviation.error)] };

  const feeAtoms = costs.total.atoms;
  let economicAtoms: bigint;
  if (mandate.side === 'BUY') {
    economicAtoms = quote.notional.atoms + feeAtoms;
    if (economicAtoms > UINT256_MAX) return { ok: false, exclusions: [exclusion('COST_OVERFLOW')] };
  } else {
    if (feeAtoms >= quote.notional.atoms) return { ok: false, exclusions: [exclusion('SELL_FEES_EXCEED_PROCEEDS')] };
    economicAtoms = quote.notional.atoms - feeAtoms;
  }

  const unsigned = {
    version: 1 as const,
    routeId: quote.routeId,
    providerId: quote.providerId,
    providerClass: quote.providerClass,
    fillPolicy: 'FILL_OR_KILL' as const,
    quoteObservedAtUnixSeconds: quote.quoteObservedAtUnixSeconds,
    referenceObservedAtUnixSeconds: market.provenance.observedAtUnixSeconds,
    referencePrice: market.value.referencePrice,
    trustedCostSourceId: trustedCost.provenanceSourceId,
    trustedCostObservedAtUnixSeconds: trustedCost.observedAtUnixSeconds,
    costs: costs.costs,
    steps: quote.steps,
    executionCandidate: parsed.value,
  };
  const candidate: RoutingCandidate = {
    ...unsigned,
    kernelCandidateDigest: digestKernelCandidate(parsed.value),
    candidateDigest: routingCandidateDigest(unsigned),
  };
  return {
    ok: true,
    candidate,
    quality: {
      economicValue: { unit: quote.notional.unit, decimals: quote.notional.decimals, atoms: economicAtoms },
      executionDeviationBps: deviation.value,
      quoteAgeSeconds: age,
      routeSteps: quote.steps.length,
      explicitFeeTotal: costs.total,
    },
  };
}

function canonicalize(values: readonly RouteExclusion[]): RouteExclusion[] {
  const keyed = new Map<string, RouteExclusion>();
  for (const value of values) {
    const key = `${value.code}:${Object.entries(value.detail).sort().map(([name, item]) => `${name}=${item}`).join('|')}`;
    if (!keyed.has(key)) keyed.set(key, value);
  }
  return [...keyed.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, value]) => value);
}
