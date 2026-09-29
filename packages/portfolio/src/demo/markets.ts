/**
 * The demonstration's five markets. **Labelled fixtures, offline.**
 *
 * What is real and what is not:
 *
 * - **Real code paths.** Stock uses GateSpotPolicy v1 and the
 *   `robinhood-gate-signer` adapter descriptor over the frozen Phase 6 gate —
 *   the path executed on Robinhood Chain testnet in Phase 7E.3 — and the
 *   existing registry. Perps uses PerpPolicy v1 over Lighter's recorded
 *   testnet market claims. Swap, NFT and yield use the FIXTURE module. All
 *   five reserve through the unchanged control engine and ledger.
 * - **Fixture data.** The gate here is an *offline* reviewed configuration,
 *   not the deployed testnet gate: its one market is a fictional token whose
 *   registry record says it is a fully backed note on NVIDIA (the registry's
 *   own fixture convention: real canonical identifiers, fictional
 *   representations), settling a fixture `USDC`. Like the Phase 7E.3
 *   cross-domain test, the settlement unit is **engineered** to be USDC so
 *   the stock, swap, NFT, yield and perps notional share one declared unit.
 *   Every address below is recognisably fictional. Prices are constants, not
 *   market data.
 */

import { domainSeparator, bytesToHex as kernelHex, type CanonicalAssetId, type Identifier } from '@mandate/kernel';
import type { DomainId, StateSourceId, UnitCode } from '@mandate/core';
import { createAddress, type ReviewedGate } from '@mandate/evm-robinhood';
import { gateDomain } from '@mandate/execution-gate';
import { LIGHTER_TESTNET_CHAIN_ID, LIGHTER_TESTNET_CLAIMS, accountResource as lighterAccount, type AccountBook, type PerpPolicyConfig } from '@mandate/perp-lighter';
import { openRegistry, type Registry } from '@mandate/registry';
import {
  FIXTURE_ASSET_NVDA,
  FIXTURE_ISSUER_APPROVED,
  FIXTURE_ISSUER_UNAPPROVED,
  FIXTURE_NOW,
  backedRepresentation,
  fixtureSnapshot,
  fixtureVerified,
  nvdaAsset,
  syntheticRepresentation,
} from '@mandate/registry/testing';
import { EvidenceClass } from '../binding.ts';
import type { FixtureDomainConfig, FixtureInstrument } from '../domains/fixture.ts';
import type { PerpStateSource } from '../domains/perps.ts';
import { demoParty } from './keys.ts';

/** The instant the demonstration runs around: the registry fixtures' own `FIXTURE_NOW`. */
export const DEMO_T0 = FIXTURE_NOW;

export const PRINCIPAL = demoParty('principal');

// --- Stock: Robinhood Chain (offline gate configuration) -------------------------------------

export const ROBINHOOD_CHAIN_ID = 46_630n;
export const ROBINHOOD_CHAIN = 'eip155:46630';
export const DEMO_GATE = '0x000000000000000000000000000000000000a7e0';
export const DEMO_GATE_CODEHASH = `0x${'c0'.repeat(32)}`;
export const DEMO_DOMAIN_SEPARATOR = kernelHex(domainSeparator(gateDomain(ROBINHOOD_CHAIN_ID, DEMO_GATE)));
/** A fixture token the gate settles in, declared to settle USDC (engineered — see the header). */
export const DEMO_USDC_TOKEN = '0x000000000000000000000000000000000000c0c0';

/** The approved representation: registered, fully backed, from the approved issuer. */
export const STOCK_APPROVED_ADDRESS = `0x${'b1'.repeat(20)}`;
/** The look-alike: registered, same display ticker `NVDA`, a synthetic exposure from an unapproved issuer. */
export const STOCK_LOOKALIKE_ADDRESS = `0x${'a7'.repeat(20)}`;
/** A counterfeit nobody registered, with the same ticker. Never placed in the snapshot. */
export const STOCK_COUNTERFEIT_ADDRESS = `0x${'fe'.repeat(20)}`;

