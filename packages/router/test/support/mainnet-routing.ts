import {
  mandateDigest, parseClock, parseEip712Domain, parseIdentifier, parseMandate, parseTrustedState, trustedStateDigest,
  type Amount, type CanonicalMandate, type ExecutionCandidate,
} from '@mandate/kernel';
import { openRegistry, registrySnapshotDigest } from '@mandate/registry';
import { buildReplayWorld } from '../../../adapter-robinhood/test/support/mainnet-replay.ts';
import { FIXTURE_SYMBOLS } from '../../../adapter-robinhood/test/support/mainnet-fixture.ts';
import { route, type ProviderRouteQuote, type RouteRequest, type TrustedRouteCost } from '../../src/index.ts';

export const MAINNET_ROUTING_CORPUS_VERSION = 1;

function expect<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${String(result.error)}`);
  return result.value;
}

function makeWorld(symbol: typeof FIXTURE_SYMBOLS[number]) {
  const replay = buildReplayWorld({
    id: `mainnet-${symbol.toLowerCase()}-pass`, symbol, mutation: 'NONE', stateClass: 'RECORDED_MAINNET',
    description: `${symbol} recorded state with synthetic route economics.`,
  });
  const mandate = expect(parseMandate(replay.request.mandate), 'mandate');
  const state = expect(parseTrustedState(replay.request.trustedState), 'state');
  const clock = expect(parseClock(replay.request.clock), 'clock');
  const domain = expect(parseEip712Domain(replay.request.expectedDomain), 'domain');
  const registry = expect(openRegistry(replay.registryInput), 'registry');
  const source = replay.request.candidate as {
    representationId: ExecutionCandidate['representationId']; canonicalAsset: CanonicalMandate['canonicalAsset'];
    issuer: ExecutionCandidate['issuer']; chain: ExecutionCandidate['chain']; venue: ExecutionCandidate['venue'];
    side: 'BUY' | 'SELL'; agent: ExecutionCandidate['agent']; quantity: Amount;
    executionPrice: ExecutionCandidate['executionPrice']; notional: Amount; evaluationStateId: string;
    corporateActionEpoch: bigint;
  };
  const zero = { unit: source.notional.unit, decimals: source.notional.decimals, atoms: 0n };
  const quote = (routeId: string, feeAtoms: bigint, issuer = source.issuer): ProviderRouteQuote => ({
    version: 1, routeId, providerId: 'provider.mainnet-routing-replay', providerClass: 'SYNTHETIC_TEST',
    canonicalAsset: source.canonicalAsset, representationId: source.representationId, issuer,
    chain: source.chain, venue: source.venue, side: source.side, agent: source.agent,
    quantity: source.quantity, executionPrice: source.executionPrice, notional: source.notional,
    quoteObservedAtUnixSeconds: clock.nowUnixSeconds, fillPolicy: 'FILL_OR_KILL',
    costs: { venueFee: { ...zero, atoms: feeAtoms }, executionFee: zero, settlementFee: zero, routeFee: zero },
    steps: [{ kind: 'TRADE', venue: source.venue, chain: source.chain, representationId: source.representationId }],
    referenceStateId: source.evaluationStateId, corporateActionEpoch: source.corporateActionEpoch,
  });
  const cheap = quote(`route.${symbol.toLowerCase()}.valid-cheap`, 100n);
  const expensive = quote(`route.${symbol.toLowerCase()}.valid-expensive`, 500n);
  const attackerIssuer = expect(parseIdentifier('issuer.attacker'), 'attacker issuer');
  const attacker = quote(`route.${symbol.toLowerCase()}.malicious-cheapest`, 0n, attackerIssuer);
  const trusted = (item: ProviderRouteQuote): TrustedRouteCost => ({
    routeId: item.routeId, costs: item.costs, provenanceSourceId: 'synthetic.mainnet-routing-costs',
    observedAtUnixSeconds: clock.nowUnixSeconds,
  });
  const routes = [attacker, expensive, cheap];
  const request: RouteRequest = {
    mandate, authorization: replay.request.authorization, registry, trustedMarketState: state,
    requestedQuantity: source.quantity,
    routes, trustedCosts: routes.map(trusted), clock, expectedDomain: domain,
  };
  return { symbol, request, routes, registry, mandate, state, clock };
}

function json(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(json);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, json(item)]));
  }
  return value;
}

export function buildMainnetRoutingCorpus(): Record<string, unknown> {
  const vectors = FIXTURE_SYMBOLS.map((symbol) => {
    const world = makeWorld(symbol);
    const result = route(world.request, { trustedMarketState: world.request.trustedMarketState, clock: world.request.clock });
    if (result.status !== 'SELECTED') throw new Error(`${symbol} routing did not select`);
    const replayed = route(
      { ...world.request, routes: [...world.routes].reverse() },
      { trustedMarketState: world.request.trustedMarketState, clock: world.request.clock },
    );
    if (replayed.status === 'INVALID_INPUT') throw new Error(`${symbol} routing replay invalid`);
    const maliciousRouteId = `route.${symbol.toLowerCase()}.malicious-cheapest`;
    return {
      id: `mainnet-routing-${symbol.toLowerCase()}`,
      symbol,
      stateClass: 'RECORDED_MAINNET_WITH_SYNTHETIC_ROUTE_ECONOMICS',
      captureId: 'robinhood-mainnet-2026-09-24T22-36-48Z',
      mandateDigest: mandateDigest(world.mandate),
      registrySnapshotDigest: registrySnapshotDigest(world.registry.snapshot),
      trustedStateDigest: trustedStateDigest(world.state),
      evaluatedAtUnixSeconds: String(world.clock.nowUnixSeconds),
      routes: json(world.routes),
      maliciousRouteId,
      receiptReproduced: replayed.receipt.receiptDigest === result.receipt.receiptDigest,
      expected: json({
        status: result.status,
        selectedRouteId: result.selected.routeId,
        selectedCandidateDigest: result.selected.candidateDigest,
        finalVerificationReceiptDigest: result.finalVerificationReceipt.receiptDigest,
        routingReceiptDigest: result.receipt.receiptDigest,
        outcomes: result.receipt.outcomes.map((outcome) => ({
          routeId: outcome.routeId,
          status: outcome.status,
          reasons: outcome.status === 'EXCLUDED' ? outcome.exclusions.map((item) => item.code) : [],
        })),
      }),
    };
  });
  return {
    corpusVersion: MAINNET_ROUTING_CORPUS_VERSION,
    routerVersion: 'mandate-router/1',
    fixtureManifest: 'packages/adapter-robinhood/test/fixtures/mainnet/2026-09-24/manifest.json',
    note: 'Representation, price, multiplier, contract and epoch state are recorded mainnet observations. Route fees and alternate venue routes are synthetic.',
    vectorCount: vectors.length,
    vectors,
  };
}

export function buildMainnetRoutingReport(): Record<string, unknown> {
  const corpus = buildMainnetRoutingCorpus();
  const vectors = corpus['vectors'] as readonly Record<string, unknown>[];
  const outcomes = vectors.flatMap((vector) => ((vector['expected'] as Record<string, unknown>)['outcomes'] as readonly Record<string, unknown>[]));
  const excluded = outcomes.filter((outcome) => outcome['status'] === 'EXCLUDED');
  const maliciousSelected = vectors.filter((vector) => {
    const expected = vector['expected'] as Record<string, unknown>;
    return expected['selectedRouteId'] === vector['maliciousRouteId'];
  }).length;
  return {
    reportVersion: 1,
    captureId: 'robinhood-mainnet-2026-09-24T22-36-48Z',
    worldsEvaluated: vectors.length,
    realAssets: vectors.map((vector) => vector['symbol']),
    candidatesGenerated: outcomes.length,
    candidatesExcluded: excluded.length,
    admissibleCandidates: outcomes.filter((outcome) => outcome['status'] === 'ADMISSIBLE').length,
    selectedRoutes: vectors.length,
    maliciousCandidatesGenerated: vectors.length,
    maliciousCandidatesSelected: maliciousSelected,
    unsafeCandidatesReachingExecutionHandoff: maliciousSelected,
    receiptReproductionFailures: vectors.filter((vector) => vector['receiptReproduced'] !== true).length,
  };
}
