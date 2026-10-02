/**
 * The Live AI Lab's market set V2. **Labelled fixtures, offline**, exactly
 * like markets.ts, which it extends and leaves untouched: the Phase 7F
 * demonstration, the judge demo and the generated corpus keep their world.
 *
 * A live model is offered only the actionable candidates of a domain. With
 * one reviewed instrument per domain it has nothing to compare. V2 adds one
 * more reviewed, approved alternative in stock, swap and yield, so the model
 * makes a real economic choice among authorizable opportunities. Every
 * addition is a reviewed record with its true identity. Nothing forbidden
 * becomes approved: the look-alike token, the unknown router, the impostor
 * collection and the unvetted vault are unchanged and stay outside scope.
 *
 * | Domain | V1 approved | V2 adds | The difference that makes it a choice |
 * | --- | --- | --- | --- |
 * | stock | the backed note (qualified-holder redemption, no gate fee) | a second backed note from the same approved issuer, **open redemption** (the registry's own `secondBackedRepresentation`) | lower quoted price but a 25 bps gate fee, and open redemption |
 * | swap | the reviewed pool under the reviewed router | a second reviewed pool under the **same** router (a lower fee tier) | a better quote through a shallower pool |
 * | yield | the Alpha vault | a Beta vault from a second reviewed issuer, on its own protocol | a higher advertised APY with a smaller deposit capacity |
 *
 * Prices, fees and quotes are constants, not market data. The stock gate
 * here is the offline reviewed configuration. On Robinhood Chain testnet
 * both notes are exercised through the one deployed fixture market — a
 * quantity-preserving BUY of the valueless MDEMO for MDUSD — each bound to
 * its own exact candidate (`@mandate/live-settlement`, fixture-mapping.ts);
 * any other stock reservation is refused at settlement, fail-closed.
 */

import type { CanonicalAssetId, Identifier } from '@mandate/kernel';
import { createAddress, type ReviewedGate } from '@mandate/evm-robinhood';
import { openRegistry, type Registry } from '@mandate/registry';
import { FIXTURE_ISSUER_APPROVED, FIXTURE_ISSUER_UNAPPROVED, backedRepresentation, fixtureSnapshot, fixtureVerified, nvdaAsset, secondBackedRepresentation, syntheticRepresentation } from '@mandate/registry/testing';
import type { DomainBinding } from '../binding.ts';
import { createFixtureBinding, createFixtureModule, type FixtureDomainConfig, type FixtureInstrument } from '../domains/fixture.ts';
import { createPerpsBinding } from '../domains/perps.ts';
import { createStockBinding } from '../domains/stock.ts';
import type { AuthorityScopeInput } from '../scope.ts';
import { AGENT_SCOPES, PORTFOLIO_SCOPE } from './mandate.ts';
import {
  APPROVED_ROUTER,
  ARBITRUM_CHAIN,
  DEMO_DOMAIN_SEPARATOR,
  DEMO_GATE,
  DEMO_GATE_CODEHASH,
  DEMO_GATE_CONFIG,
  EVIDENCE,
  NFT_CONFIG,
  PERP_POLICY_CONFIG,
  PERP_STATE,
  PERP_SUB_ACCOUNT,
  PRINCIPAL,
  ROBINHOOD_CHAIN,
  STOCK_APPROVED,
  STOCK_LOOKALIKE,
  SWAP_CONFIG,
  YIELD_CONFIG,
} from './markets.ts';

const arb = (kind: string, address: string) => `${ARBITRUM_CHAIN}/${kind}:${address}` as Identifier;

// --- Stock: a second approved NVDA note on the same reviewed gate --------------------------------

export const STOCK_SERIES_C_ADDRESS = `0x${'b2'.repeat(20)}`;
export const STOCK_SERIES_C = `${ROBINHOOD_CHAIN}/erc20:${STOCK_SERIES_C_ADDRESS}` as Identifier;
/** 124.75 USDC per token, plus a 25 bps gate fee: 125.06 all-in, against the V1 note's 125.00 with no fee. */
export const STOCK_SERIES_C_PRICE_ATOMS = 124_750_000n;
export const STOCK_SERIES_C_FEE_BPS = 25;

const v1Market = DEMO_GATE_CONFIG.markets[0] as ReviewedGate['markets'][number];

export const LIVE_GATE_CONFIG: ReviewedGate = {
  ...DEMO_GATE_CONFIG,
  markets: [
    v1Market,
    {
      ...v1Market,
      representation: STOCK_SERIES_C_ADDRESS,
      venue: createAddress(DEMO_GATE, 3n),
      adapter: createAddress(DEMO_GATE, 4n),
      fixturePrice: { decimals: 6, atoms: STOCK_SERIES_C_PRICE_ATOMS },
      feeBps: STOCK_SERIES_C_FEE_BPS,
    },
  ],
};

/**
 * The V1 registry snapshot plus the Series C note: fully backed, from the
 * approved issuer, open redemption. The look-alike is unchanged.
 */
