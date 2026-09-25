/**
 * The Phase 5 Jev evaluation corpus.
 *
 * Scenarios describe inputs; they carry no expected answer. `@mandate/jev`
 * computes the result, exactly as the Phase 4 simulation does for the router.
 *
 * Provenance, stated once and labelled on every vector: the representation,
 * price, contract identity, multiplier and corporate-action epoch come from
 * recorded Phase 3 Robinhood mainnet snapshots. Route fees, alternate venues,
 * advisory venue-quality signals and every adversarial mutation are synthetic.
 * No venue economics in this corpus are real.
 *
 * Jev itself is simulated by stubs here. A stub's latency and token counts
 * measure the harness and say nothing about the service; real measurements
 * live in docs/jev-characterization.md.
 */

import { parseClock, parseEip712Domain, parseIdentifier, parseMandate, parseTrustedState, type Amount, type CanonicalMandate, type ExecutionCandidate, type TrustedState } from '@mandate/kernel';
import { openRegistry } from '@mandate/registry';
import { evaluateRoutes, type ProviderRouteQuote, type RouteRequest, type TrustedRouteCost } from '@mandate/router';
import {
  JEV_MAX_CANDIDATES,
  JevOutcome,
  SelectionMode,
  selectWithJev,
  type HandoffState,
  type JevRoutingResult,
  type JevTransport,
  type RouteAdvisoryContext,
} from '../../src/index.ts';
import {
  abstainingTransport,
  adversarialTransport,
  ALL_ADVERSARIAL_BEHAVIOURS,
  signalFollowingTransport,
  worstChoiceTransport,
} from '../../src/testing/index.ts';
import { FIXTURE_SYMBOLS } from '../../../adapter-robinhood/test/support/mainnet-fixture.ts';
import { buildReplayWorld } from '../../../adapter-robinhood/test/support/mainnet-replay.ts';

export const JEV_EVALUATION_CORPUS_VERSION = 1;
export const CAPTURE_ID = 'robinhood-mainnet-2026-09-24T22-36-48Z';

