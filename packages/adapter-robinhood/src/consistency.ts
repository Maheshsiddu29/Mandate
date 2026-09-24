import type { NormalizedRobinhoodAsset } from './asset.ts';
import type { NormalizedOnchainToken } from './onchain.ts';
import type { NormalizedOraclePrice } from './oracle.ts';
import { tokenEquivalentPrice, type NormalizedRobinhoodPrice } from './price.ts';

export const ConsistencyStatus = {
  MATCH: 'MATCH', MISMATCH: 'MISMATCH', NOT_COMPARABLE: 'NOT_COMPARABLE', UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type ConsistencyStatus = (typeof ConsistencyStatus)[keyof typeof ConsistencyStatus];

export interface ConsistencyDiagnostic {
  readonly fact: string;
  readonly status: ConsistencyStatus;
  readonly detail: string;
}

function diagnostic(fact: string, matches: boolean, detail: string): ConsistencyDiagnostic {
  return { fact, status: matches ? ConsistencyStatus.MATCH : ConsistencyStatus.MISMATCH, detail };
}

export function compareAssetAndOnchain(
  asset: NormalizedRobinhoodAsset,
  token: NormalizedOnchainToken,
): readonly ConsistencyDiagnostic[] {
  const hasDeployment = asset.deployments.value.some((deployment) =>
    deployment.chainId === token.chainId.value && deployment.contractAddress === token.contractAddress.value);
  return [
    diagnostic('deployment', hasDeployment, hasDeployment ? 'chain and contract match authoritative deployment' : 'chain or contract differs'),
    diagnostic('uid', asset.uid.value === token.uid.value, 'issuer API UID versus token uid()'),
    diagnostic('symbol', asset.tokenSymbol.value === token.symbol.value, 'issuer API symbol versus token symbol()'),
    diagnostic('name', asset.tokenName.value === token.name.value, 'issuer API name versus token name()'),
    diagnostic('decimals', asset.tokenDecimals.value === token.decimals.value, 'issuer API tokenDecimals versus token decimals()'),
    diagnostic('currentMultiplier', asset.currentMultiplier.value.atoms === token.currentMultiplier.value.atoms, 'issuer API currentMultiplier versus token uiMultiplier()'),
    diagnostic(
      'pendingMultiplier',
      (asset.pendingMultiplier.value?.atoms ?? null) === (token.pendingMultiplier.value?.atoms ?? null) &&
        asset.pendingMultiplierEffectiveAt.value === token.pendingMultiplierEffectiveAt.value,
      'issuer API pending state versus token newUIMultiplier()/effectiveAt()',
    ),
  ];
}

export function compareRestTokenPrices(
  asset: NormalizedRobinhoodAsset,
  price: NormalizedRobinhoodPrice,
): readonly ConsistencyDiagnostic[] {
  const bid = tokenEquivalentPrice(price.underlyingBid, asset.currentMultiplier);
  const ask = tokenEquivalentPrice(price.underlyingAsk, asset.currentMultiplier);
  const bidMatches = bid.ok && price.publishedTokenBid !== null && bid.value.value.atoms === price.publishedTokenBid.value.atoms;
  const askMatches = ask.ok && price.publishedTokenAsk !== null && ask.value.value.atoms === price.publishedTokenAsk.value.atoms;
  return [
    diagnostic('restTokenBid', bidMatches, 'underlying bid multiplied exactly by currentMultiplier'),
    diagnostic('restTokenAsk', askMatches, 'underlying ask multiplied exactly by currentMultiplier'),
  ];
}

/** Compare only observations close enough in source time. A later REST quote and
 * an older oracle answer are deliberately reported as not comparable. */
export function compareOracleWithRest(
  asset: NormalizedRobinhoodAsset,
  price: NormalizedRobinhoodPrice,
  oracle: NormalizedOraclePrice | null,
  maxTimeSkewSeconds: bigint,
): ConsistencyDiagnostic {
  if (oracle === null) return { fact: 'oracleTokenPrice', status: ConsistencyStatus.UNAVAILABLE, detail: 'no official feed captured' };
  const skew = price.generatedAtUnixSeconds >= oracle.updatedAtUnixSeconds
    ? price.generatedAtUnixSeconds - oracle.updatedAtUnixSeconds
    : oracle.updatedAtUnixSeconds - price.generatedAtUnixSeconds;
  if (skew > maxTimeSkewSeconds) {
    return { fact: 'oracleTokenPrice', status: ConsistencyStatus.NOT_COMPARABLE, detail: `source timestamps differ by ${skew} seconds` };
  }
  const bid = tokenEquivalentPrice(price.underlyingBid, asset.currentMultiplier);
  const ask = tokenEquivalentPrice(price.underlyingAsk, asset.currentMultiplier);
  if (!bid.ok || !ask.ok) return { fact: 'oracleTokenPrice', status: ConsistencyStatus.MISMATCH, detail: 'REST normalization failed' };
  const oracleScale = 10n ** BigInt(bid.value.value.decimals);
  const restScale = 10n ** BigInt(oracle.tokenPrice.value.decimals);
  const scaledOracle = oracle.tokenPrice.value.atoms * oracleScale;
  const withinSpread = scaledOracle >= bid.value.value.atoms * restScale && scaledOracle <= ask.value.value.atoms * restScale;
  return diagnostic('oracleTokenPrice', withinSpread, 'multiplier-adjusted oracle answer versus normalized REST token spread');
}
