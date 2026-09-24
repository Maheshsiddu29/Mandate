import type { Amount, Identifier, Price, UnixSeconds } from '@mandate/kernel';
import { parsePrice } from '@mandate/kernel';
import { multiplyFixedExact, parseFixedDecimal, type FixedDecimal } from './decimal.ts';
import { authoritativeHttpEvidence, ObservationClock, verifiedDerivation, type Evidence } from './evidence.ts';
import { parseRobinhoodDeployment, type RobinhoodDeployment } from './asset.ts';
import { AdapterErrorCode, adapterErr, adapterOk, type AdapterResult } from './result.ts';
import { parseRfc3339Seconds } from './time.ts';

export const ROBINHOOD_PRICES_SOURCE = 'robinhood-rhj-prices' as Identifier;
export const TOKEN_PRICE_DERIVATION_SOURCE = 'mandate-token-price-normalization' as Identifier;
export const PRICE_DECIMALS = 18;

export interface NormalizedRobinhoodPrice {
  readonly tokenSymbol: Evidence<string>;
  readonly deployments: Evidence<readonly RobinhoodDeployment[]>;
  /** Raw underlying-share price. It is deliberately not called token price. */
  readonly underlyingBid: Evidence<Price>;
  readonly underlyingAsk: Evidence<Price>;
  readonly currency: Evidence<string>;
  readonly dailyTradingVolume: Evidence<Amount>;
  readonly tradingHalt: Evidence<boolean>;
  readonly generatedAtUnixSeconds: UnixSeconds;
  readonly fetchedAtUnixSeconds: UnixSeconds;
  /** Currently present on the live wire but not required by the published schema. */
  readonly publishedTokenBid: Evidence<Price> | null;
  readonly publishedTokenAsk: Evidence<Price> | null;
}

export interface PriceParseContext {
  readonly fetchedAtUnixSeconds: UnixSeconds;
}

function objectAt(raw: unknown, path: string): AdapterResult<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, path, 'expected an object');
  }
  return adapterOk(raw as Record<string, unknown>);
}

function priceOf(raw: unknown, path: string, denominatorUnit = 'SHARE'): AdapterResult<Price> {
  const decimal = parseFixedDecimal(raw, PRICE_DECIMALS, path);
  if (!decimal.ok) return decimal;
  if (decimal.value.atoms === 0n) return adapterErr(AdapterErrorCode.INVALID_DECIMAL, path, 'price must be positive');
  const price = parsePrice({
    numeratorUnit: 'USD',
    denominatorUnit,
    decimals: PRICE_DECIMALS,
    atoms: decimal.value.atoms,
  });
  if (!price.ok) return adapterErr(AdapterErrorCode.INVALID_DECIMAL, path, 'price units are invalid');
  return adapterOk(price.value);
}

export function tokenEquivalentPrice(
  underlying: Evidence<Price>,
  currentMultiplier: Evidence<FixedDecimal>,
): AdapterResult<Evidence<Price>> {
  if (underlying.value.numeratorUnit !== 'USD' || underlying.value.denominatorUnit !== 'SHARE') {
    return adapterErr(AdapterErrorCode.INVALID_DECIMAL, 'price', 'expected USD per SHARE underlying price');
  }
  const multiplied = multiplyFixedExact(
    { atoms: underlying.value.atoms, decimals: underlying.value.decimals },
    currentMultiplier.value,
    PRICE_DECIMALS,
    'tokenEquivalentPrice',
  );
  if (!multiplied.ok) return multiplied;
  const parsed = parsePrice({
    numeratorUnit: 'USD', denominatorUnit: 'TOKEN', decimals: PRICE_DECIMALS, atoms: multiplied.value.atoms,
  });
  if (!parsed.ok) return adapterErr(AdapterErrorCode.INVALID_DECIMAL, 'tokenEquivalentPrice', 'normalized price is invalid');
  const observedAt = underlying.provenance.observedAtUnixSeconds < currentMultiplier.provenance.observedAtUnixSeconds
    ? underlying.provenance.observedAtUnixSeconds
    : currentMultiplier.provenance.observedAtUnixSeconds;
  return adapterOk(verifiedDerivation(
    parsed.value,
    TOKEN_PRICE_DERIVATION_SOURCE,
    observedAt,
    ObservationClock.SOURCE_TIMESTAMP,
    [underlying.provenance.sourceId, currentMultiplier.provenance.sourceId],
  ));
}