export function liveRegistry(): Registry {
  const snapshot = fixtureSnapshot({
    snapshotId: 'mandate-portfolio.live-lab-v2',
    assets: [nvdaAsset()],
    representations: [
      backedRepresentation({ representationId: STOCK_APPROVED, display: { tokenSymbol: 'NVDA', tokenName: 'Fixture Backed NVIDIA Note' } }),
      secondBackedRepresentation({ representationId: STOCK_SERIES_C, display: { tokenSymbol: 'NVDA', tokenName: 'Fixture Backed NVIDIA Note Series C' }, issuer: fixtureVerified(FIXTURE_ISSUER_APPROVED) }),
      syntheticRepresentation({
        representationId: STOCK_LOOKALIKE,
        display: { tokenSymbol: 'NVDA', tokenName: 'NVIDIA Stock Token' },
        issuer: fixtureVerified(FIXTURE_ISSUER_UNAPPROVED),
      }),
    ],
  });
  const r = openRegistry(snapshot);
  if (!r.ok) throw new Error(`live registry refused: ${r.error}`);
  return r.value;
}

// --- Swap: a second reviewed pool under the same reviewed router ---------------------------------

/** A lower-fee-tier USDC/WETH pool, reviewed under the approved router. */
export const SWAP_POOL_C = arb('pool', '0x0000000000000000000000000000000000000a05');

export const LIVE_SWAP_CONFIG: FixtureDomainConfig = {
  ...SWAP_CONFIG,
  pools: [...SWAP_CONFIG.pools, { router: APPROVED_ROUTER, pool: SWAP_POOL_C }],
};

// --- Yield: a second reviewed vault, from a second reviewed issuer ------------------------------

export const BETA_VAULT = arb('erc4626', '0x000000000000000000000000000000000000be7a');
export const BETA_VAULT_PROTOCOL = arb('yield-protocol', '0x000000000000000000000000000000000000be7a');
export const BETA_VAULT_ISSUER = 'issuer.fixture.vault-beta' as Identifier;
export const BETA_VAULT_ASSET: CanonicalAssetId = { assetClass: 'fund', idScheme: 'mandate-core', value: 'fund:beta-usd-vault' } as CanonicalAssetId;

const betaInstrument: FixtureInstrument = {
  instrument: BETA_VAULT,
  chain: ARBITRUM_CHAIN as Identifier,
  asset: BETA_VAULT_ASSET,
  coreAsset: { domain: 'registry', kind: 'CANONICAL_ASSET', localId: BETA_VAULT_ASSET.value },
  issuer: BETA_VAULT_ISSUER,
  synthetic: false,
  venues: [BETA_VAULT_PROTOCOL],
  displayName: 'Beta-USD-Vault' as Identifier,
};

export const LIVE_YIELD_CONFIG: FixtureDomainConfig = {
  ...YIELD_CONFIG,
  instruments: [...YIELD_CONFIG.instruments, betaInstrument],
};

// --- Scopes: the V1 reviewed scopes, each widened by exactly the reviewed additions ---------------

const add = <T>(xs: readonly T[], more: readonly T[]): T[] => [...xs, ...more];

export const LIVE_PORTFOLIO_SCOPE: AuthorityScopeInput = {
  ...PORTFOLIO_SCOPE,
  venues: add(PORTFOLIO_SCOPE.venues, [SWAP_POOL_C, BETA_VAULT_PROTOCOL]),
  assets: add(PORTFOLIO_SCOPE.assets, [BETA_VAULT_ASSET]),
  representations: add(PORTFOLIO_SCOPE.representations, [STOCK_SERIES_C, BETA_VAULT]),
  issuers: add(PORTFOLIO_SCOPE.issuers, [BETA_VAULT_ISSUER]),
};

export const LIVE_AGENT_SCOPES: typeof AGENT_SCOPES = {
  ...AGENT_SCOPES,
  stock: { ...AGENT_SCOPES.stock, representations: add(AGENT_SCOPES.stock.representations, [STOCK_SERIES_C]) },
  swap: { ...AGENT_SCOPES.swap, venues: add(AGENT_SCOPES.swap.venues, [SWAP_POOL_C]) },
  yield: {
    ...AGENT_SCOPES.yield,
    venues: add(AGENT_SCOPES.yield.venues, [BETA_VAULT_PROTOCOL]),
    assets: add(AGENT_SCOPES.yield.assets, [BETA_VAULT_ASSET]),
    representations: add(AGENT_SCOPES.yield.representations, [BETA_VAULT]),
    issuers: add(AGENT_SCOPES.yield.issuers, [BETA_VAULT_ISSUER]),
  },
};

/** The five bindings over the V2 markets: the same code paths, the extended reviewed tables. */
export function liveLabBindings(): readonly DomainBinding[] {
  return [
    createStockBinding({
      gate: LIVE_GATE_CONFIG,
      gateCodehash: DEMO_GATE_CODEHASH,
      domainSeparator: DEMO_DOMAIN_SEPARATOR,
      registry: liveRegistry(),
      principalAddress: PRINCIPAL.value,
      source: 'robinhood.rpc' as never,
      maxMarketAgeSeconds: 60n,
      lifetimeSeconds: 3_600n,
      evidence: EVIDENCE.stock,
      integration: 'robinhood-gate-signer.v1' as Identifier,
    }),
    createFixtureBinding(createFixtureModule(LIVE_SWAP_CONFIG)),
    createFixtureBinding(createFixtureModule(NFT_CONFIG)),
    createFixtureBinding(createFixtureModule(LIVE_YIELD_CONFIG)),
    createPerpsBinding({ policy: PERP_POLICY_CONFIG, subAccount: PERP_SUB_ACCOUNT, state: PERP_STATE, evidence: EVIDENCE.perps, integration: 'lighter-perp-policy.v1' as Identifier }),
  ];
}
