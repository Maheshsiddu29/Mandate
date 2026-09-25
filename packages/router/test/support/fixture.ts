import { parseBytes32, parseClock, parseEip712Domain, parseMandate, parseTrustedState, type Amount, type CanonicalMandate, type ExecutionCandidate, type TrustedState, type UnixSeconds } from '@mandate/kernel';
import { buildReplayWorld } from '../../../adapter-robinhood/test/support/mainnet-replay.ts';
import type { ProviderRouteQuote, TrustedRouteCost } from '../../src/index.ts';

const replay = buildReplayWorld({
  id: 'mainnet-nvda-pass', symbol: 'NVDA', mutation: 'NONE', stateClass: 'RECORDED_MAINNET',
  description: 'Router fixture grounded in the recorded NVDA state.',
});
const mandateResult = parseMandate(replay.request.mandate);
const stateResult = parseTrustedState(replay.request.trustedState);
const clockResult = parseClock(replay.request.clock);
const domainResult = parseEip712Domain(replay.request.expectedDomain);
if (!mandateResult.ok || !stateResult.ok || !clockResult.ok || !domainResult.ok) throw new Error('invalid router fixture');

export const ROUTER_MANDATE = mandateResult.value;
export const ROUTER_STATE = stateResult.value;
export const ROUTER_CLOCK = clockResult.value.nowUnixSeconds;
export const ROUTER_AUTHORIZATION = replay.request.authorization;
export const ROUTER_DOMAIN = domainResult.value;
export const ROUTER_REGISTRY_INPUT = replay.registryInput;

const sourceCandidate = replay.request.candidate as Record<string, unknown>;
const parsedCandidate = sourceCandidate as unknown as {
  representationId: ExecutionCandidate['representationId']; canonicalAsset: CanonicalMandate['canonicalAsset']; issuer: ExecutionCandidate['issuer'];
  chain: ExecutionCandidate['chain']; venue: ExecutionCandidate['venue']; side: 'BUY' | 'SELL'; agent: CanonicalMandate['agent'];
  quantity: Amount; executionPrice: ProviderRouteQuote['executionPrice']; notional: Amount;
  evaluationStateId: string; registrySnapshotDigest: string; corporateActionEpoch: bigint;
};

export function zeroFee(): Amount {
  return { unit: parsedCandidate.notional.unit, decimals: parsedCandidate.notional.decimals, atoms: 0n };
}

export const ROUTER_REQUESTED_QUANTITY = parsedCandidate.quantity;

export function routeQuote(patch: Partial<ProviderRouteQuote> = {}): ProviderRouteQuote {
  const zero = zeroFee();
  return {
    version: 1,
    routeId: 'route.alpha',
    providerId: 'provider.fixture',
    providerClass: 'SYNTHETIC_TEST',
    canonicalAsset: parsedCandidate.canonicalAsset,
    representationId: parsedCandidate.representationId,
    issuer: parsedCandidate.issuer,
    chain: parsedCandidate.chain,
    venue: parsedCandidate.venue,
    side: parsedCandidate.side,
    agent: parsedCandidate.agent,
    quantity: parsedCandidate.quantity,
    executionPrice: parsedCandidate.executionPrice,
    notional: parsedCandidate.notional,
    quoteObservedAtUnixSeconds: ROUTER_CLOCK,
    fillPolicy: 'FILL_OR_KILL',
    costs: { venueFee: zero, executionFee: zero, settlementFee: zero, routeFee: zero },
    steps: [{ kind: 'TRADE', venue: parsedCandidate.venue, chain: parsedCandidate.chain, representationId: parsedCandidate.representationId }],
    referenceStateId: parsedCandidate.evaluationStateId,
    corporateActionEpoch: parsedCandidate.corporateActionEpoch,
    ...patch,
  };
}

export function trustedCost(quote: ProviderRouteQuote, patch: Partial<TrustedRouteCost> = {}): TrustedRouteCost {
  return {
    routeId: quote.routeId,
    costs: quote.costs,
    provenanceSourceId: 'trusted.fixture.costs',
    observedAtUnixSeconds: ROUTER_CLOCK as UnixSeconds,
    ...patch,
  };
}

/**
 * The fixture mandate as a SELL.
 *
 * `economicLimit` has to be re-read, not just inherited: on a BUY it is a
 * maximum total debit and on a SELL it is a minimum total credit (ADR 0014), so
 * carrying the BUY value over would demand proceeds of twice the notional and
 * refuse every route. Half the notional is a live floor that the fixture's
 * zero-fee routes clear comfortably; tests about the floor itself set their own.
 */
export function sellMandate(): CanonicalMandate {
  return {
    ...ROUTER_MANDATE,
    side: 'SELL',
    economicLimit: { ...ROUTER_MANDATE.economicLimit, atoms: parsedCandidate.notional.atoms / 2n },
  };
}

/** A SELL mandate with an explicit minimum-credit floor, in notional atoms. */
export function sellMandateWithFloor(atoms: bigint): CanonicalMandate {
  return { ...sellMandate(), economicLimit: { ...ROUTER_MANDATE.economicLimit, atoms } };
}

export function stateWithReference(atoms: bigint): TrustedState {
  if (ROUTER_STATE.market === null || ROUTER_STATE.market.value.referencePrice === null) throw new Error('missing fixture market');
  return {
    ...ROUTER_STATE,
    market: { ...ROUTER_STATE.market, value: { ...ROUTER_STATE.market.value, referencePrice: { ...ROUTER_STATE.market.value.referencePrice, atoms } } },
  };
}

/**
 * Handoff inputs for a world that evaluates and hands off against one snapshot.
 *
 * Schema v2 and ADR 0016 make the handoff explicit, so tests that are not about
 * time or state change say so by passing this. Tests that *are* about it build
 * their own, which is the point: reusing the evaluation state is now a visible
 * choice rather than the default.
 */
export function routerHandoff(overrides: Partial<{ trustedMarketState: unknown; clock: unknown }> = {}) {
  return {
    trustedMarketState: ROUTER_STATE,
    clock: { nowUnixSeconds: ROUTER_CLOCK },
    ...overrides,
  };
}

/**
 * Handoff inputs derived from a request's own inputs.
 *
 * For worlds that build their own trusted state — a re-signed mandate changes
 * the replay record, for instance — so the handoff sees the same world the
 * evaluation did rather than the module-level fixture.
 */
export function handoffFor(request: { readonly trustedMarketState: unknown; readonly clock: unknown }) {
  return { trustedMarketState: request.trustedMarketState, clock: request.clock };
}

/** The registry snapshot digest the fixture's state and candidates are bound to. */
export const ROUTER_REGISTRY_SNAPSHOT_DIGEST = (() => {
  const parsed = parseBytes32(parsedCandidate.registrySnapshotDigest, 'MALFORMED_CANDIDATE');
  if (!parsed.ok) throw new Error('router fixture has no registry snapshot digest');
  return parsed.value;
})();

/** The recorded state with trading halted, for handoff-freshness tests. */
export function haltedRouterState(): TrustedState {
  if (ROUTER_STATE.market === null) throw new Error('fixture has no market state');
  return { ...ROUTER_STATE, market: { ...ROUTER_STATE.market, value: { ...ROUTER_STATE.market.value, haltStatus: 'HALTED' } } };
}

/** The recorded state with one representation paused, for handoff-freshness tests. */
export function pausedRepresentationState(): TrustedState {
  return {
    ...ROUTER_STATE,
    representations: ROUTER_STATE.representations.map((observed) => ({
      ...observed,
      value: { ...observed.value, operationalState: 'PAUSED' as const },
    })),
  };
}
