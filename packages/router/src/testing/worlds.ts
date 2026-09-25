import { parseIdentifier, type TrustedState } from '@mandate/kernel';
import type { RouteRequest } from '../router.ts';
import type { ProviderRouteQuote, TrustedRouteCost } from '../types.ts';

export const SimulationWorldKind = {
  NORMAL: 'NORMAL',
  TWO_VALID: 'TWO_VALID',
  THREE_VALID: 'THREE_VALID',
  SAME_PRICE_DIFFERENT_FEES: 'SAME_PRICE_DIFFERENT_FEES',
  SAME_COST_DIFFERENT_FRESHNESS: 'SAME_COST_DIFFERENT_FRESHNESS',
  CHEAPEST_WRONG_ISSUER: 'CHEAPEST_WRONG_ISSUER',
  CHEAPEST_WRONG_CHAIN: 'CHEAPEST_WRONG_CHAIN',
  CHEAPEST_STALE: 'CHEAPEST_STALE',
  CHEAPEST_HALTED: 'CHEAPEST_HALTED',
  MUTATED_NOTIONAL: 'MUTATED_NOTIONAL',
  MUTATED_SIDE: 'MUTATED_SIDE',
  MUTATED_ASSET: 'MUTATED_ASSET',
  FAKE_SAME_SYMBOL: 'FAKE_SAME_SYMBOL',
  QUOTE_EXPIRES: 'QUOTE_EXPIRES',
  CORPORATE_ACTION_CHANGE: 'CORPORATE_ACTION_CHANGE',
  PRICE_BOUNDARY_CROSSED: 'PRICE_BOUNDARY_CROSSED',
  ZERO_FEE_LIE: 'ZERO_FEE_LIE',
  UNKNOWN_COST: 'UNKNOWN_COST',
  ALL_INVALID: 'ALL_INVALID',
  ONE_VALID_MANY_MALICIOUS: 'ONE_VALID_MANY_MALICIOUS',
  DETERMINISTIC_TIE: 'DETERMINISTIC_TIE',
} as const;
export type SimulationWorldKind = (typeof SimulationWorldKind)[keyof typeof SimulationWorldKind];
export const ALL_SIMULATION_WORLD_KINDS = Object.values(SimulationWorldKind);

export interface SimulationConfig {
  readonly seed: number;
  readonly worlds: number;
  readonly assetSet: readonly string[];
  readonly marketRegimes: readonly ('NORMAL' | 'HALTED' | 'FAST')[];
  readonly agentMutationRateBps: number;
  readonly routeProviderFaultRateBps: number;
  readonly staleStateRateBps: number;
  readonly corporateActionRateBps: number;
}

export interface SimulationTemplate {
  readonly request: Omit<RouteRequest, 'routes' | 'trustedCosts'>;
  readonly quote: ProviderRouteQuote;
  readonly trustedCost: TrustedRouteCost;
}

export interface ExecutionWorld {
  readonly seed: number;
  readonly asset: string;
  readonly kind: SimulationWorldKind;
  readonly description: string;
  readonly request: RouteRequest;
  readonly maliciousRouteIds: readonly string[];
}

function id(raw: string) {
  const parsed = parseIdentifier(raw);
  if (!parsed.ok) throw new Error(`invalid synthetic identifier ${raw}`);
  return parsed.value;
}

function cloneQuote(base: ProviderRouteQuote, routeId: string, feeAtoms: bigint, ageSeconds = 0n): ProviderRouteQuote {
  const zero = base.costs.venueFee ?? { unit: base.notional.unit, decimals: base.notional.decimals, atoms: 0n };
  return {
    ...base,
    routeId,
    quoteObservedAtUnixSeconds: base.quoteObservedAtUnixSeconds - ageSeconds,
    costs: { venueFee: { ...zero, atoms: feeAtoms }, executionFee: { ...zero, atoms: 0n }, settlementFee: { ...zero, atoms: 0n }, routeFee: { ...zero, atoms: 0n } },
  };
}

