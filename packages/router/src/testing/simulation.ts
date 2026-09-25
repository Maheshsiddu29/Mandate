import { route } from '../router.ts';
import type { RoutingReasonCode } from '../types.ts';
import { buildExecutionWorld, type SimulationConfig, type SimulationTemplate } from './worlds.ts';

export interface SimulationMetrics {
  readonly seed: number;
  readonly worldsEvaluated: number;
  readonly candidatesGenerated: number;
  readonly candidatesExcluded: number;
  readonly validCandidates: number;
  readonly noRouteOutcomes: number;
  readonly selectedRoutes: number;
  readonly rejectionsByReason: Readonly<Record<string, number>>;
  readonly maliciousCandidatesGenerated: number;
  readonly maliciousCandidatesSelected: number;
  readonly unsafeCandidatesReachingExecutionHandoff: number;
  readonly determinismFailures: number;
  readonly receiptReproductionFailures: number;
}

export function runSimulation(
  config: SimulationConfig,
  templateFor: (seed: number, asset: string) => SimulationTemplate,
): SimulationMetrics {
  if (!Number.isSafeInteger(config.worlds) || config.worlds < 0) throw new Error('world count must be a non-negative safe integer');
  if (config.assetSet.length === 0 || config.marketRegimes.length === 0) throw new Error('simulation dimensions cannot be empty');
  const reasons: Partial<Record<RoutingReasonCode, number>> = {};
  let candidatesGenerated = 0;
  let candidatesExcluded = 0;
  let validCandidates = 0;
  let noRouteOutcomes = 0;
  let selectedRoutes = 0;
  let maliciousCandidatesGenerated = 0;
  let maliciousCandidatesSelected = 0;
  let unsafeCandidatesReachingExecutionHandoff = 0;
  let determinismFailures = 0;
  let receiptReproductionFailures = 0;

  for (let index = 0; index < config.worlds; index += 1) {
    const seed = config.seed + index;
    const asset = config.assetSet[index % config.assetSet.length] as string;
    const world = buildExecutionWorld(seed, config, templateFor(seed, asset));
    // The simulation hands off against the same world it evaluated: these are
    // seeded determinism and safety worlds, not TOCTOU worlds. Passing it
    // explicitly is the point of ADR 0016 — reuse is now a visible decision.
    const handoff = { trustedMarketState: world.request.trustedMarketState, clock: world.request.clock };
    const first = route(world.request, handoff);
    const second = route({ ...world.request, routes: [...(world.request.routes as readonly unknown[])].reverse() }, handoff);
    candidatesGenerated += (world.request.routes as readonly unknown[]).length;
    maliciousCandidatesGenerated += world.maliciousRouteIds.length;
    if (first.status === 'INVALID_INPUT' || second.status === 'INVALID_INPUT') {
      determinismFailures += 1;
      continue;
    }
    const outcomes = first.receipt.outcomes;
    candidatesExcluded += outcomes.filter((outcome) => outcome.status === 'EXCLUDED').length;
    validCandidates += outcomes.filter((outcome) => outcome.status === 'ADMISSIBLE').length;
    for (const outcome of outcomes) {
      if (outcome.status !== 'EXCLUDED') continue;
      for (const item of outcome.exclusions) reasons[item.code] = (reasons[item.code] ?? 0) + 1;
    }
    if (first.status === 'NO_VALID_ROUTE') noRouteOutcomes += 1;
    if (first.status === 'SELECTED') {
      selectedRoutes += 1;
      if (world.maliciousRouteIds.includes(first.selected.routeId)) {
        maliciousCandidatesSelected += 1;
        unsafeCandidatesReachingExecutionHandoff += 1;
      }
    }
    if (first.status !== second.status) determinismFailures += 1;
    else if (first.receipt.receiptDigest !== second.receipt.receiptDigest) receiptReproductionFailures += 1;
  }

  return {
    seed: config.seed,
    worldsEvaluated: config.worlds,
    candidatesGenerated,
    candidatesExcluded,
    validCandidates,
    noRouteOutcomes,
    selectedRoutes,
    rejectionsByReason: Object.fromEntries(Object.entries(reasons).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
    maliciousCandidatesGenerated,
    maliciousCandidatesSelected,
    unsafeCandidatesReachingExecutionHandoff,
    determinismFailures,
    receiptReproductionFailures,
  };
}

