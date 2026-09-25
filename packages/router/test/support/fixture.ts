import { parseClock, parseEip712Domain, parseMandate, parseTrustedState, type Amount, type CanonicalMandate, type ExecutionCandidate, type TrustedState, type UnixSeconds } from '@mandate/kernel';
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
  referenceStateId: string; corporateActionEpoch: bigint;
};

export function zeroFee(): Amount {
  return { unit: parsedCandidate.notional.unit, decimals: parsedCandidate.notional.decimals, atoms: 0n };
}

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
    referenceStateId: parsedCandidate.referenceStateId,
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

export function sellMandate(): CanonicalMandate {
  return { ...ROUTER_MANDATE, side: 'SELL' };
}

export function stateWithReference(atoms: bigint): TrustedState {
  if (ROUTER_STATE.market === null || ROUTER_STATE.market.value.referencePrice === null) throw new Error('missing fixture market');
  return {
    ...ROUTER_STATE,
    market: { ...ROUTER_STATE.market, value: { ...ROUTER_STATE.market.value, referencePrice: { ...ROUTER_STATE.market.value.referencePrice, atoms } } },
  };
}
