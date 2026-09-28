/**
 * Lighter market identity (Phase 7E.1; perp-policy-v1.md §8).
 *
 * A Lighter market becomes economic exposure to a canonical asset only through
 * a reviewed claim — never by its symbol. The claim pins the market's static
 * metadata (the digest a `perp.market` snapshot must match), the canonical
 * underlying `AssetId`, the collateral, and the policy's conservative taker
 * fee headroom. v1 accepts only markets whose contract multiplier is exactly 1
 * (so one base unit is one unit of the underlying) and whose size and price
 * decimals sum to USDC's 6 (so notional is exact in collateral atoms);
 * anything else — a `KSHIB`-style 1,000× market, a futures-rolled RWA — is
 * refused rather than approximated.
 */

import { keccakDigest, validateResourceId, type CanonicalAssetRef, type Digest32, type ResourceIdInput } from '@mandate/core';
import { USDC_DECIMALS, encodeMarketStatic, type MarketStatic } from './vocabulary.ts';

export interface LighterMarketClaim {
  readonly underlying: ResourceIdInput;
  readonly static: MarketStatic;
  /** The policy's fee headroom per fill, in units of 1/1,000,000; not the venue's published rate (testnet-evidence.md T-6). */
  readonly maxTakerFeeRate: bigint;
  /** Where the static metadata was observed, for review. */
  readonly evidence: { readonly source: string; readonly observedAt: bigint };
}

export interface CheckedClaim extends LighterMarketClaim {
  readonly asset: CanonicalAssetRef;
  /** The digest a `perp.market` snapshot's payload must equal (VERSION freshness). */
  readonly staticDigest: Digest32;
}

const ONE = /^1(?:\.0+)?$/;

export function marketStaticDigest(m: MarketStatic): Digest32 {
  return keccakDigest<Digest32>(encodeMarketStatic(m));
}

/** Validate a claim, or say exactly why it cannot be authorized. */
export function checkClaim(c: LighterMarketClaim, chainId: number): { ok: true; value: CheckedClaim } | { ok: false; reason: string } {
  const asset = validateResourceId(c.underlying, ['CANONICAL_ASSET'] as const, 'underlying');
  if (!asset.ok) return { ok: false, reason: 'UNDERLYING_NOT_CANONICAL' };
  const m = c.static;
  if (m.chainId !== chainId) return { ok: false, reason: 'CHAIN_MISMATCH' };
  if (m.marketType !== 'perp') return { ok: false, reason: 'NOT_A_PERP' };
  if (!ONE.test(m.multiplier)) return { ok: false, reason: 'MULTIPLIER_UNSUPPORTED' };
  if (m.sizeDecimals + m.priceDecimals !== USDC_DECIMALS) return { ok: false, reason: 'NOTIONAL_NOT_EXACT_IN_COLLATERAL' };
  if (m.minInitialMarginFraction <= 0 || m.minInitialMarginFraction > 10_000) return { ok: false, reason: 'MARGIN_FRACTION_INVALID' };
  if (c.maxTakerFeeRate < 0n || c.maxTakerFeeRate > 1_000_000n) return { ok: false, reason: 'FEE_RATE_INVALID' };
  return { ok: true, value: { ...c, asset: asset.value as CanonicalAssetRef, staticDigest: marketStaticDigest(m) } };
}

export const BTC: ResourceIdInput = { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:btc' };
export const ETH: ResourceIdInput = { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:eth' };
export const SOL: ResourceIdInput = { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:sol' };

/** Lighter testnet's L2 chain id (apidocs "Get Started"; reproduced by hashing real testnet transactions, testnet-evidence.md). */
export const LIGHTER_TESTNET_CHAIN_ID = 300;

const OBSERVED = { source: 'https://testnet.zklighter.elliot.ai/api/v1/orderBookDetails', observedAt: 1_790_636_640n };
const FEE_HEADROOM = 1_000n; // 0.1 % per fill; the observed testnet taker rate was 0.028 %.

/**
 * Reviewed testnet claims, from the orderBookDetails capture of 2026-09-28
 * (test/fixtures/testnet-order-book-details.json). Each names its canonical
 * underlying explicitly: the symbol "BTC" is not what makes market 4096 BTC
 * exposure — this claim is.
 */
export const LIGHTER_TESTNET_CLAIMS: readonly LighterMarketClaim[] = [
  {
    underlying: BTC,
    static: { chainId: 300, marketIndex: 4096, symbol: 'BTC', marketType: 'perp', sizeDecimals: 5, priceDecimals: 1, minBaseAmount: 20n, minQuoteAmount: 10_000_000n, minInitialMarginFraction: 200, defaultInitialMarginFraction: 500, maintenanceMarginFraction: 120, closeoutMarginFraction: 80, multiplier: '1.000000000000000000' },
    maxTakerFeeRate: FEE_HEADROOM,
    evidence: OBSERVED,
  },
  {
    underlying: ETH,
    static: { chainId: 300, marketIndex: 4095, symbol: 'ETH', marketType: 'perp', sizeDecimals: 4, priceDecimals: 2, minBaseAmount: 50n, minQuoteAmount: 10_000_000n, minInitialMarginFraction: 200, defaultInitialMarginFraction: 500, maintenanceMarginFraction: 120, closeoutMarginFraction: 80, multiplier: '1.000000000000000000' },
    maxTakerFeeRate: FEE_HEADROOM,
    evidence: OBSERVED,
  },
  {
    underlying: SOL,
    static: { chainId: 300, marketIndex: 4097, symbol: 'SOL', marketType: 'perp', sizeDecimals: 3, priceDecimals: 3, minBaseAmount: 50n, minQuoteAmount: 10_000_000n, minInitialMarginFraction: 400, defaultInitialMarginFraction: 666, maintenanceMarginFraction: 240, closeoutMarginFraction: 160, multiplier: '1.000000000000000000' },
    maxTakerFeeRate: FEE_HEADROOM,
    evidence: OBSERVED,
  },
];
