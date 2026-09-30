/**
 * The reviewed catalog: every identity a Live AI Lab mandate may name.
 *
 * It is exactly the Phase 7F demonstration's portfolio scope (labelled
 * fixtures, `@mandate/portfolio/demo`). The principal may narrow it — pick a
 * subset, lower a bound — and never extend it: the domain bindings only
 * recognise reviewed instruments, so an identity outside this list could not
 * be authorized anyway, and a model has no way to add one. Every member has
 * a short stable id; drafts, models and the UI speak in ids, and only
 * `mandate-builder.ts` turns ids into protocol identifiers.
 */

import type { AuthorityScopeInput, CanonicalAssetInput } from '@mandate/portfolio';
import { AGENT_SCOPES, PORTFOLIO_SCOPE } from '@mandate/portfolio/demo';
import type { Role } from '../types.ts';

export interface CatalogEntry {
  readonly id: string;
  readonly label: string;
  /** The protocol identifier (for an asset, its canonical value). */
  readonly value: string;
}

export const CATALOG_SETS = ['assets', 'issuers', 'representations', 'venues', 'chains', 'recipients'] as const;
export type CatalogSet = (typeof CATALOG_SETS)[number];

function entries(values: readonly string[], ids: readonly (readonly [string, string])[]): readonly CatalogEntry[] {
  if (values.length !== ids.length) throw new Error('catalog labels out of step with the reviewed scope');
  return values.map((value, i) => ({ id: (ids[i] as readonly [string, string])[0], label: (ids[i] as readonly [string, string])[1], value }));
}

const assetValues = PORTFOLIO_SCOPE.assets.map((a) => a.value);

export const CATALOG: { readonly [S in CatalogSet]: readonly CatalogEntry[] } = {
  assets: entries(assetValues, [
    ['nvda', 'NVIDIA common stock (FIGI BBG000BBJQV0)'],
    ['eth', 'Ether'],
    ['mandate-genesis', 'Mandate Genesis NFT collection'],
    ['alpha-usd-vault', 'Alpha USD vault shares'],
    ['btc', 'Bitcoin'],
  ]),
  issuers: entries(PORTFOLIO_SCOPE.issuers, [
    ['note-issuer-alpha', 'Backed-note issuer (reviewed fixture)'],
    ['vault-issuer-alpha', 'Alpha vault issuer (reviewed fixture)'],
  ]),
  representations: entries(PORTFOLIO_SCOPE.representations, [
    ['nvda-backed-note', 'Fully backed NVDA note on Robinhood Chain testnet'],
    ['weth', 'WETH on Arbitrum Sepolia'],
    ['genesis-collection', 'Genesis collection contract'],
    ['alpha-vault', 'Alpha USD vault (ERC-4626)'],
    ['btc-perp', 'BTC perpetual on Lighter testnet'],
  ]),
  venues: entries(PORTFOLIO_SCOPE.venues, [
    ['robinhood-gate', 'Mandate gate (Robinhood Chain, offline configuration)'],
    ['swap-router', 'Reviewed swap router'],
    ['swap-pool', 'Reviewed USDC/WETH pool'],
    ['nft-marketplace', 'Reviewed NFT marketplace'],
    ['alpha-vault-protocol', 'Alpha vault protocol'],
    ['lighter-exchange', 'Lighter exchange'],
  ]),
  chains: entries(PORTFOLIO_SCOPE.chains, [
    ['robinhood-testnet', 'Robinhood Chain testnet (46630)'],
    ['arbitrum-sepolia', 'Arbitrum Sepolia (421614)'],
    ['lighter-testnet', 'Lighter testnet (300)'],
  ]),
  recipients: entries(PORTFOLIO_SCOPE.recipients, [
    ['principal-robinhood', 'Principal account on Robinhood Chain'],
    ['principal-arbitrum', 'Principal account on Arbitrum'],
    ['principal-perp-account', 'Principal perp sub-account on Lighter'],
  ]),
};

export function catalogIds(set: CatalogSet): readonly string[] {
  return CATALOG[set].map((e) => e.id);
}

export function entryById(set: CatalogSet, id: string): CatalogEntry | null {
  return CATALOG[set].find((e) => e.id === id) ?? null;
}

/** The reviewed per-action bounds: the most a live mandate may allow. */
export const REVIEWED_BOUNDS = {
  maxLeverage: 3n,
  maxSlippageBps: 100,
  maxQuoteAgeSeconds: 300,
  maxValidityMinutes: 7 * 24 * 60,
} as const;

/** The reviewed scope of each agent: what it could ever be given. */
export const REVIEWED_AGENT_SCOPES: { readonly [R in Role]: AuthorityScopeInput } = AGENT_SCOPES;
export const REVIEWED_PORTFOLIO_SCOPE: AuthorityScopeInput = PORTFOLIO_SCOPE;

export function assetInput(value: string): CanonicalAssetInput | null {
  return PORTFOLIO_SCOPE.assets.find((a) => a.value === value) ?? null;
}

/** What each agent does, for the review screen. */
export const AGENT_DOMAINS: { readonly [R in Role]: string } = {
  stock: 'robinhood-evm · STOCK_BUY',
  swap: 'swap-fixture · SWAP_EXACT_IN',
  nft: 'nft-fixture · NFT_BUY',
  yield: 'yield-fixture · YIELD_DEPOSIT',
  perps: 'lighter-perp · PERP_OPEN',
};

/** The agent resource an "exposure" guardrail sets, where the agent has one. */
export const EXPOSURE_RESOURCE: { readonly [R in Role]: string | null } = {
  stock: 'spot-capital',
  swap: null,
  nft: 'illiquid-notional',
  yield: null,
  perps: 'derivative-notional',
};
