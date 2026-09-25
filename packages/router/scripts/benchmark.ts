import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { openRegistry } from '@mandate/registry';
import { route, type ProviderRouteQuote, type TrustedRouteCost } from '../src/index.ts';
import {
  ROUTER_AUTHORIZATION, ROUTER_CLOCK, ROUTER_DOMAIN, ROUTER_MANDATE, ROUTER_REGISTRY_INPUT,
  ROUTER_STATE, routeQuote, trustedCost,
} from '../test/support/fixture.ts';

const opened = openRegistry(ROUTER_REGISTRY_INPUT);
if (!opened.ok) throw new Error('benchmark registry failed');
const registry = opened.value;

function input(count: number) {
  const routes: ProviderRouteQuote[] = [];
  const costs: TrustedRouteCost[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = routeQuote({ routeId: `benchmark.route.${String(index).padStart(3, '0')}` });
    const zero = base.costs.venueFee;
    if (zero === null) throw new Error('benchmark fee missing');
    const quote = { ...base, costs: { ...base.costs, venueFee: { ...zero, atoms: BigInt(index) } } };
    routes.push(quote);
    costs.push(trustedCost(quote));
  }
  return {
    mandate: ROUTER_MANDATE, authorization: ROUTER_AUTHORIZATION, registry,
    trustedMarketState: ROUTER_STATE, routes, trustedCosts: costs,
    clock: { nowUnixSeconds: ROUTER_CLOCK }, expectedDomain: ROUTER_DOMAIN,
  };
}

function benchmark(count: number, iterations: number) {
  const request = input(count);
  route(request); // warm-up
  const timings: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    const result = route(request);
    timings.push(performance.now() - start);
    if (result.status !== 'SELECTED') throw new Error(`benchmark ${count} did not select`);
  }
  timings.sort((left, right) => left - right);
  return {
    candidates: count,
    iterations,
    medianMilliseconds: Number((timings[Math.floor(timings.length / 2)] ?? 0).toFixed(3)),
    maximumMilliseconds: Number((timings[timings.length - 1] ?? 0).toFixed(3)),
  };
}

const report = {
  benchmarkVersion: 1,
  node: process.version,
  platform: platform(),
  architecture: arch(),
  cpu: cpus()[0]?.model ?? 'unknown',
  methodology: 'One warm-up followed by sequential in-process route calls over the recorded NVDA state; median and maximum wall-clock duration.',
  results: [benchmark(10, 20), benchmark(100, 10), benchmark(256, 5)],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

