import {
  UINT256_MAX,
  candidateDigest as digestKernelCandidate,
  canonicalAssetIdEquals,
  deviationBps,
  findRepresentation,
  parseCandidate,
  partyIdEquals,
  trustedStateDigest,
  type Amount,
  type Bytes32,
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

/** Commensurable: one unit, one decimal scale. Atoms of two scales are not addable. */
function sameUnitAndScale(left: Amount, right: Amount): boolean {
  return left.unit === right.unit && left.decimals === right.decimals;
}

const COST_NAMES = ['venueFee', 'executionFee', 'settlementFee', 'routeFee'] as const;

/**
 * Establish the route's explicit costs, in three ordered passes.
 *
 * The order is the point, and it is why this is written as passes rather than one
 * loop:
 *
 * 1. **Commensurability.** Every quoted and every independently established cost
 *    must be denominated in the notional's unit *and* at the notional's decimal
 *    scale. This runs first and returns before anything is added, so atoms of
 *    two different units can never reach the summation. Before Phase 5R.1 the
 *    unit check sat behind a `continue` for a null component that `knownCosts`
 *    had already excluded, which made it look conditional; the branch was dead
 *    and is gone.
 * 2. **Agreement with independent cost state.** The provider's numbers must equal
 *    the ones established outside it.
 * 3. **Summation.** Only now, over values proven commensurable, and bounded.
 *
 * The total is *established* here; whether it is within the principal's authority
 * is the kernel's decision (ADR 0014).
 */
function validateCosts(
  quoteCosts: RouteCosts,
  trusted: TrustedRouteCost | undefined,
  notional: Amount,
): { readonly ok: true; readonly costs: RoutingCandidate['costs']; readonly total: Amount } | { readonly ok: false; readonly exclusions: readonly RouteExclusion[] } {
  if (!knownCosts(quoteCosts) || trusted === undefined) {
    return { ok: false, exclusions: [exclusion('UNKNOWN_COST')] };
  }
  const establishedCosts = trusted.costs;
  if (!knownCosts(establishedCosts)) return { ok: false, exclusions: [exclusion('UNKNOWN_COST')] };

  // Pass 1: commensurability, on both sides, before any arithmetic.
  const incommensurable: RouteExclusion[] = [];
  for (const name of COST_NAMES) {
    if (!sameUnitAndScale(quoteCosts[name], notional)) {
      incommensurable.push(exclusion('COST_UNIT_MISMATCH', { component: name, source: 'quote' }));
    }
    if (!sameUnitAndScale(establishedCosts[name], notional)) {
      incommensurable.push(exclusion('COST_UNIT_MISMATCH', { component: name, source: 'trusted' }));
    }
  }
  if (incommensurable.length > 0) return { ok: false, exclusions: incommensurable };

  // Pass 2: agreement with the independently established costs.
  const disagreements: RouteExclusion[] = [];
  for (const name of COST_NAMES) {
    if (!sameAmount(quoteCosts[name], establishedCosts[name])) {
      disagreements.push(exclusion('UNTRUSTED_COST_MISMATCH', { component: name }));
    }
  }
  if (disagreements.length > 0) return { ok: false, exclusions: disagreements };

  // Pass 3: summation. Every term is now in the notional's unit and scale, so
  // adding atoms is exact and meaningful.
  const atoms = COST_NAMES.reduce((sum, name) => sum + quoteCosts[name].atoms, 0n);
  if (atoms > UINT256_MAX) return { ok: false, exclusions: [exclusion('COST_OVERFLOW')] };
  return { ok: true, costs: quoteCosts, total: { unit: notional.unit, decimals: notional.decimals, atoms } };
}

function validateIdentity(quote: ProviderRouteQuote, mandate: CanonicalMandate, state: TrustedState): RouteExclusion[] {
  const failures: RouteExclusion[] = [];
  if (!canonicalAssetIdEquals(quote.canonicalAsset, mandate.canonicalAsset)) failures.push(exclusion('PROVIDER_IDENTITY_MISMATCH', { field: 'canonicalAsset' }));
  if (quote.side !== mandate.side) failures.push(exclusion('PROVIDER_IDENTITY_MISMATCH', { field: 'side' }));
  if (!partyIdEquals(quote.agent, mandate.agent)) failures.push(exclusion('PROVIDER_IDENTITY_MISMATCH', { field: 'agent' }));
  // The provider names the snapshot it quoted against; at *evaluation* the state
  // in hand is that snapshot, so this comparison is meaningful here and nowhere
  // else. The kernel deliberately does not repeat it, because at handoff a
  // different label is expected (ADR 0017).
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
  /** Digest of the registry snapshot the caller evaluated. Bound into the candidate. */
  readonly registrySnapshotDigest: Bytes32;
}): CandidateBuildResult {
  const { mandate, quote, trustedState, trustedCost, requestedQuantity, nowUnixSeconds, registrySnapshotDigest } = input;
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
    version: 3,
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
    feeTotal: costs.total,
    // Provenance of the world this candidate came out of. Computed by the router
    // from the state it actually used, so a provider cannot influence either
    // value, and never compared against the handoff state (ADR 0017).
    evaluationStateId: quote.referenceStateId,
    evaluationStateDigest: trustedStateDigest(trustedState),
    // Structural authority, and the one state binding the kernel checks for
    // equality. Taken from the registry the router evaluated, not from the state
    // and not from the provider.
    registrySnapshotDigest,
    corporateActionEpoch: quote.corporateActionEpoch,
  });
  if (!parsed.ok) return { ok: false, exclusions: [exclusion(parsed.error)] };
  const deviation = deviationBps(parsed.value.executionPrice, market.value.referencePrice);
  if (!deviation.ok) return { ok: false, exclusions: [exclusion(deviation.error)] };

  // Economic *quality*, for ranking only. Whether this candidate is within the
  // principal's authority is the kernel's decision and nothing here duplicates
  // it: TOTAL_COST_EXCEEDS_MANDATE and SELL_FEES_EXCEED_PROCEEDS used to live
  // here and are now TOTAL_DEBIT_EXCEEDED, TOTAL_CREDIT_BELOW_MINIMUM and
  // FEES_EXCEED_NOTIONAL in `checkEconomicLimit` (ADR 0014). A second economic
  // gate in a component that does not authorize is exactly the differential
  // -consistency risk the pressure test flagged.
  const feeAtoms = costs.total.atoms;
  let economicAtoms: bigint;
  if (mandate.side === 'BUY') {
    economicAtoms = quote.notional.atoms + feeAtoms;
    if (economicAtoms > UINT256_MAX) return { ok: false, exclusions: [exclusion('COST_OVERFLOW')] };
  } else {
    // A ranking value, not a permission: a net debit sorts last rather than
    // being refused here, and the kernel refuses it.
    economicAtoms = feeAtoms >= quote.notional.atoms ? 0n : quote.notional.atoms - feeAtoms;
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
    feeTotal: costs.total,
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
