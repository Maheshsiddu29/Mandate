import { openRegistry } from '@mandate/registry';
import type { SimulationConfig, SimulationTemplate } from '../../src/testing/index.ts';
import {
  ROUTER_AUTHORIZATION, ROUTER_CLOCK, ROUTER_DOMAIN, ROUTER_MANDATE, ROUTER_REGISTRY_INPUT, ROUTER_REQUESTED_QUANTITY,
  ROUTER_STATE, routeQuote, trustedCost,
} from './fixture.ts';

const opened = openRegistry(ROUTER_REGISTRY_INPUT);
if (!opened.ok) throw new Error('simulation registry failed');
const SIMULATION_REGISTRY = opened.value;

export const COMMITTED_SIMULATION_CONFIG: SimulationConfig = {
  seed: 4_200,
  worlds: 200,
  assetSet: ['NVDA'],
  marketRegimes: ['NORMAL', 'HALTED', 'FAST'],
  agentMutationRateBps: 300,
  routeProviderFaultRateBps: 500,
  staleStateRateBps: 300,
  corporateActionRateBps: 200,
};

export function simulationTemplate(): SimulationTemplate {
  const quote = routeQuote();
  return {
    request: {
      mandate: ROUTER_MANDATE,
      authorization: ROUTER_AUTHORIZATION,
      registry: SIMULATION_REGISTRY,
      trustedMarketState: ROUTER_STATE,
      requestedQuantity: ROUTER_REQUESTED_QUANTITY,
      clock: { nowUnixSeconds: ROUTER_CLOCK },
      expectedDomain: ROUTER_DOMAIN,
    },
    quote,
    trustedCost: trustedCost(quote),
  };
}