function trusted(quote: ProviderRouteQuote, source: TrustedRouteCost): TrustedRouteCost {
  return { ...source, routeId: quote.routeId, costs: quote.costs };
}

function request(template: SimulationTemplate, quotes: readonly ProviderRouteQuote[], costs: readonly TrustedRouteCost[], state?: TrustedState): RouteRequest {
  return { ...template.request, ...(state === undefined ? {} : { trustedMarketState: state }), routes: quotes, trustedCosts: costs };
}

/** A plain bigint LCG: no floating point or process randomness. */
function random(seed: number): () => bigint {
  let value = BigInt(seed) & 0xffffffffn;
  return () => {
    value = (value * 1_664_525n + 1_013_904_223n) & 0xffffffffn;
    return value;
  };
}

export function buildExecutionWorld(seed: number, config: SimulationConfig, template: SimulationTemplate): ExecutionWorld {
  const next = random(seed);
  const kind = ALL_SIMULATION_WORLD_KINDS[Number(next() % BigInt(ALL_SIMULATION_WORLD_KINDS.length))] as SimulationWorldKind;
  const asset = config.assetSet[Number(next() % BigInt(config.assetSet.length))] as string;
  const base = cloneQuote(template.quote, `route.${seed}.valid`, 100n);
  const validCost = trusted(base, template.trustedCost);
  const malicious: string[] = [];
  let quotes: ProviderRouteQuote[] = [base];
  let costs: TrustedRouteCost[] = [validCost];
  let state: TrustedState | undefined;
  const bad = (quote: ProviderRouteQuote): ProviderRouteQuote => { malicious.push(quote.routeId); return quote; };

  switch (kind) {
    case 'NORMAL': break;
    case 'TWO_VALID': {
      const second = cloneQuote(template.quote, `route.${seed}.second`, 200n);
      quotes.push(second); costs.push(trusted(second, template.trustedCost)); break;
    }
    case 'THREE_VALID': {
      for (const [suffix, fee] of [['second', 200n], ['third', 300n]] as const) {
        const quote = cloneQuote(template.quote, `route.${seed}.${suffix}`, fee); quotes.push(quote); costs.push(trusted(quote, template.trustedCost));
      }
      break;
    }
    case 'SAME_PRICE_DIFFERENT_FEES': {
      const cheaper = cloneQuote(template.quote, `route.${seed}.cheaper`, 1n); quotes.push(cheaper); costs.push(trusted(cheaper, template.trustedCost)); break;
    }
    case 'SAME_COST_DIFFERENT_FRESHNESS': {
      const older = cloneQuote(template.quote, `route.${seed}.older`, 100n, 1n); quotes = [older, base]; costs = [trusted(older, template.trustedCost), validCost]; break;
    }
    case 'CHEAPEST_WRONG_ISSUER': quotes.unshift(bad({ ...cloneQuote(template.quote, `route.${seed}.bad`, 0n), issuer: id('issuer.attacker') })); costs.unshift(trusted(quotes[0]!, template.trustedCost)); break;
    case 'CHEAPEST_WRONG_CHAIN': quotes.unshift(bad({ ...cloneQuote(template.quote, `route.${seed}.bad`, 0n), chain: id('eip155:1') })); costs.unshift(trusted(quotes[0]!, template.trustedCost)); break;
    case 'CHEAPEST_STALE': {
      const stale = bad(cloneQuote(template.quote, `route.${seed}.bad`, 0n, 61n)); quotes.unshift(stale); costs.unshift(trusted(stale, template.trustedCost)); break;
    }
    case 'CHEAPEST_HALTED': {
      const raw = template.request.trustedMarketState as TrustedState;
      if (raw.market !== null) state = { ...raw, market: { ...raw.market, value: { ...raw.market.value, haltStatus: 'HALTED' } } };
      malicious.push(base.routeId); break;
    }
    case 'MUTATED_NOTIONAL': quotes = [bad({ ...base, notional: { ...base.notional, atoms: base.notional.atoms + 1n } })]; break;
    case 'MUTATED_SIDE': quotes = [bad({ ...base, side: base.side === 'BUY' ? 'SELL' : 'BUY' })]; break;
    case 'MUTATED_ASSET': quotes = [bad({ ...base, canonicalAsset: { ...base.canonicalAsset, value: id('US0378331005') } })]; break;
    case 'FAKE_SAME_SYMBOL': quotes = [bad({ ...base, representationId: id('eip155:4663/erc20:0x1111111111111111111111111111111111111111') })]; break;
    case 'QUOTE_EXPIRES': quotes = [bad(cloneQuote(template.quote, base.routeId, 100n, 61n))]; break;
    case 'CORPORATE_ACTION_CHANGE': quotes = [bad({ ...base, corporateActionEpoch: base.corporateActionEpoch + 1n })]; break;
    case 'PRICE_BOUNDARY_CROSSED': quotes = [bad({ ...base, executionPrice: { ...base.executionPrice, atoms: base.executionPrice.atoms + 1n }, notional: { ...base.notional, atoms: base.notional.atoms + 1n } })]; break;
    case 'ZERO_FEE_LIE': {
      const established = { ...validCost, costs: { ...validCost.costs, routeFee: { ...(validCost.costs.routeFee ?? base.notional), atoms: 1n } } }; costs = [established]; malicious.push(base.routeId); break;
    }
    case 'UNKNOWN_COST': quotes = [bad({ ...base, costs: { ...base.costs, routeFee: null } })]; costs = [trusted(quotes[0]!, template.trustedCost)]; break;
    case 'ALL_INVALID': quotes = [bad({ ...base, issuer: id('issuer.attacker') })]; break;
    case 'ONE_VALID_MANY_MALICIOUS': {
      const wrongChain = bad({ ...cloneQuote(template.quote, `route.${seed}.chain`, 0n), chain: id('eip155:1') });
      const wrongVenue = bad({ ...cloneQuote(template.quote, `route.${seed}.venue`, 0n), venue: id('venue.attacker') });
      const wrongSide = bad({ ...cloneQuote(template.quote, `route.${seed}.side`, 0n), side: base.side === 'BUY' ? 'SELL' : 'BUY' });
      quotes = [wrongChain, wrongVenue, wrongSide, base]; costs = quotes.map((quote) => trusted(quote, template.trustedCost)); break;
    }
    case 'DETERMINISTIC_TIE': {
      const tie = cloneQuote(template.quote, `route.${seed}.tie`, 100n); quotes.push(tie); costs.push(trusted(tie, template.trustedCost)); break;
    }
  }

  // Configured rates add deterministic faults without encoding an expected result.
  if (next() % 10_000n < BigInt(config.routeProviderFaultRateBps) && quotes.length > 0 && malicious.length === 0) {
    quotes[0] = bad({ ...quotes[0]!, issuer: id('issuer.rate-fault') });
  }
  if (next() % 10_000n < BigInt(config.staleStateRateBps) && quotes.length > 0) {
    quotes[0] = bad({ ...quotes[0]!, quoteObservedAtUnixSeconds: quotes[0]!.quoteObservedAtUnixSeconds - 61n });
  }
  if (next() % 10_000n < BigInt(config.corporateActionRateBps) && quotes.length > 0) {
    quotes[0] = bad({ ...quotes[0]!, corporateActionEpoch: quotes[0]!.corporateActionEpoch + 1n });
  }
  if (next() % 10_000n < BigInt(config.agentMutationRateBps) && quotes.length > 0) {
    quotes[0] = bad({ ...quotes[0]!, notional: { ...quotes[0]!.notional, atoms: quotes[0]!.notional.atoms + 1n } });
  }

  return {
    seed, asset, kind,
    description: `${kind} generated from seed ${seed}; venue economics are synthetic.`,
    request: request(template, quotes, costs, state),
    maliciousRouteIds: [...new Set(malicious)].sort(),
  };
}

