/**
 * The perps agent: BTC exposure. A 2x and a 5x long. A 2x request can be
 * **individually valid** — inside the agent's own authority — and still
 * **portfolio invalid**, because the portfolio's derivative exposure limit
 * is shared; that is what the Mandate Room negotiates. The 5x is decided by
 * the leverage bound.
 */

import { BTC_PERP, BTC_PRICE_LIGHTER, PERP_ACCOUNT } from '@mandate/portfolio/demo';
import { NO_CLAIMS, USDC, type DomainAgentSpec, type TrustedCandidate } from './spec.ts';

/** Initial margin fraction per 10,000: leverage is 10,000 / it. */
function long(id: string, leverage: number, initialMarginFraction: number): TrustedCandidate {
  return {
    id,
    role: 'perps',
    title: `BTC-PERP long ${leverage}x`,
    facts: [
      { label: 'Market', value: 'BTC perpetual (Lighter testnet)' },
      { label: 'Side', value: 'LONG' },
      { label: 'Leverage', value: `${leverage}x` },
      { label: 'Mark', value: '100,000 USD per BTC (fixture)' },
      { label: 'Size', value: 'requested USDC notional' },
    ],
    untrustedText: null,
    minAtoms: USDC(100n),
    maxAtoms: USDC(1_000n),
    resizable: true,
    build: (size) => ({ kind: 'PERP_OPEN', market: BTC_PERP, account: PERP_ACCOUNT, side: 'LONG', size: size / BTC_PRICE_LIGHTER, price: BTC_PRICE_LIGHTER, initialMarginFraction, claims: NO_CLAIMS }),
  };
}

export const PERPS_AGENT: DomainAgentSpec = {
  role: 'perps',
  objective: 'Open BTC long exposure for the portfolio with a sensible size and leverage among the supplied markets, or abstain.',
  candidates: [long('btc-long-2x', 2, 5_000), long('btc-long-5x', 5, 2_000)],
};
