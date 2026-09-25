/**
 * Local latency cost of the advisory layer.
 *
 * This measures what Mandate adds around a Jev call: the evaluation/selection
 * split, the projection, the request body, response parsing, the advisory
 * receipt, the selection receipt and the handoff re-verification.
 *
 * It does **not** measure Jev. The stub transport returns instantly, so the
 * network and inference component is zero here by construction. End-to-end
 * latency is this overhead plus the service's own latency, which has to come
 * from `npm run jev:characterize`.
 *
 * Deterministic code is faster than a model call and this repository does not
 * pretend otherwise. The question the benchmark answers is how large the
 * *local* budget is, so that the service's measured p95 can be added to it.
 */

import { arch, cpus, platform } from 'node:os';
import { performance } from 'node:perf_hooks';
import { openRegistry } from '@mandate/registry';
import { route, type ProviderRouteQuote, type RouteRequest, type TrustedRouteCost } from '@mandate/router';
import { selectWithJev } from '../src/index.ts';
import { choosingTransport } from '../src/testing/index.ts';
import {
  ROUTER_AUTHORIZATION, ROUTER_CLOCK, ROUTER_DOMAIN, ROUTER_MANDATE, ROUTER_REGISTRY_INPUT,
  ROUTER_REQUESTED_QUANTITY, ROUTER_STATE, routeQuote, trustedCost, zeroFee,
} from '../../router/test/support/fixture.ts';

const opened = openRegistry(ROUTER_REGISTRY_INPUT);
if (!opened.ok) throw new Error('benchmark registry failed');
const registry = opened.value;

function input(count: number): RouteRequest {
  const routes: ProviderRouteQuote[] = [];
  const costs: TrustedRouteCost[] = [];
  for (let index = 0; index < count; index += 1) {
    const fee = { ...zeroFee(), atoms: BigInt(index) };
    const quote = routeQuote({
      routeId: `benchmark.route.${String(index).padStart(3, '0')}`,
      costs: { venueFee: fee, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() },
    });
    routes.push(quote);
    costs.push(trustedCost(quote));
  }
  return {
    mandate: ROUTER_MANDATE, authorization: ROUTER_AUTHORIZATION, registry,
    trustedMarketState: ROUTER_STATE, routes, trustedCosts: costs,
    requestedQuantity: ROUTER_REQUESTED_QUANTITY,
    clock: { nowUnixSeconds: ROUTER_CLOCK }, expectedDomain: ROUTER_DOMAIN,
  };
}

function summarize(timings: number[]): { readonly medianMilliseconds: number; readonly maximumMilliseconds: number } {
  timings.sort((left, right) => left - right);
  return {
    medianMilliseconds: Number((timings[Math.floor(timings.length / 2)] ?? 0).toFixed(3)),
    maximumMilliseconds: Number((timings[timings.length - 1] ?? 0).toFixed(3)),
  };
}

async function measure(count: number, iterations: number) {
  const request = input(count);
  const transport = choosingTransport('route_001');

  route(request); // warm-up
  await selectWithJev({ route: request, transport: null });
  await selectWithJev({ route: request, transport });

  const deterministic: number[] = [];
  const advisoryDisabled: number[] = [];
  const advisoryStubbed: number[] = [];

  for (let index = 0; index < iterations; index += 1) {
    let start = performance.now();
    if (route(request).status !== 'SELECTED') throw new Error('deterministic benchmark did not select');
    deterministic.push(performance.now() - start);

    start = performance.now();
    if ((await selectWithJev({ route: request, transport: null })).status !== 'SELECTED') throw new Error('disabled benchmark did not select');
    advisoryDisabled.push(performance.now() - start);

    start = performance.now();
    if ((await selectWithJev({ route: request, transport })).status !== 'SELECTED') throw new Error('stubbed benchmark did not select');
    advisoryStubbed.push(performance.now() - start);
  }

  const det = summarize(deterministic);
  const stub = summarize(advisoryStubbed);
  return {
    candidates: count,
    iterations,
    deterministicOnly: det,
    advisoryPathDisabled: summarize(advisoryDisabled),
    advisoryPathStubbedTransport: stub,
    localOverheadMedianMilliseconds: Number((stub.medianMilliseconds - det.medianMilliseconds).toFixed(3)),
  };
}

const report = {
  benchmarkVersion: 1,
  node: process.version,
  platform: platform(),
  architecture: arch(),
  cpu: cpus()[0]?.model ?? 'unknown',
  methodology: 'One warm-up per mode, then interleaved in-process runs over the recorded NVDA state. The advisory transport is an instantly-returning stub, so no network or inference time is included.',
  caveat: 'This measures the local cost Mandate adds around a Jev call. It is not a measurement of Jev, and it is not a claim that the advisory path is faster than deterministic code — it cannot be, because it contains it.',
  results: [await measure(10, 20), await measure(100, 10), await measure(254, 5)],
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
