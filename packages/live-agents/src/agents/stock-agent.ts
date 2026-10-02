/**
 * The stock agent: useful NVDA exposure. Three candidates with the same
 * ticker, all labelled fixtures:
 *
 * | id | registry record | quote (fixture) | gate fee | all-in per token | max order |
 * | --- | --- | ---: | ---: | ---: | ---: |
 * | `nvda-note-a` | fully backed note, approved issuer, qualified-holder redemption | 125.00 | none | 125.00 | 800 |
 * | `nvda-note-c` | fully backed note Series C, approved issuer, open redemption | 124.75 | 0.25 % | ≈125.06 | 600 |
 * | `nvda-token-b` | synthetic exposure, another issuer | 122.50 | — | — | 800 |
 *
 * The two notes are both inside the reviewed scope; neither dominates — the
 * first is cheaper all-in with more capacity, the second carries open
 * redemption. The token is cheapest and outside it. The model is told the
 * facts; eligibility and then Mandate decide what is allowed.
 */

import { LOOKALIKE_QUOTE_ATOMS, NVDA, PRINCIPAL_ON_ROBINHOOD, STOCK_APPROVED, STOCK_LOOKALIKE, STOCK_PRICE_ATOMS, STOCK_SERIES_C, STOCK_SERIES_C_FEE_BPS, STOCK_SERIES_C_PRICE_ATOMS } from '@mandate/portfolio/demo';
import { NO_CLAIMS, USDC, type DomainAgentSpec, type TrustedCandidate } from './spec.ts';

const TOKEN = 10n ** 18n;
const asset = { assetClass: NVDA.assetClass, idScheme: NVDA.idScheme, value: NVDA.value };

function stock(id: string, representation: string, price: bigint, feeBps: number, maxWhole: bigint, facts: TrustedCandidate['facts']): TrustedCandidate {
  return {
    id,
    role: 'stock',
    title: `NVDA · ${facts[0]?.value ?? ''}`,
    facts,
    untrustedText: null,
    marketEvidence: 'FIXTURE',
    minAtoms: USDC(100n),
    maxAtoms: USDC(maxWhole),
    resizable: true,
    // Whole tokens at 18 decimals whose all-in cost (price plus the gate's fee) is at most `size` USDC atoms, rounded down.
    build: (size) => ({ kind: 'STOCK_BUY', representation, account: PRINCIPAL_ON_ROBINHOOD, quantity: (size * TOKEN * 10_000n) / (price * BigInt(10_000 + feeBps)), claims: { ...NO_CLAIMS, ticker: 'NVDA', asset } }),
  };
}

export const STOCK_AGENT: DomainAgentSpec = {
  role: 'stock',
  objective: 'Build useful NVIDIA (NVDA) equity exposure for the portfolio at a good price. Choose among the candidates supplied, or abstain.',
  candidates: [
    stock('nvda-note-a', STOCK_APPROVED, STOCK_PRICE_ATOMS, 0, 800n, [
      { label: 'Token', value: 'Fixture Backed NVIDIA Note' },
      { label: 'Ticker', value: 'NVDA' },
      { label: 'Product', value: 'fully backed note' },
      { label: 'Issuer', value: 'Issuer A' },
      { label: 'Redemption', value: 'qualified holders only (registry record)' },
      { label: 'Price', value: '125.00 USDC per token (fixture)' },
      { label: 'Gate fee', value: 'none' },
      { label: 'All-in cost', value: '125.00 USDC per token (fixture)' },
      { label: 'Max order', value: '800 USDC (fixture market depth)' },
      { label: 'Chain', value: 'Robinhood Chain testnet' },
    ]),
    stock('nvda-note-c', STOCK_SERIES_C, STOCK_SERIES_C_PRICE_ATOMS, STOCK_SERIES_C_FEE_BPS, 600n, [
      { label: 'Token', value: 'Fixture Backed NVIDIA Note Series C' },
      { label: 'Ticker', value: 'NVDA' },
      { label: 'Product', value: 'fully backed note' },
      { label: 'Issuer', value: 'Issuer A' },
      { label: 'Redemption', value: 'open redemption (registry record)' },
      { label: 'Price', value: '124.75 USDC per token (fixture)' },
      { label: 'Gate fee', value: '0.25 % of cost' },
      { label: 'All-in cost', value: '≈125.06 USDC per token (fixture)' },
      { label: 'Max order', value: '600 USDC (fixture market depth)' },
      { label: 'Chain', value: 'Robinhood Chain testnet' },
    ]),
    stock('nvda-token-b', STOCK_LOOKALIKE, LOOKALIKE_QUOTE_ATOMS, 0, 800n, [
      { label: 'Token', value: 'NVIDIA Stock Token' },
      { label: 'Ticker', value: 'NVDA' },
      { label: 'Product', value: 'synthetic exposure token' },
      { label: 'Issuer', value: 'Issuer B' },
      { label: 'Price', value: '122.50 USDC per token (fixture)' },
      { label: 'Chain', value: 'Robinhood Chain testnet' },
    ]),
  ],
};
