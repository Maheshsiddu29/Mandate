/**
 * The demonstration's Portfolio Mandate and domain bindings. **Labelled
 * fixture data** over the markets in markets.ts.
 *
 * HYBRID allocation of 2,000 USDC committed notional across five agents, each
 * with a different *shape* of authority:
 *
 * | Agent | Authority it demonstrates | Preferred | Hard maximum |
 * | --- | --- | ---: | ---: |
 * | stock | canonical asset + exact representation + approved issuer, via the registry | 500 | 800 |
 * | swap | venue, route, recipient and slippage binding | 250 | 500 |
 * | nft | collection contract identity, not display name | 250 | 400 |
 * | yield | product and issuer eligibility, quote freshness | 500 | 800 |
 * | perps | leverage bound + portfolio-wide derivative exposure | 500 | 600 |
 *
 * Portfolio-wide limits: 2,000 `portfolio-notional`; 400 `derivative-notional`
 * (perps only); 400 `illiquid-notional` (NFT only); 800 `spot-capital`
 * (stock); 400 `perp-margin` (perps). Only `portfolio-notional` is shared
 * across domains — the one unit every domain here commits in.
 */

import type { Identifier } from '@mandate/kernel';
import { createFixtureBinding, createFixtureModule } from '../domains/fixture.ts';
import { createPerpsBinding } from '../domains/perps.ts';
import { createStockBinding } from '../domains/stock.ts';
import type { DomainBinding } from '../binding.ts';
import { validatePortfolioMandate, type AgentPolicyInput, type PortfolioMandate, type PortfolioMandateInput } from '../mandate.ts';
import type { AuthorityScopeInput } from '../scope.ts';
import { demoParty } from './keys.ts';
import {
  APPROVED_POOL,
  APPROVED_ROUTER,
  APPROVED_VAULT,
  APPROVED_VAULT_PROTOCOL,
  ARBITRUM_CHAIN,
  BTC_ASSET,
  BTC_PERP,
  DEMO_DOMAIN_SEPARATOR,
  DEMO_GATE,
  DEMO_GATE_CODEHASH,
  DEMO_GATE_CONFIG,
  DEMO_T0,
  ETH_ASSET,
  EVIDENCE,
  GENESIS_ASSET,
  GENESIS_COLLECTION,
  LIGHTER_CHAIN,
  LIGHTER_VENUE,
  MARKETPLACE,
  NFT_CONFIG,
  NVDA,
  PERP_ACCOUNT,
  PERP_POLICY_CONFIG,
  PERP_STATE,
  PERP_SUB_ACCOUNT,
  PRINCIPAL,
  PRINCIPAL_ON_ARBITRUM,
  PRINCIPAL_ON_ROBINHOOD,
  ROBINHOOD_CHAIN,
  STOCK_APPROVED,
  SWAP_CONFIG,
  VAULT_ASSET,
  VAULT_ISSUER,
  YIELD_CONFIG,
  demoRegistry,
} from './markets.ts';
import { FIXTURE_ISSUER_APPROVED } from '@mandate/registry/testing';

export const DEMO_T_END = DEMO_T0 + 30n * 86_400n;
export const USDC = (whole: bigint): bigint => whole * 1_000_000n;

export const DEMO_RESOURCES = [
  { resource: 'portfolio-notional', kind: 'NOTIONAL', unit: 'USDC', decimals: 6, domain: null },
  { resource: 'derivative-notional', kind: 'NOTIONAL', unit: 'USDC', decimals: 6, domain: 'lighter-perp' },
  { resource: 'illiquid-notional', kind: 'NOTIONAL', unit: 'USDC', decimals: 6, domain: 'nft-fixture' },
  { resource: 'spot-capital', kind: 'CAPITAL', unit: 'USDC', decimals: 6, domain: 'robinhood-evm' },
  { resource: 'perp-margin', kind: 'MARGIN', unit: 'USDC', decimals: 6, domain: 'lighter-perp' },
] as const;

const GATE_VENUE = `${ROBINHOOD_CHAIN}/gate:${DEMO_GATE}`;

const none = { issuers: [], requiredRights: [], maxLeverage: null, maxSlippageBps: null, maxQuoteAgeSeconds: null, syntheticPolicy: 'FORBIDDEN' } as const;

export const PORTFOLIO_SCOPE: AuthorityScopeInput = {
  domains: ['robinhood-evm', 'swap-fixture', 'nft-fixture', 'yield-fixture', 'lighter-perp'],
  actions: ['STOCK_BUY', 'SWAP_EXACT_IN', 'NFT_BUY', 'YIELD_DEPOSIT', 'PERP_OPEN'],
  chains: [ROBINHOOD_CHAIN, ARBITRUM_CHAIN, LIGHTER_CHAIN],
  venues: [GATE_VENUE, APPROVED_ROUTER, APPROVED_POOL, MARKETPLACE, APPROVED_VAULT_PROTOCOL, LIGHTER_VENUE],
  assets: [NVDA, ETH_ASSET, GENESIS_ASSET, VAULT_ASSET, BTC_ASSET],
  representations: [STOCK_APPROVED, SWAP_CONFIG.instruments[0]?.instrument as Identifier, GENESIS_COLLECTION, APPROVED_VAULT, BTC_PERP],
  issuers: [FIXTURE_ISSUER_APPROVED, VAULT_ISSUER],
  recipients: [PRINCIPAL_ON_ROBINHOOD, PRINCIPAL_ON_ARBITRUM, PERP_ACCOUNT],
  syntheticPolicy: 'FORBIDDEN',
  requiredRights: [],
  maxLeverage: { numerator: 3n, scale: 0 },
  maxSlippageBps: 100,
  maxQuoteAgeSeconds: 300n,
};

