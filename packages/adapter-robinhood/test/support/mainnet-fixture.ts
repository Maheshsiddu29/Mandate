import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { UnixSeconds } from '@mandate/kernel';
import {
  parseCanonicalIdentityMappingFile,
  parseCorporateActionsResponse,
  parseOnchainTokenObservation,
  parseOracleObservation,
  parseRobinhoodAssetsResponse,
  parseRobinhoodPriceResponse,
  type AdapterResult,
  type CanonicalIdentityMappingFile,
  type NormalizedCorporateAction,
  type NormalizedOnchainToken,
  type NormalizedOraclePrice,
  type NormalizedRobinhoodAsset,
  type NormalizedRobinhoodPrice,
  type RawOnchainTokenObservation,
  type RawOracleObservation,
  type RawMultiplierEventLog,
} from '../../src/index.ts';

export const MAINNET_FIXTURE_ROOT = fileURLToPath(
  new URL('../fixtures/mainnet/2026-09-24/', import.meta.url),
);
export const FIXTURE_FETCHED_AT = 1_790_289_408n as UnixSeconds;
export const FIXTURE_BLOCK_TIMESTAMP = 1_790_289_408n as UnixSeconds;
export const FIXTURE_SYMBOLS = ['AAPL', 'NVDA', 'TSLA', 'QQQ', 'CRWD', 'MSFT'] as const;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(`${MAINNET_FIXTURE_ROOT}${path}`, 'utf8')) as unknown;
}

function object(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${label} is not an object`);
  return raw as Record<string, unknown>;
}

function array(raw: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(raw)) throw new Error(`${label} is not an array`);
  return raw;
}

function resultById(raw: unknown, label: string): Map<number, unknown> {
  const rows = array(raw, label);
  const results = new Map<number, unknown>();
  for (const item of rows) {
    const row = object(item, `${label} row`);
    if (typeof row['id'] !== 'number' || !Number.isSafeInteger(row['id']) || !('result' in row)) {
      throw new Error(`${label} row is not a successful JSON-RPC response`);
    }
    results.set(row['id'], row['result']);
  }
  return results;
}

export function expectAdapter<T>(result: AdapterResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.error.code} at ${result.error.path}: ${result.error.message}`);
  return result.value;
}

export function loadMainnetAssets(): readonly NormalizedRobinhoodAsset[] {
  return expectAdapter(
    parseRobinhoodAssetsResponse(readJson('raw/assets.json'), { fetchedAtUnixSeconds: 1_790_289_377n as UnixSeconds }),
    'assets fixture',
  );
}

export function loadMainnetPrice(symbol: typeof FIXTURE_SYMBOLS[number]): NormalizedRobinhoodPrice {
  return expectAdapter(
    parseRobinhoodPriceResponse(readJson(`raw/price-${symbol}.json`), { fetchedAtUnixSeconds: FIXTURE_FETCHED_AT }),
    `${symbol} price fixture`,
  );
}

export function loadMainnetCorporateActions(): readonly NormalizedCorporateAction[] {
  return expectAdapter(
    parseCorporateActionsResponse(readJson('raw/corporate-actions.json'), 1_790_289_378n as UnixSeconds),
    'corporate-actions fixture',
  );
}

export function loadCanonicalMappings(): CanonicalIdentityMappingFile {
  return expectAdapter(
    parseCanonicalIdentityMappingFile(readJson('canonical-mapping.json')),
    'canonical mapping fixture',
  );
}

export function loadOnchainToken(symbol: typeof FIXTURE_SYMBOLS[number]): NormalizedOnchainToken {
  const requestMap = object(readJson('raw/rpc-request-map.json'), 'RPC request map');
  const symbols = array(requestMap['symbols'], 'RPC request map symbols');
  const symbolIndex = symbols.indexOf(symbol);
  if (symbolIndex < 0) throw new Error(`no onchain fixture for ${symbol}`);
  const assets = loadMainnetAssets();
  const asset = assets.find((candidate) => candidate.tokenSymbol.value === symbol);
  if (asset === undefined) throw new Error(`no asset fixture for ${symbol}`);
  const deployment = asset.deployments.value.find((candidate) => candidate.chainId === 4663n);
  if (deployment === undefined) throw new Error(`no mainnet deployment for ${symbol}`);

  const chain = object(readJson('raw/rpc-chain-id.json'), 'chain ID response');
  const blockResponse = object(readJson('raw/rpc-latest-block.json'), 'block response');
  const block = object(blockResponse['result'], 'block result');
  const contractResults = resultById(readJson('raw/rpc-contracts.json'), 'contract batch');
  const stateResults = resultById(readJson('raw/rpc-state.json'), 'state batch');
  const contractBase = symbolIndex * 6;
  const stateBase = symbolIndex * 3;
  const observation: RawOnchainTokenObservation = {
    chainId: chain['result'],
    blockNumber: block['number'],
    blockTimestamp: block['timestamp'],
    contractAddress: deployment.contractAddress,
    code: contractResults.get(contractBase + 1),
    symbolResult: contractResults.get(contractBase + 2),
    nameResult: contractResults.get(contractBase + 3),
    decimalsResult: contractResults.get(contractBase + 4),
    uiMultiplierResult: contractResults.get(contractBase + 5),
    uidResult: contractResults.get(contractBase + 6),
    newUIMultiplierResult: stateResults.get(stateBase + 1),
    effectiveAtResult: stateResults.get(stateBase + 2),
    oraclePausedResult: stateResults.get(stateBase + 3),
  };
  return expectAdapter(parseOnchainTokenObservation(observation), `${symbol} onchain fixture`);
}

export function loadMultiplierEventLogs(): readonly RawMultiplierEventLog[] {
  const response = object(readJson('raw/rpc-multiplier-events.json'), 'multiplier event response');
  return array(response['result'], 'multiplier event result') as readonly RawMultiplierEventLog[];
}

export function loadOraclePrice(symbol: 'AAPL' | 'NVDA' | 'TSLA' | 'QQQ' | 'MSFT'): NormalizedOraclePrice {
  const oracleMap = object(readJson('raw/rpc-oracle-map.json'), 'oracle map');
  const symbols = array(oracleMap['symbols'], 'oracle symbols');
  const symbolIndex = symbols.indexOf(symbol);
  if (symbolIndex < 0) throw new Error(`no oracle fixture for ${symbol}`);
  const requests = array(readJson('raw/rpc-oracle-requests.json'), 'oracle requests');
  const codeRequest = object(requests[symbolIndex * 3], 'oracle code request');
  const params = array(codeRequest['params'], 'oracle code request params');
  const chain = object(readJson('raw/rpc-chain-id.json'), 'chain ID response');
  const blockResponse = object(readJson('raw/rpc-latest-block.json'), 'block response');
  const block = object(blockResponse['result'], 'block result');
  const results = resultById(readJson('raw/rpc-oracles.json'), 'oracle batch');
  const base = symbolIndex * 3;
  const observation: RawOracleObservation = {
    chainId: chain['result'], blockNumber: block['number'], blockTimestamp: block['timestamp'], feedAddress: params[0],
    code: results.get(base + 1), decimalsResult: results.get(base + 2), latestRoundDataResult: results.get(base + 3),
  };
  return expectAdapter(parseOracleObservation(observation), `${symbol} oracle fixture`);
}
