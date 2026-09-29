/**
 * A compact, deterministic portfolio mandate for encoding, derivation and
 * allocation tests. Every identifier is a labelled fixture; no venue, token or
 * account here exists.
 */

import { validatePortfolioMandate, type AgentPolicyInput, type AuthorityScopeInput, type PortfolioMandate, type PortfolioMandateInput } from '../../src/index.ts';
import { party, testKey } from './keys.ts';

export function must<T>(r: { ok: true; value: T } | { ok: false; error: object }): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error, (_, v: bigint | string) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r.value;
}

/** The refusal code of a result, or `'ok'`. */
export function codeOf(r: { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } }): string {
  return r.ok ? 'ok' : r.error.code;
}

export const PRINCIPAL_KEY = testKey('principal');
export const STOCK_KEY = testKey('stock');
export const SWAP_KEY = testKey('swap');
export const PERPS_KEY = testKey('perps');
export const OUTSIDER_KEY = testKey('outsider');
export const PRINCIPAL = party(PRINCIPAL_KEY);
export const STOCK = party(STOCK_KEY);
export const SWAP = party(SWAP_KEY);
export const PERPS = party(PERPS_KEY);
export const OUTSIDER = party(OUTSIDER_KEY);

export const T0 = 1_800_000_000n;
export const T_END = T0 + 30n * 86_400n;

export const NVDA = { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' };
export const WETH = { assetClass: 'crypto', idScheme: 'mandate-fixture', value: 'ETH' };
export const BTC = { assetClass: 'crypto', idScheme: 'mandate-fixture', value: 'BTC' };

export const USDC6 = (whole: bigint) => whole * 1_000_000n;

export const RESOURCES = [
  { resource: 'portfolio-notional', kind: 'NOTIONAL', unit: 'USDC', decimals: 6, domain: null },
  { resource: 'derivative-notional', kind: 'NOTIONAL', unit: 'USDC', decimals: 6, domain: 'lighter-perp' },
  { resource: 'spot-capital', kind: 'CAPITAL', unit: 'USDC', decimals: 6, domain: 'robinhood-evm' },
  { resource: 'perp-margin', kind: 'MARGIN', unit: 'USDC', decimals: 6, domain: 'lighter-perp' },
];

export function scope(o: Partial<AuthorityScopeInput> = {}): AuthorityScopeInput {
  return {
    domains: ['robinhood-evm', 'swap-fixture', 'lighter-perp'],
    actions: ['STOCK_BUY', 'SWAP_EXACT_IN', 'PERP_OPEN'],
    chains: ['eip155:46630', 'eip155:421614', 'lighter:300'],
    venues: ['eip155:46630/gate:0x000000000000000000000000000000000000a7e0', 'eip155:421614/router:0x0000000000000000000000000000000000005a01', 'lighter:300/exchange'],
    assets: [NVDA, WETH, BTC],
    representations: ['eip155:46630/erc20:0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'eip155:421614/erc20:0x00000000000000000000000000000000000e7401', 'lighter:300/perp:4096'],
    issuers: ['issuer.fixture.alpha'],
    recipients: [`eip155:46630/account:${PRINCIPAL.value}`, `eip155:421614/account:${PRINCIPAL.value}`, 'lighter:300/account:281474976710600'],
    syntheticPolicy: 'FORBIDDEN',
    requiredRights: [],
    maxLeverage: { numerator: 3n, scale: 0 },
    maxSlippageBps: 100,
    maxQuoteAgeSeconds: 120n,
    ...o,
  };
}

export function agent(key: string, label: string, o: Partial<AgentPolicyInput> = {}): AgentPolicyInput {
  return { agent: party(key), label, scope: scope(), notBefore: T0, expiresAt: T_END, hardMaxima: [], preferred: [], ...o };
}

export function mandateInput(o: Partial<PortfolioMandateInput> = {}): PortfolioMandateInput {
  return {
    principal: PRINCIPAL,
    policyVersion: 1n,
    nonce: 7n,
    notBefore: T0,
    expiresAt: T_END,
    allocationMode: 'HYBRID',
    resources: RESOURCES,
    scope: scope(),
    limits: [
      { resource: 'portfolio-notional', atoms: USDC6(2_000n) },
      { resource: 'derivative-notional', atoms: USDC6(400n) },
      { resource: 'spot-capital', atoms: USDC6(800n) },
      { resource: 'perp-margin', atoms: USDC6(300n) },
    ],
    agents: [
      agent(STOCK_KEY, 'stock', {
        scope: scope({ domains: ['robinhood-evm'], actions: ['STOCK_BUY'], chains: ['eip155:46630'], venues: ['eip155:46630/gate:0x000000000000000000000000000000000000a7e0'], assets: [NVDA], representations: ['eip155:46630/erc20:0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'], recipients: [`eip155:46630/account:${PRINCIPAL.value}`], requiredRights: ['ECONOMIC_EXPOSURE'], maxLeverage: null, maxSlippageBps: null, maxQuoteAgeSeconds: null }),
        hardMaxima: [{ resource: 'portfolio-notional', atoms: USDC6(800n) }, { resource: 'spot-capital', atoms: USDC6(800n) }],
        preferred: [{ resource: 'portfolio-notional', atoms: USDC6(500n) }],
      }),
      agent(SWAP_KEY, 'swap', {
        scope: scope({ domains: ['swap-fixture'], actions: ['SWAP_EXACT_IN'], chains: ['eip155:421614'], venues: ['eip155:421614/router:0x0000000000000000000000000000000000005a01'], assets: [WETH], representations: ['eip155:421614/erc20:0x00000000000000000000000000000000000e7401'], issuers: [], recipients: [`eip155:421614/account:${PRINCIPAL.value}`], requiredRights: [], maxLeverage: null, maxQuoteAgeSeconds: 60n }),
        hardMaxima: [{ resource: 'portfolio-notional', atoms: USDC6(500n) }],
        preferred: [{ resource: 'portfolio-notional', atoms: USDC6(250n) }],
      }),
      agent(PERPS_KEY, 'perps', {
        scope: scope({ domains: ['lighter-perp'], actions: ['PERP_OPEN'], chains: ['lighter:300'], venues: ['lighter:300/exchange'], assets: [BTC], representations: ['lighter:300/perp:4096'], issuers: [], recipients: ['lighter:300/account:281474976710600'], requiredRights: [], maxSlippageBps: null, maxQuoteAgeSeconds: null }),
        hardMaxima: [{ resource: 'portfolio-notional', atoms: USDC6(600n) }, { resource: 'derivative-notional', atoms: USDC6(400n) }, { resource: 'perp-margin', atoms: USDC6(300n) }],
        preferred: [{ resource: 'portfolio-notional', atoms: USDC6(500n) }],
      }),
    ],
    ...o,
  };
}

export function sampleMandate(o: Partial<PortfolioMandateInput> = {}): PortfolioMandate {
  return must(validatePortfolioMandate(mandateInput(o)));
}