export const STOCK_APPROVED = `${ROBINHOOD_CHAIN}/erc20:${STOCK_APPROVED_ADDRESS}` as Identifier;
export const STOCK_LOOKALIKE = `${ROBINHOOD_CHAIN}/erc20:${STOCK_LOOKALIKE_ADDRESS}` as Identifier;
export const STOCK_COUNTERFEIT = `${ROBINHOOD_CHAIN}/erc20:${STOCK_COUNTERFEIT_ADDRESS}` as Identifier;
export const NVDA: CanonicalAssetId = { ...FIXTURE_ASSET_NVDA } as CanonicalAssetId;

/** 125.00 USDC per token for the approved note; the look-alike quotes 122.50 somewhere else. */
export const STOCK_PRICE_ATOMS = 125_000_000n;
export const LOOKALIKE_QUOTE_ATOMS = 122_500_000n;

export const DEMO_GATE_CONFIG: ReviewedGate = {
  chainId: ROBINHOOD_CHAIN_ID,
  gate: DEMO_GATE,
  markets: [
    {
      representation: STOCK_APPROVED_ADDRESS,
      fundingToken: DEMO_USDC_TOKEN,
      venue: createAddress(DEMO_GATE, 1n),
      adapter: createAddress(DEMO_GATE, 2n),
      representationDecimals: 18,
      fundingDecimals: 6,
      canonicalAsset: { assetClass: NVDA.assetClass, idScheme: NVDA.idScheme, value: NVDA.value },
      issuer: FIXTURE_ISSUER_APPROVED,
      venueId: 'venue.mandate-fixture',
      quantityUnit: 'TOKEN',
      settlementUnit: 'USDC',
      synthetic: false,
      fixturePrice: { decimals: 6, atoms: STOCK_PRICE_ATOMS },
      feeBps: 0,
    },
  ],
};

/**
 * The registry snapshot: NVIDIA (a real canonical identifier), the approved
 * backed note, and a registered look-alike with the same ticker from an
 * unapproved issuer. `dataClass: SYNTHETIC_FIXTURE`, as every registry fixture.
 */
export function demoRegistry(): Registry {
  const snapshot = fixtureSnapshot({
    snapshotId: 'mandate-portfolio.demo',
    assets: [nvdaAsset()],
    representations: [
      backedRepresentation({ representationId: STOCK_APPROVED, display: { tokenSymbol: 'NVDA', tokenName: 'Fixture Backed NVIDIA Note' } }),
      syntheticRepresentation({
        representationId: STOCK_LOOKALIKE,
        display: { tokenSymbol: 'NVDA', tokenName: 'NVIDIA Stock Token' },
        issuer: fixtureVerified(FIXTURE_ISSUER_UNAPPROVED),
      }),
    ],
  });
  const r = openRegistry(snapshot);
  if (!r.ok) throw new Error(`demo registry refused: ${r.error}`);
  return r.value;
}

// --- Swap, NFT, yield: FIXTURE catalogs on Arbitrum Sepolia identifiers ------------------------

export const ARBITRUM_CHAIN = 'eip155:421614';
const arb = (kind: string, address: string) => `${ARBITRUM_CHAIN}/${kind}:${address}` as Identifier;