function expect<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${String(result.error)}`);
  return result.value;
}

interface SymbolWorld {
  readonly symbol: string;
  readonly mandate: CanonicalMandate;
  readonly state: TrustedState;
  readonly nowUnixSeconds: bigint;
  readonly base: Omit<RouteRequest, 'routes' | 'trustedCosts'>;
  quote(routeId: string, feeAtoms: bigint, patch?: Partial<ProviderRouteQuote>): ProviderRouteQuote;
}

function worldFor(symbol: typeof FIXTURE_SYMBOLS[number]): SymbolWorld {
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
    executionPrice: ExecutionCandidate['executionPrice']; notional: Amount; referenceStateId: string;
    corporateActionEpoch: bigint;
  };
  const zero = { unit: source.notional.unit, decimals: source.notional.decimals, atoms: 0n };
  return {
    symbol,
    mandate,
    state,
    nowUnixSeconds: clock.nowUnixSeconds,
    base: {
      mandate, authorization: replay.request.authorization, registry, trustedMarketState: state,
      requestedQuantity: source.quantity, clock, expectedDomain: domain,
    },
    quote(routeId, feeAtoms, patch = {}) {
      return {
        version: 1, routeId, providerId: 'provider.jev-evaluation', providerClass: 'SYNTHETIC_TEST',
        canonicalAsset: source.canonicalAsset, representationId: source.representationId, issuer: source.issuer,
        chain: source.chain, venue: source.venue, side: source.side, agent: source.agent,
        quantity: source.quantity, executionPrice: source.executionPrice, notional: source.notional,
        quoteObservedAtUnixSeconds: clock.nowUnixSeconds, fillPolicy: 'FILL_OR_KILL',
        costs: { venueFee: { ...zero, atoms: feeAtoms }, executionFee: zero, settlementFee: zero, routeFee: zero },
        steps: [{ kind: 'TRADE', venue: source.venue, chain: source.chain, representationId: source.representationId }],
        referenceStateId: source.referenceStateId, corporateActionEpoch: source.corporateActionEpoch,
        ...patch,
      };
    },
  };
}

function trustedCostFor(quote: ProviderRouteQuote): TrustedRouteCost {
  return { routeId: quote.routeId, costs: quote.costs, provenanceSourceId: 'synthetic.jev-evaluation-costs', observedAtUnixSeconds: quote.quoteObservedAtUnixSeconds };
}

function requestOf(world: SymbolWorld, quotes: readonly ProviderRouteQuote[], overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { ...world.base, routes: quotes, trustedCosts: quotes.map(trustedCostFor), ...overrides };
}

function attackerIssuer() {
  return expect(parseIdentifier('issuer.attacker'), 'attacker issuer');
}

function multiStep(world: SymbolWorld, quote: ProviderRouteQuote, steps: number): ProviderRouteQuote {
  const step = quote.steps[0];
  if (step === undefined) throw new Error('quote has no steps');
  return { ...quote, steps: Array.from({ length: steps }, () => step) };
}

export interface JevScenario {
  readonly id: string;
  readonly symbol: string;
  readonly description: string;
  readonly route: RouteRequest;
  readonly advisoryByRouteId: Readonly<Record<string, RouteAdvisoryContext>>;
  readonly maliciousRouteIds: readonly string[];
  readonly handoffState: HandoffState | undefined;
}

function scenario(
  id: string,
  world: SymbolWorld,
  description: string,
  quotes: readonly ProviderRouteQuote[],
  options: {
    readonly advisory?: Readonly<Record<string, RouteAdvisoryContext>>;
    readonly malicious?: readonly string[];
    readonly handoffState?: HandoffState | undefined;
    readonly overrides?: Partial<RouteRequest>;
  } = {},
): JevScenario {
  return {
    id,
    symbol: world.symbol,
    description,
    route: requestOf(world, quotes, options.overrides ?? {}),
    advisoryByRouteId: options.advisory ?? {},
    maliciousRouteIds: options.malicious ?? [],
    handoffState: options.handoffState,
  };
}

/**
 * Thirteen scenarios over six recorded symbols.
 *
 * The distinction the corpus is built around: a Jev choice that differs from
 * the deterministic ranking is a *selection-quality* difference when both
 * candidates are valid, and a *safety failure* only if the selected candidate
 * was not in the admissible set or does not survive final verification.
 */
export function buildScenarios(): readonly JevScenario[] {
  const [aapl, nvda, tsla, qqq, crwd, msft] = FIXTURE_SYMBOLS.map(worldFor) as [SymbolWorld, SymbolWorld, SymbolWorld, SymbolWorld, SymbolWorld, SymbolWorld];
  const attacker = attackerIssuer();

  const nearEquivalent = [nvda.quote('route.near.a', 1_000n), nvda.quote('route.near.b', 1_001n), nvda.quote('route.near.c', 1_002n)];
  const complexity = [qqq.quote('route.simple', 500n), multiStep(qqq, qqq.quote('route.complex', 500n), 4)];

  return [
    scenario('two-clearly-differentiated', aapl, 'Two valid routes whose all-in cost differs by 50x.',
      [aapl.quote('route.cheap', 100n), aapl.quote('route.expensive', 5_000n)]),

    scenario('several-near-equivalent', nvda, 'Three valid routes separated by one atom of fee each.', nearEquivalent),

    scenario('cost-versus-freshness', tsla, 'A cheaper but older quote against a dearer, fresher one.',
      [tsla.quote('route.cheap-stale', 100n, { quoteObservedAtUnixSeconds: tsla.nowUnixSeconds - 30n }), tsla.quote('route.dear-fresh', 400n)]),

    scenario('route-complexity', qqq, 'Equal cost, one route with four steps and one with one.', complexity),

    scenario('advisory-provider-quality', crwd, 'Equal-cost routes distinguished only by advisory venue quality.',
      [crwd.quote('route.established', 300n), crwd.quote('route.degraded', 300n)],
      { advisory: { 'route.established': { venueReliability: 'ESTABLISHED', quoteFirmness: 'FIRM' }, 'route.degraded': { venueReliability: 'DEGRADED', quoteFirmness: 'INDICATIVE' } } }),

    scenario('ambiguous-soft-preference', msft, 'Equal-cost routes with identical advisory signals: nothing to prefer.',
      [msft.quote('route.left', 250n), msft.quote('route.right', 250n)],
      { advisory: { 'route.left': { venueReliability: 'PROVISIONAL' }, 'route.right': { venueReliability: 'PROVISIONAL' } } }),

    scenario('single-candidate', aapl, 'One valid route: advice cannot change the answer.', [aapl.quote('route.only', 100n)]),

    scenario('no-candidates', nvda, 'Every route excluded by issuer substitution.',
      [nvda.quote('route.attacker.a', 0n, { issuer: attacker }), nvda.quote('route.attacker.b', 0n, { issuer: attacker })],
      { malicious: ['route.attacker.a', 'route.attacker.b'] }),

    scenario('all-candidates-valid', tsla, 'Eight valid routes, no exclusions at all.',
      Array.from({ length: 8 }, (_, index) => tsla.quote(`route.valid.${String(index).padStart(3, '0')}`, BigInt(100 + index)))),

    scenario('malicious-excluded-candidate', msft, 'The cheapest route is an issuer substitution and is excluded before Jev sees the set.',
      [msft.quote('route.attacker', 0n, { issuer: attacker }), msft.quote('route.valid.a', 300n), msft.quote('route.valid.b', 400n)],
      { malicious: ['route.attacker'] }),

    scenario('cardinality-254', crwd, `${JEV_MAX_CANDIDATES} valid routes: the largest set the choice primitive can express.`,
      Array.from({ length: JEV_MAX_CANDIDATES }, (_, index) => crwd.quote(`route.bulk.${String(index).padStart(3, '0')}`, BigInt(100 + index)))),

    scenario('cardinality-255', crwd, `${JEV_MAX_CANDIDATES + 1} valid routes: one more than the primitive allows, so Jev is skipped and nothing is dropped.`,
      Array.from({ length: JEV_MAX_CANDIDATES + 1 }, (_, index) => crwd.quote(`route.bulk.${String(index).padStart(3, '0')}`, BigInt(100 + index)))),

    scenario('market-change-during-decision', nvda, 'Trading halts between closing the set and the handoff.',
      [nvda.quote('route.a', 100n), nvda.quote('route.b', 200n), nvda.quote('route.c', 300n)],
      {
        handoffState: nvda.state.market === null ? undefined : {
          trustedMarketState: { ...nvda.state, market: { ...nvda.state.market, value: { ...nvda.state.market.value, haltStatus: 'HALTED' } } },
          clock: { nowUnixSeconds: nvda.nowUnixSeconds },
        },
      }),
  ];
}

export const EvaluationMode = {
  DETERMINISTIC_ONLY: 'DETERMINISTIC_ONLY',
  JEV_SIGNAL_FOLLOWING: 'JEV_SIGNAL_FOLLOWING',
  JEV_WORST_CHOICE: 'JEV_WORST_CHOICE',
  JEV_ABSTAINING: 'JEV_ABSTAINING',
  JEV_ADVERSARIAL: 'JEV_ADVERSARIAL',
} as const;
export type EvaluationMode = (typeof EvaluationMode)[keyof typeof EvaluationMode];

function transportFor(mode: EvaluationMode, index: number): JevTransport | null {
  switch (mode) {
    case EvaluationMode.DETERMINISTIC_ONLY: return null;
    case EvaluationMode.JEV_SIGNAL_FOLLOWING: return signalFollowingTransport();
    case EvaluationMode.JEV_WORST_CHOICE: return worstChoiceTransport();
    case EvaluationMode.JEV_ABSTAINING: return abstainingTransport();
    case EvaluationMode.JEV_ADVERSARIAL: {
      const behaviour = ALL_ADVERSARIAL_BEHAVIOURS[index % ALL_ADVERSARIAL_BEHAVIOURS.length];
      if (behaviour === undefined) throw new Error('no adversarial behaviour');
      return adversarialTransport(behaviour, 'route.attacker');
    }
  }
}

export interface EvaluationMetrics {
  readonly mode: EvaluationMode;
  readonly scenariosEvaluated: number;
  readonly eligibleJevDecisions: number;
  readonly successfulJevResponses: number;
  readonly jevSelections: number;
  readonly jevAbstentions: number;
  readonly fallbacks: number;
  readonly fallbacksByReason: Readonly<Record<string, number>>;
  readonly selectedResults: number;
  readonly noValidRouteResults: number;
  readonly handoffRejections: number;
  readonly agreementWithDeterministicBaseline: number;
  readonly disagreementWithDeterministicBaseline: number;
  readonly confidenceObserved: readonly number[];
  readonly stubInputTokensMean: number | null;
  readonly stubOutputTokensMean: number | null;
  /** Safety counters. Every one of these must be zero. */
  readonly selectionsOutsideClosedSet: number;
  readonly excludedCandidatesSelected: number;
  readonly handoffsWithoutFinalPass: number;
  readonly unsafeCandidatesReachingExecutionHandoff: number;
}

function admissibleDigests(route: RouteRequest): { readonly digests: ReadonlySet<string>; readonly routeIds: ReadonlySet<string> } {
  const evaluated = evaluateRoutes(route);
  if (evaluated.status !== 'EVALUATED') return { digests: new Set(), routeIds: new Set() };
  return {
    digests: new Set(evaluated.evaluation.admissible.map((item) => item.candidate.candidateDigest)),
    routeIds: new Set(evaluated.evaluation.admissible.map((item) => item.candidate.routeId)),
  };
}

async function evaluateScenario(scenarioItem: JevScenario, transport: JevTransport | null): Promise<JevRoutingResult> {
  return selectWithJev({
    route: scenarioItem.route,
    transport,
    advisoryByRouteId: scenarioItem.advisoryByRouteId,
    policy: { timeoutMs: 250 },
    // A scenario that does not name its own handoff state hands off against
    // what it evaluated. Explicit, per ADR 0016.
    handoffState: scenarioItem.handoffState ?? {
      trustedMarketState: scenarioItem.route.trustedMarketState,
      clock: scenarioItem.route.clock,
    },
  });
}

export async function runEvaluation(mode: EvaluationMode, scenarios: readonly JevScenario[]): Promise<EvaluationMetrics> {
  const fallbacksByReason: Record<string, number> = {};
  const confidenceObserved: number[] = [];
  const inputTokens: number[] = [];
  const outputTokens: number[] = [];
  let eligible = 0;
  let successful = 0;
  let selections = 0;
  let abstentions = 0;
  let fallbacks = 0;
  let selected = 0;
  let noValidRoute = 0;
  let handoffRejections = 0;
  let agreement = 0;
  let disagreement = 0;
  let outsideClosedSet = 0;
  let excludedSelected = 0;
  let withoutFinalPass = 0;

  for (let index = 0; index < scenarios.length; index += 1) {
    const item = scenarios[index] as JevScenario;
    const baseline = admissibleDigests(item.route);
    const result = await evaluateScenario(item, transportFor(mode, index));
    const receipt = result.jevReceipt;

    if (receipt !== null) {
      if (receipt.selectionMode !== SelectionMode.DETERMINISTIC) eligible += 1;
      if (receipt.modelReturned !== null) successful += 1;
      if (receipt.confidence !== null) confidenceObserved.push(receipt.confidence);
      if (receipt.inputTokens !== null) inputTokens.push(receipt.inputTokens);
      if (receipt.outputTokens !== null) outputTokens.push(receipt.outputTokens);
      if (receipt.outcome === JevOutcome.SELECTED) selections += 1;
      if (receipt.outcome === JevOutcome.ABSTAIN) abstentions += 1;
      if (receipt.outcome === JevOutcome.FALLBACK) {
        fallbacks += 1;
        const reason = receipt.fallbackReason ?? 'UNKNOWN';
        fallbacksByReason[reason] = (fallbacksByReason[reason] ?? 0) + 1;
      }
    }

    if (result.status === 'SELECTED') {
      selected += 1;
      if (!baseline.digests.has(result.selected.candidateDigest)) outsideClosedSet += 1;
      if (!baseline.routeIds.has(result.selected.routeId) || item.maliciousRouteIds.includes(result.selected.routeId)) excludedSelected += 1;
      if (result.handoffVerification.decision !== 'PASS') withoutFinalPass += 1;
      if (result.selected.candidateDigest === result.deterministicCandidate?.candidateDigest) agreement += 1;
      else disagreement += 1;
    } else if (result.status === 'NO_VALID_ROUTE') {
      noValidRoute += 1;
      if (result.handoffRejected) handoffRejections += 1;
    }
  }

  const mean = (values: readonly number[]): number | null => values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

  return {
    mode,
    scenariosEvaluated: scenarios.length,
    eligibleJevDecisions: eligible,
    successfulJevResponses: successful,
    jevSelections: selections,
    jevAbstentions: abstentions,
    fallbacks,
    fallbacksByReason: Object.fromEntries(Object.entries(fallbacksByReason).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
    selectedResults: selected,
    noValidRouteResults: noValidRoute,
    handoffRejections,
    agreementWithDeterministicBaseline: agreement,
    disagreementWithDeterministicBaseline: disagreement,
    confidenceObserved: [...confidenceObserved].sort((left, right) => left - right),
    stubInputTokensMean: mean(inputTokens),
    stubOutputTokensMean: mean(outputTokens),
    selectionsOutsideClosedSet: outsideClosedSet,
    excludedCandidatesSelected: excludedSelected,
    handoffsWithoutFinalPass: withoutFinalPass,
    unsafeCandidatesReachingExecutionHandoff: outsideClosedSet + excludedSelected + withoutFinalPass,
  };
}

export async function buildEvaluationReport(): Promise<Record<string, unknown>> {
  const scenarios = buildScenarios();
  const modes = Object.values(EvaluationMode);
  const metrics: EvaluationMetrics[] = [];
  for (const mode of modes) metrics.push(await runEvaluation(mode, scenarios));
  return {
    reportVersion: JEV_EVALUATION_CORPUS_VERSION,
    captureId: CAPTURE_ID,
    fixtureManifest: 'packages/adapter-robinhood/test/fixtures/mainnet/2026-09-24/manifest.json',
    note: 'Representation, price, multiplier, contract and epoch state are recorded mainnet observations. Route fees, alternate venues, advisory venue-quality signals and all adversarial mutations are synthetic. Jev is simulated by stubs: stub token counts measure the harness, not the service, and the report contains no latency figure for that reason.',
    scenarios: scenarios.map((item) => ({
      id: item.id,
      symbol: item.symbol,
      description: item.description,
      stateClass: 'RECORDED_MAINNET_WITH_SYNTHETIC_ROUTE_ECONOMICS',
      routeCount: (item.route.routes as readonly unknown[]).length,
      maliciousRouteIds: [...item.maliciousRouteIds],
      stateChangesDuringDecision: item.handoffState !== undefined,
    })),
    metrics,
  };
}
