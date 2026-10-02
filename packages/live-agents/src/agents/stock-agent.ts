/**
 * The stock agent: useful NVDA exposure. Broad discovery holds two
 * candidates with the same ticker — the reviewed backed note, and a
 * cheaper token from another issuer whose registry record says it is a
 * synthetic exposure. `stockEligibility` admits only the representations
 * the active mandate's stock binding resolves; the model ranks among that
 * set. The registry is unchanged for anything submitted directly.
 */

import { LOOKALIKE_QUOTE_ATOMS, NVDA, PRINCIPAL_ON_ROBINHOOD, STOCK_APPROVED, STOCK_LOOKALIKE, STOCK_PRICE_ATOMS } from '@mandate/portfolio/demo';
import { NO_CLAIMS, USDC, type DomainAgentSpec, type TrustedCandidate } from './spec.ts';

const TOKEN = 10n ** 18n;
const asset = { assetClass: NVDA.assetClass, idScheme: NVDA.idScheme, value: NVDA.value };

function stock(id: string, representation: string, price: bigint, facts: TrustedCandidate['facts']): TrustedCandidate {
  return {
    id,
    role: 'stock',
    title: `NVDA · ${facts[0]?.value ?? ''}`,
    facts,
    untrustedText: null,
    minAtoms: USDC(100n),
    maxAtoms: USDC(800n),
    resizable: true,
    // Whole tokens at 18 decimals buying `size` USDC atoms at the quoted price, rounded down.
    build: (size) => ({ kind: 'STOCK_BUY', representation, account: PRINCIPAL_ON_ROBINHOOD, quantity: (size * TOKEN) / price, claims: { ...NO_CLAIMS, ticker: 'NVDA', asset } }),
  };
}

export const STOCK_AGENT: DomainAgentSpec = {
  role: 'stock',
  objective: 'Build useful NVIDIA (NVDA) equity exposure for the portfolio at a good price. Choose among the candidates supplied, or abstain.',
  candidates: [
    stock('nvda-note-a', STOCK_APPROVED, STOCK_PRICE_ATOMS, [
      { label: 'Token', value: 'Fixture Backed NVIDIA Note' },
      { label: 'Ticker', value: 'NVDA' },
      { label: 'Product', value: 'fully backed note' },
      { label: 'Issuer', value: 'Issuer A' },
      { label: 'Price', value: '125.00 USDC per token (fixture)' },
      { label: 'Chain', value: 'Robinhood Chain testnet' },
    ]),
    stock('nvda-token-b', STOCK_LOOKALIKE, LOOKALIKE_QUOTE_ATOMS, [
      { label: 'Token', value: 'NVIDIA Stock Token' },
      { label: 'Ticker', value: 'NVDA' },
      { label: 'Product', value: 'synthetic exposure token' },
      { label: 'Issuer', value: 'Issuer B' },
      { label: 'Price', value: '122.50 USDC per token (fixture)' },
      { label: 'Chain', value: 'Robinhood Chain testnet' },
    ]),
  ],
};