export const FIXTURE_USDC = arb('erc20', '0x000000000000000000000000000000000000c0c1');
export const WETH = arb('erc20', '0x00000000000000000000000000000000000e7401');
export const APPROVED_ROUTER = arb('router', '0x0000000000000000000000000000000000005a01');
export const UNKNOWN_ROUTER = arb('router', '0x000000000000000000000000000000000000bad0');
export const APPROVED_POOL = arb('pool', '0x0000000000000000000000000000000000000a01');
export const MARKETPLACE = arb('marketplace', '0x000000000000000000000000000000000000b0b0');
export const GENESIS_COLLECTION = arb('erc721', '0x000000000000000000000000000000000000c011');
export const IMPOSTOR_COLLECTION = arb('erc721', '0x000000000000000000000000000000000000fa4e');
export const APPROVED_VAULT = arb('erc4626', '0x000000000000000000000000000000000000a110');
export const UNVETTED_VAULT = arb('erc4626', '0x0000000000000000000000000000000000001260');
export const APPROVED_VAULT_PROTOCOL = arb('yield-protocol', '0x000000000000000000000000000000000000a110');
export const UNVETTED_VAULT_PROTOCOL = arb('yield-protocol', '0x0000000000000000000000000000000000001260');
export const VAULT_ISSUER = 'issuer.fixture.vault-alpha' as Identifier;
export const UNVETTED_ISSUER = 'issuer.fixture.unvetted' as Identifier;

export const ETH_ASSET: CanonicalAssetId = { assetClass: 'crypto', idScheme: 'mandate-core', value: 'crypto:eth' } as CanonicalAssetId;
export const GENESIS_ASSET: CanonicalAssetId = { assetClass: 'nft', idScheme: 'mandate-core', value: 'nft:mandate-genesis' } as CanonicalAssetId;
export const IMPOSTOR_ASSET: CanonicalAssetId = { assetClass: 'nft', idScheme: 'mandate-core', value: 'nft:impostor-genesis' } as CanonicalAssetId;
export const VAULT_ASSET: CanonicalAssetId = { assetClass: 'fund', idScheme: 'mandate-core', value: 'fund:alpha-usd-vault' } as CanonicalAssetId;
export const UNVETTED_ASSET: CanonicalAssetId = { assetClass: 'fund', idScheme: 'mandate-core', value: 'fund:unvetted-high-yield' } as CanonicalAssetId;
export const BTC_ASSET: CanonicalAssetId = { assetClass: 'crypto', idScheme: 'mandate-core', value: 'crypto:btc' } as CanonicalAssetId;

const core = (a: CanonicalAssetId) => ({ domain: 'registry', kind: 'CANONICAL_ASSET' as const, localId: a.value });
const principalOn = (chain: string) => `${chain}/account:${PRINCIPAL.value}` as Identifier;
export const PRINCIPAL_ON_ROBINHOOD = principalOn(ROBINHOOD_CHAIN);
export const PRINCIPAL_ON_ARBITRUM = principalOn(ARBITRUM_CHAIN);

function instrument(i: Omit<FixtureInstrument, 'coreAsset' | 'synthetic' | 'chain'> & { synthetic?: boolean }): FixtureInstrument {
  return { ...i, chain: ARBITRUM_CHAIN as Identifier, coreAsset: core(i.asset), synthetic: i.synthetic ?? false };
}

const common = { fundingToken: FIXTURE_USDC, settlementUnit: 'USDC' as UnitCode, settlementDecimals: 6, recipients: [PRINCIPAL_ON_ARBITRUM], maxAgeSeconds: 3_600n, lifetimeSeconds: 3_600n };

export const SWAP_CONFIG: FixtureDomainConfig = {
  ...common,
  domain: 'swap-fixture' as DomainId,
  kind: 'SWAP_EXACT_IN',
  actionType: 'swap.exact-in' as Identifier,
  instruments: [instrument({ instrument: WETH, asset: ETH_ASSET, issuer: null, venues: [APPROVED_ROUTER], displayName: 'Wrapped-Ether' as Identifier })],
  pools: [{ router: APPROVED_ROUTER, pool: APPROVED_POOL }],
  source: 'fixture.swap-catalog' as StateSourceId,
  integration: 'swap-fixture.v1' as Identifier,
};

