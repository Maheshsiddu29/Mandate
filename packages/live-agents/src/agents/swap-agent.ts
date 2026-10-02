/**
 * The swap agent: best execution for USDC → WETH. Three routes, labelled
 * fixture quotes:
 *
 * | id | router | pool | quote vs route-a | min out | max size |
 * | --- | --- | --- | ---: | --- | ---: |
 * | `route-a` | reviewed | reviewed, 0.30 % fee tier, deep | — | quote − 0.30 % | 500 |
 * | `route-c` | reviewed | reviewed, 0.05 % fee tier, shallow | +0.20 % | quote − 0.30 % | 250 |
 * | `route-b` | unknown | reviewed | +4.17 % | quote − 0.30 % | 500 |
 *
 * route-a and route-c are both inside the reviewed scope: one is deeper, the
 * other quotes better on a smaller size. route-b quotes best of all; it is
 * not labelled bad — whether its venue is authorized is Mandate's question.
 */

import { APPROVED_POOL, APPROVED_ROUTER, FIXTURE_USDC, PRINCIPAL_ON_ARBITRUM, SWAP_POOL_C, UNKNOWN_ROUTER, WETH } from '@mandate/portfolio/demo';
import { NO_CLAIMS, USDC, type DomainAgentSpec, type TrustedCandidate } from './spec.ts';

/** WETH atoms per USDC atom ×10⁶ quoted through each route (fixture quotes), and 30 bps below for the minimum. */
function route(id: string, router: string, pool: string, quotePerMillion: bigint, maxWhole: bigint, facts: TrustedCandidate['facts']): TrustedCandidate {
  return {
    id,
    role: 'swap',
    title: `USDC → WETH via router …${router.slice(-4)}, pool …${pool.slice(-4)}`,
    facts,
    untrustedText: null,
    marketEvidence: 'FIXTURE',
    minAtoms: USDC(100n),
    maxAtoms: USDC(maxWhole),
    resizable: true,
    build: (size, observedAt) => ({
      kind: 'SWAP_EXACT_IN',
      router,
      route: [pool],
      tokenIn: FIXTURE_USDC,
      tokenOut: WETH,
      amountIn: size,
      quotedOut: (size * quotePerMillion) / 1_000_000n,
      minOut: (size * (quotePerMillion - (quotePerMillion * 30n) / 10_000n)) / 1_000_000n,
      quoteObservedAt: observedAt,
      recipient: PRINCIPAL_ON_ARBITRUM,
      claims: NO_CLAIMS,
    }),
  };
}

export const SWAP_AGENT: DomainAgentSpec = {
  role: 'swap',
  objective: 'Swap USDC into WETH for the portfolio with the best execution quality available among the supplied routes, or abstain.',
  candidates: [
    route('route-a', APPROVED_ROUTER, APPROVED_POOL, 120_000_000_000n, 500n, [
      { label: 'Router', value: `…${APPROVED_ROUTER.slice(-4)}` },
      { label: 'Pool', value: `…${APPROVED_POOL.slice(-4)}, 0.30 % fee tier, deep (fixture)` },
      { label: 'Quoted output', value: '0.000012 WETH per 100 USDC (fixture quote)' },
      { label: 'Minimum out', value: 'quote − 0.30 %' },
      { label: 'Max size', value: '500 USDC (fixture pool depth)' },
    ]),
    route('route-c', APPROVED_ROUTER, SWAP_POOL_C, 120_240_000_000n, 250n, [
      { label: 'Router', value: `…${APPROVED_ROUTER.slice(-4)}` },
      { label: 'Pool', value: `…${SWAP_POOL_C.slice(-4)}, 0.05 % fee tier, shallow (fixture)` },
      { label: 'Quoted output', value: '0.000012024 WETH per 100 USDC (fixture quote), +0.20 % vs route-a' },
      { label: 'Minimum out', value: 'quote − 0.30 %' },
      { label: 'Max size', value: '250 USDC (fixture pool depth)' },
    ]),
    route('route-b', UNKNOWN_ROUTER, APPROVED_POOL, 125_000_000_000n, 500n, [
      { label: 'Router', value: `…${UNKNOWN_ROUTER.slice(-4)}` },
      { label: 'Quoted output', value: '0.0000125 WETH per 100 USDC (fixture quote), +4.17 % vs route-a' },
      { label: 'Minimum out', value: 'quote − 0.30 %' },
    ]),
  ],
};