export const AGENT_SCOPES: { readonly [K in 'stock' | 'swap' | 'nft' | 'yield' | 'perps']: AuthorityScopeInput } = {
  stock: { ...none, domains: ['robinhood-evm'], actions: ['STOCK_BUY'], chains: [ROBINHOOD_CHAIN], venues: [GATE_VENUE], assets: [NVDA], representations: [STOCK_APPROVED], issuers: [FIXTURE_ISSUER_APPROVED], recipients: [PRINCIPAL_ON_ROBINHOOD], requiredRights: ['ECONOMIC_EXPOSURE'] },
  swap: { ...none, domains: ['swap-fixture'], actions: ['SWAP_EXACT_IN'], chains: [ARBITRUM_CHAIN], venues: [APPROVED_ROUTER, APPROVED_POOL], assets: [ETH_ASSET], representations: [SWAP_CONFIG.instruments[0]?.instrument as Identifier], recipients: [PRINCIPAL_ON_ARBITRUM], maxSlippageBps: 50, maxQuoteAgeSeconds: 60n },
  nft: { ...none, domains: ['nft-fixture'], actions: ['NFT_BUY'], chains: [ARBITRUM_CHAIN], venues: [MARKETPLACE], assets: [GENESIS_ASSET], representations: [GENESIS_COLLECTION], recipients: [PRINCIPAL_ON_ARBITRUM] },
  yield: { ...none, domains: ['yield-fixture'], actions: ['YIELD_DEPOSIT'], chains: [ARBITRUM_CHAIN], venues: [APPROVED_VAULT_PROTOCOL], assets: [VAULT_ASSET], representations: [APPROVED_VAULT], issuers: [VAULT_ISSUER], recipients: [PRINCIPAL_ON_ARBITRUM], maxQuoteAgeSeconds: 300n },
  perps: { ...none, domains: ['lighter-perp'], actions: ['PERP_OPEN'], chains: [LIGHTER_CHAIN], venues: [LIGHTER_VENUE], assets: [BTC_ASSET], representations: [BTC_PERP], recipients: [PERP_ACCOUNT], maxLeverage: { numerator: 3n, scale: 0 } },
};

const amounts = (entries: readonly (readonly [string, bigint])[]) => entries.map(([resource, whole]) => ({ resource, atoms: USDC(whole) }));

export function demoAgents(): AgentPolicyInput[] {
  const agent = (role: keyof typeof AGENT_SCOPES, hard: readonly (readonly [string, bigint])[], preferred: readonly (readonly [string, bigint])[]): AgentPolicyInput => ({
    agent: demoParty(role),
    label: role,
    scope: AGENT_SCOPES[role],
    notBefore: DEMO_T0,
    expiresAt: DEMO_T_END,
    hardMaxima: amounts(hard),
    preferred: amounts(preferred),
  });
  return [
    agent('stock', [['portfolio-notional', 800n], ['spot-capital', 800n]], [['portfolio-notional', 500n], ['spot-capital', 800n]]),
    agent('swap', [['portfolio-notional', 500n]], [['portfolio-notional', 250n]]),
    agent('nft', [['portfolio-notional', 400n], ['illiquid-notional', 400n]], [['portfolio-notional', 250n], ['illiquid-notional', 400n]]),
    agent('yield', [['portfolio-notional', 800n]], [['portfolio-notional', 500n]]),
    // Perps lists no derivative-notional ceiling of its own: the portfolio-wide 400 bounds it (Core's path rule).
    agent('perps', [['portfolio-notional', 600n], ['perp-margin', 400n]], [['portfolio-notional', 500n], ['perp-margin', 400n]]),
  ];
}

export function demoMandateInput(o: Partial<PortfolioMandateInput> = {}): PortfolioMandateInput {
  return {
    principal: PRINCIPAL,
    policyVersion: 1n,
    nonce: 1n,
    notBefore: DEMO_T0,
    expiresAt: DEMO_T_END,
    allocationMode: 'HYBRID',
    resources: DEMO_RESOURCES,
    scope: PORTFOLIO_SCOPE,
    limits: amounts([
      ['portfolio-notional', 2_000n],
      ['derivative-notional', 400n],
      ['illiquid-notional', 400n],
      ['spot-capital', 800n],
      ['perp-margin', 400n],
    ]),
    agents: demoAgents(),
    ...o,
  };
}

export function demoMandate(o: Partial<PortfolioMandateInput> = {}): PortfolioMandate {
  const m = validatePortfolioMandate(demoMandateInput(o));
  if (!m.ok) throw new Error(`demo mandate refused: ${m.error.code} at ${m.error.path}`);
  return m.value;
}

/** The five bindings over the demonstration's markets. */
export function demoBindings(): readonly DomainBinding[] {
  return [
    createStockBinding({
      gate: DEMO_GATE_CONFIG,
      gateCodehash: DEMO_GATE_CODEHASH,
      domainSeparator: DEMO_DOMAIN_SEPARATOR,
      registry: demoRegistry(),
      principalAddress: PRINCIPAL.value,
      source: 'robinhood.rpc' as never,
      maxMarketAgeSeconds: 60n,
      lifetimeSeconds: 3_600n,
      evidence: EVIDENCE.stock,
      integration: 'robinhood-gate-signer.v1' as Identifier,
    }),
    createFixtureBinding(createFixtureModule(SWAP_CONFIG)),
    createFixtureBinding(createFixtureModule(NFT_CONFIG)),
    createFixtureBinding(createFixtureModule(YIELD_CONFIG)),
    createPerpsBinding({ policy: PERP_POLICY_CONFIG, subAccount: PERP_SUB_ACCOUNT, state: PERP_STATE, evidence: EVIDENCE.perps, integration: 'lighter-perp-policy.v1' as Identifier }),
  ];
}
