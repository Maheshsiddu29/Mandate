import type { Identifier, UnixSeconds } from '@mandate/kernel';
import { parseRepresentationId } from '@mandate/registry';
import { parseFixedDecimal, type FixedDecimal } from './decimal.ts';
import { authoritativeHttpEvidence, ObservationClock, type Evidence } from './evidence.ts';
import { parseRfc3339Seconds } from './time.ts';
import { AdapterErrorCode, adapterErr, adapterOk, type AdapterResult } from './result.ts';

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663n;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630n;
export const ROBINHOOD_ASSETS_SOURCE = 'robinhood-rhj-assets' as Identifier;

export const RobinhoodAssetStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type RobinhoodAssetStatus = (typeof RobinhoodAssetStatus)[keyof typeof RobinhoodAssetStatus];

export const TradingStatus = {
  TRADABLE: 'TRADABLE',
  UNTRADABLE: 'UNTRADABLE',
} as const;
export type TradingStatus = (typeof TradingStatus)[keyof typeof TradingStatus];

export interface TradingSessionCapability {
  readonly whole: TradingStatus;
  readonly fractional: TradingStatus;
}

export interface TradingCapabilities {
  readonly market: TradingSessionCapability;
  readonly extended: TradingSessionCapability;
  readonly overnight: TradingSessionCapability;
}

export interface RobinhoodDeployment {
  readonly chainId: bigint;
  readonly contractAddress: string;
}

export interface NormalizedRobinhoodAsset {
  readonly uid: Evidence<string>;
  readonly tokenSymbol: Evidence<string>;
  readonly tokenName: Evidence<string>;
  readonly deployments: Evidence<readonly RobinhoodDeployment[]>;
  readonly currentMultiplier: Evidence<FixedDecimal>;
  readonly pendingMultiplier: Evidence<FixedDecimal | null>;
  readonly pendingMultiplierEffectiveAt: Evidence<UnixSeconds | null>;
  readonly status: Evidence<RobinhoodAssetStatus>;
  readonly tradingCapabilities: Evidence<TradingCapabilities>;
  readonly tokenDecimals: Evidence<number>;
  /** Direct issuer identity reference. Asset class is established separately by
   * the audited canonical mapping; an ISIN alone does not say equity vs fund. */
  readonly isin: Evidence<string>;
}

export interface AssetParseContext {
  readonly fetchedAtUnixSeconds: UnixSeconds;
}

const UID = /^0x[0-9a-f]{64}$/;
const SYMBOL = /^[A-Z0-9.\-]{1,16}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function objectAt(raw: unknown, path: string): AdapterResult<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, path, 'expected an object');
  }
  return adapterOk(raw as Record<string, unknown>);
}

function requiredString(record: Record<string, unknown>, field: string, path: string): AdapterResult<string> {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    return adapterErr(AdapterErrorCode.MISSING_REQUIRED_FIELD, `${path}.${field}`, 'expected a non-empty string');
  }
  return adapterOk(value);
}

function parseDeployment(raw: unknown, path: string): AdapterResult<RobinhoodDeployment> {
  const object = objectAt(raw, path);
  if (!object.ok) return object;
  const chainId = object.value['chainId'];
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return adapterErr(AdapterErrorCode.INVALID_CHAIN_ID, `${path}.chainId`, 'chain ID must be a positive safe integer');
  }
  const address = object.value['contractAddress'];
  if (typeof address !== 'string' || !ADDRESS.test(address)) {
    return adapterErr(AdapterErrorCode.INVALID_ADDRESS, `${path}.contractAddress`, 'expected a 20-byte EVM address');
  }
  const representationId = parseRepresentationId({
    chainNamespace: 'eip155',
    chainReference: String(chainId),
    assetNamespace: 'erc20',
    contractAddress: address,
  });
  if (!representationId.ok) {
    return adapterErr(AdapterErrorCode.INVALID_ADDRESS, `${path}.contractAddress`, 'address checksum is invalid');
  }
  return adapterOk({ chainId: BigInt(chainId), contractAddress: representationId.value.contractAddress });
}