export const NFT_CONFIG: FixtureDomainConfig = {
  ...common,
  domain: 'nft-fixture' as DomainId,
  kind: 'NFT_BUY',
  actionType: 'nft.buy' as Identifier,
  instruments: [
    instrument({ instrument: GENESIS_COLLECTION, asset: GENESIS_ASSET, issuer: null, venues: [MARKETPLACE], displayName: 'Mandate-Genesis' as Identifier }),
    // Recorded with its true identity: same display name, another contract, another asset.
    instrument({ instrument: IMPOSTOR_COLLECTION, asset: IMPOSTOR_ASSET, issuer: null, venues: [MARKETPLACE], displayName: 'Mandate-Genesis' as Identifier }),
  ],
  pools: [],
  source: 'fixture.nft-catalog' as StateSourceId,
  integration: 'nft-fixture.v1' as Identifier,
};

export const YIELD_CONFIG: FixtureDomainConfig = {
  ...common,
  domain: 'yield-fixture' as DomainId,
  kind: 'YIELD_DEPOSIT',
  actionType: 'yield.deposit' as Identifier,
  instruments: [
    instrument({ instrument: APPROVED_VAULT, asset: VAULT_ASSET, issuer: VAULT_ISSUER, venues: [APPROVED_VAULT_PROTOCOL], displayName: 'Alpha-USD-Vault' as Identifier }),
    instrument({ instrument: UNVETTED_VAULT, asset: UNVETTED_ASSET, issuer: UNVETTED_ISSUER, venues: [UNVETTED_VAULT_PROTOCOL], displayName: 'High-Yield-USD' as Identifier }),
  ],
  pools: [],
  source: 'fixture.yield-catalog' as StateSourceId,
  integration: 'yield-fixture.v1' as Identifier,
};

// --- Perps: Lighter testnet market claims, offline state ------------------------------------------

export const LIGHTER_CHAIN = `lighter:${LIGHTER_TESTNET_CHAIN_ID}`;
/** A sub-account index in Lighter's range; fictional. */
export const PERP_SUB_ACCOUNT = 281_474_976_710_600n;
export const PERP_ACCOUNT = `${LIGHTER_CHAIN}/account:${PERP_SUB_ACCOUNT}` as Identifier;
export const BTC_PERP = `${LIGHTER_CHAIN}/perp:4096` as Identifier;
export const LIGHTER_VENUE = `${LIGHTER_CHAIN}/exchange` as Identifier;

export const PERP_POLICY_CONFIG: PerpPolicyConfig = {
  chainId: LIGHTER_TESTNET_CHAIN_ID,
  claims: LIGHTER_TESTNET_CLAIMS,
  sources: { market: 'lighter.api' as StateSourceId, assetPrice: 'portfolio.price-fixture' as StateSourceId, account: 'lighter.api' as StateSourceId },
  maxAge: { assetPrice: 30n, account: 15n, market: 86_400n },
  lifetimeSeconds: 3_600n,
};

/** 100,000.0 USD per BTC at Lighter's 1 price decimal; the order price. */
export const BTC_PRICE_LIGHTER = 1_000_000n;

/**
 * Fixture prices and a fixture account book: 10,000 USDC collateral, flat,
 * isolated margin at an initial margin fraction of 50 % (2x) on BTC.
 */
export const PERP_STATE: PerpStateSource = {
  prices: () => new Map([['crypto:btc', 10_000_000n], ['crypto:eth', 250_000n], ['crypto:sol', 15_000n]]),
  book: (): AccountBook => {
    const a = lighterAccount(LIGHTER_TESTNET_CHAIN_ID, PERP_SUB_ACCOUNT);
    return {
      account: { domain: a.domain, kind: a.kind, localId: a.localId },
      collateral: 10_000_000_000n,
      availableBalance: 10_000_000_000n,
      positions: [{ marketIndex: 4096, size: 0n, marginMode: 'ISOLATED', initialMarginFraction: 5_000, allocatedMargin: 0n }],
      openOrders: [],
    };
  },
};

export const EVIDENCE = {
  stock: EvidenceClass.LIVE_TESTNET,
  perps: EvidenceClass.OFFCHAIN_ONLY,
  swap: EvidenceClass.FIXTURE,
  nft: EvidenceClass.FIXTURE,
  yield: EvidenceClass.FIXTURE,
} as const;