export function requireFreshPrice(
  price: NormalizedRobinhoodPrice,
  nowUnixSeconds: UnixSeconds,
  maxAgeSeconds: bigint,
): AdapterResult<NormalizedRobinhoodPrice> {
  const age = nowUnixSeconds - price.generatedAtUnixSeconds;
  if (age < 0n || age > maxAgeSeconds) {
    return adapterErr(AdapterErrorCode.STALE_OBSERVATION, 'quote.generatedAt', 'quote is stale or from the future');
  }
  return adapterOk(price);
}

export function parseRobinhoodPriceResponse(raw: unknown, context: PriceParseContext): AdapterResult<NormalizedRobinhoodPrice> {
  const response = objectAt(raw, 'response');
  if (!response.ok) return response;
  const quotes = response.value['quotes'];
  if (!Array.isArray(quotes) || quotes.length !== 1) {
    return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, 'response.quotes', 'symbol endpoint must return exactly one quote');
  }
  const quote = objectAt(quotes[0], 'response.quotes[0]');
  if (!quote.ok) return quote;
  const record = quote.value;
  const symbol = record['tokenSymbol'];
  if (typeof symbol !== 'string' || !/^[A-Z0-9.\-]{1,16}$/.test(symbol)) {
    return adapterErr(AdapterErrorCode.INVALID_IDENTITY, 'quote.tokenSymbol', 'invalid token symbol');
  }
  const deploymentsRaw = record['deployments'];
  if (!Array.isArray(deploymentsRaw) || deploymentsRaw.length === 0) {
    return adapterErr(AdapterErrorCode.MISSING_REQUIRED_FIELD, 'quote.deployments', 'quote requires a deployment');
  }
  const deployments: RobinhoodDeployment[] = [];
  for (let index = 0; index < deploymentsRaw.length; index += 1) {
    const parsed = parseRobinhoodDeployment(deploymentsRaw[index], `quote.deployments[${index}]`);
    if (!parsed.ok) return parsed;
    deployments.push(parsed.value);
  }
  const bid = priceOf(record['bid'], 'quote.bid');
  if (!bid.ok) return bid;
  const ask = priceOf(record['ask'], 'quote.ask');
  if (!ask.ok) return ask;
  if (bid.value.atoms > ask.value.atoms) return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, 'quote', 'bid exceeds ask');
  if (record['currency'] !== 'USD') return adapterErr(AdapterErrorCode.UNKNOWN_ENUM, 'quote.currency', 'only USD is established');
  const volume = parseFixedDecimal(record['dailyTradingVolume'], 18, 'quote.dailyTradingVolume');
  if (!volume.ok) return volume;
  if (typeof record['isTradingHalt'] !== 'boolean') {
    return adapterErr(AdapterErrorCode.MISSING_REQUIRED_FIELD, 'quote.isTradingHalt', 'trading halt must be a boolean');
  }
  const generatedAt = parseRfc3339Seconds(record['generatedAt'], 'quote.generatedAt');
  if (!generatedAt.ok) return generatedAt;
  const evidence = <T>(value: T): Evidence<T> => authoritativeHttpEvidence(
    value, ROBINHOOD_PRICES_SOURCE, generatedAt.value, ObservationClock.SOURCE_TIMESTAMP,
  );
  let publishedTokenBid: Evidence<Price> | null = null;
  let publishedTokenAsk: Evidence<Price> | null = null;
  if (record['tokenBid'] !== undefined || record['tokenAsk'] !== undefined) {
    const tokenBid = priceOf(record['tokenBid'], 'quote.tokenBid', 'TOKEN');
    if (!tokenBid.ok) return tokenBid;
    const tokenAsk = priceOf(record['tokenAsk'], 'quote.tokenAsk', 'TOKEN');
    if (!tokenAsk.ok) return tokenAsk;
    publishedTokenBid = evidence(tokenBid.value);
    publishedTokenAsk = evidence(tokenAsk.value);
  }
  return adapterOk({
    tokenSymbol: evidence(symbol), deployments: evidence(deployments),
    underlyingBid: evidence(bid.value), underlyingAsk: evidence(ask.value),
    currency: evidence('USD'),
    dailyTradingVolume: evidence({ unit: 'SHARE' as Identifier, decimals: 18, atoms: volume.value.atoms }),
    tradingHalt: evidence(record['isTradingHalt']),
    generatedAtUnixSeconds: generatedAt.value,
    fetchedAtUnixSeconds: context.fetchedAtUnixSeconds,
    publishedTokenBid,
    publishedTokenAsk,
  });
}