function parseTradingStatus(raw: unknown, path: string): AdapterResult<TradingStatus> {
  if (raw === 'TRADING_STATUS_TRADABLE') return adapterOk(TradingStatus.TRADABLE);
  if (raw === 'TRADING_STATUS_UNTRADABLE') return adapterOk(TradingStatus.UNTRADABLE);
  return adapterErr(AdapterErrorCode.UNKNOWN_ENUM, path, `unsafe trading status: ${String(raw)}`);
}

function parseSession(raw: unknown, path: string): AdapterResult<TradingSessionCapability> {
  const object = objectAt(raw, path);
  if (!object.ok) return object;
  const whole = parseTradingStatus(object.value['whole'], `${path}.whole`);
  if (!whole.ok) return whole;
  const fractional = parseTradingStatus(object.value['fractional'], `${path}.fractional`);
  if (!fractional.ok) return fractional;
  return adapterOk({ whole: whole.value, fractional: fractional.value });
}

function parseCapabilities(raw: unknown, path: string): AdapterResult<TradingCapabilities> {
  const object = objectAt(raw, path);
  if (!object.ok) return object;
  const market = parseSession(object.value['market'], `${path}.market`);
  if (!market.ok) return market;
  const extended = parseSession(object.value['extended'], `${path}.extended`);
  if (!extended.ok) return extended;
  const overnight = parseSession(object.value['overnight'], `${path}.overnight`);
  if (!overnight.ok) return overnight;
  return adapterOk({ market: market.value, extended: extended.value, overnight: overnight.value });
}

function parseStatus(raw: unknown, path: string): AdapterResult<RobinhoodAssetStatus> {
  if (raw === 'ASSET_STATUS_ACTIVE') return adapterOk(RobinhoodAssetStatus.ACTIVE);
  if (raw === 'ASSET_STATUS_INACTIVE') return adapterOk(RobinhoodAssetStatus.INACTIVE);
  if (raw === 'ASSET_STATUS_UNSPECIFIED') return adapterOk(RobinhoodAssetStatus.UNKNOWN);
  return adapterErr(AdapterErrorCode.UNKNOWN_ENUM, path, `unsafe asset status: ${String(raw)}`);
}

export function parseRobinhoodAsset(raw: unknown, context: AssetParseContext, path = 'asset'): AdapterResult<NormalizedRobinhoodAsset> {
  const object = objectAt(raw, path);
  if (!object.ok) return object;
  const record = object.value;
  const uid = requiredString(record, 'id', path);
  if (!uid.ok) return uid;
  if (!UID.test(uid.value)) return adapterErr(AdapterErrorCode.INVALID_IDENTITY, `${path}.id`, 'invalid Stock Token UID');
  const symbol = requiredString(record, 'tokenSymbol', path);
  if (!symbol.ok) return symbol;
  if (!SYMBOL.test(symbol.value)) return adapterErr(AdapterErrorCode.INVALID_IDENTITY, `${path}.tokenSymbol`, 'invalid token symbol');
  const name = requiredString(record, 'tokenName', path);
  if (!name.ok) return name;

  const rawDeployments = record['deployments'];
  if (!Array.isArray(rawDeployments) || rawDeployments.length === 0) {
    return adapterErr(AdapterErrorCode.MISSING_REQUIRED_FIELD, `${path}.deployments`, 'at least one deployment is required');
  }
  const deployments: RobinhoodDeployment[] = [];
  const deploymentKeys = new Set<string>();
  for (let index = 0; index < rawDeployments.length; index += 1) {
    const parsed = parseDeployment(rawDeployments[index], `${path}.deployments[${index}]`);
    if (!parsed.ok) return parsed;
    const key = `${parsed.value.chainId}:${parsed.value.contractAddress}`;
    if (deploymentKeys.has(key)) return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, `${path}.deployments`, 'duplicate deployment');
    deploymentKeys.add(key);
    deployments.push(parsed.value);
  }

  const currentMultiplier = parseFixedDecimal(record['currentMultiplier'], 18, `${path}.currentMultiplier`);
  if (!currentMultiplier.ok) return currentMultiplier;
  if (currentMultiplier.value.atoms === 0n) {
    return adapterErr(AdapterErrorCode.INVALID_DECIMAL, `${path}.currentMultiplier`, 'multiplier must be positive');
  }
  const rawPending = record['pendingMultiplier'];
  let pending: FixedDecimal | null = null;
  if (rawPending !== '') {
    const parsed = parseFixedDecimal(rawPending, 18, `${path}.pendingMultiplier`);
    if (!parsed.ok) return parsed;
    if (parsed.value.atoms === 0n) return adapterErr(AdapterErrorCode.INVALID_DECIMAL, `${path}.pendingMultiplier`, 'pending multiplier must be positive');
    pending = parsed.value;
  }
  let pendingAt: UnixSeconds | null = null;
  if (pending !== null) {
    const parsed = parseRfc3339Seconds(record['pendingMultiplierEffectiveTime'], `${path}.pendingMultiplierEffectiveTime`);
    if (!parsed.ok) return parsed;
    pendingAt = parsed.value;
  } else if (record['pendingMultiplierEffectiveTime'] !== undefined) {
    return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, `${path}.pendingMultiplierEffectiveTime`, 'effective time exists without a pending multiplier');
  }

  const status = parseStatus(record['status'], `${path}.status`);
  if (!status.ok) return status;
  const capabilities = parseCapabilities(record['tradingCapabilities'], `${path}.tradingCapabilities`);
  if (!capabilities.ok) return capabilities;
  const tokenDecimals = record['tokenDecimals'];
  if (typeof tokenDecimals !== 'number' || !Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 38) {
    return adapterErr(AdapterErrorCode.INVALID_DECIMAL, `${path}.tokenDecimals`, 'invalid token decimals');
  }
  const isin = record['isin'];
  if (typeof isin !== 'string' || !/^[A-Z]{2}[0-9A-Z]{9}[0-9]$/.test(isin)) {
    return adapterErr(AdapterErrorCode.INVALID_IDENTITY, `${path}.isin`, 'missing or malformed authoritative ISIN');
  }

  const observedAt = context.fetchedAtUnixSeconds;
  const ev = <T>(value: T): Evidence<T> => authoritativeHttpEvidence(
    value,
    ROBINHOOD_ASSETS_SOURCE,
    observedAt,
    ObservationClock.HTTP_RETRIEVAL_TIME,
  );
  return adapterOk({
    uid: ev(uid.value),
    tokenSymbol: ev(symbol.value),
    tokenName: ev(name.value),
    deployments: ev(deployments),
    currentMultiplier: ev(currentMultiplier.value),
    pendingMultiplier: ev(pending),
    pendingMultiplierEffectiveAt: ev(pendingAt),
    status: ev(status.value),
    tradingCapabilities: ev(capabilities.value),
    tokenDecimals: ev(tokenDecimals),
    isin: ev(isin),
  });
}

export function parseRobinhoodAssetsResponse(raw: unknown, context: AssetParseContext): AdapterResult<readonly NormalizedRobinhoodAsset[]> {
  const object = objectAt(raw, 'response');
  if (!object.ok) return object;
  const assets = object.value['assets'];
  if (!Array.isArray(assets)) return adapterErr(AdapterErrorCode.MISSING_REQUIRED_FIELD, 'response.assets', 'expected assets array');
  const out: NormalizedRobinhoodAsset[] = [];
  const uids = new Set<string>();
  for (let index = 0; index < assets.length; index += 1) {
    const parsed = parseRobinhoodAsset(assets[index], context, `response.assets[${index}]`);
    if (!parsed.ok) return parsed;
    if (uids.has(parsed.value.uid.value)) return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, 'response.assets', 'duplicate UID');
    uids.add(parsed.value.uid.value);
    out.push(parsed.value);
  }
  return adapterOk(out);
}
