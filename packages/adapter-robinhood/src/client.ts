import type { UnixSeconds } from '@mandate/kernel';
import { ROBINHOOD_MAINNET_CHAIN_ID, parseRobinhoodAssetsResponse, type NormalizedRobinhoodAsset } from './asset.ts';
import { parseCorporateActionsResponse, type NormalizedCorporateAction } from './corporate-action.ts';
import { parseRobinhoodPriceResponse, type NormalizedRobinhoodPrice } from './price.ts';
import { AdapterErrorCode, adapterErr, adapterOk, type AdapterResult } from './result.ts';

export const ROBINHOOD_API_BASE_URL = 'https://api.robinhood.com/stock-tokens';
export const ROBINHOOD_MAINNET_RPC_URL = 'https://rpc.robinhoodchain.com';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMilliseconds?: number;
  readonly nowUnixSeconds?: () => UnixSeconds;
  readonly apiBaseUrl?: string;
  readonly rpcUrl?: string;
}

function defaultNow(): UnixSeconds {
  return BigInt(Math.floor(Date.now() / 1_000)) as UnixSeconds;
}

export async function fetchJson(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMilliseconds: number,
  notFoundIsAsset = false,
): Promise<AdapterResult<unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (response.status === 429) return adapterErr(AdapterErrorCode.RATE_LIMITED, 'http', 'remote service rate limited the request');
    if (response.status === 404 && notFoundIsAsset) return adapterErr(AdapterErrorCode.ASSET_NOT_FOUND, 'http', 'asset endpoint returned 404');
    if (!response.ok) return adapterErr(AdapterErrorCode.HTTP_ERROR, 'http', `remote service returned HTTP ${response.status}`);
    try {
      return adapterOk(await response.json() as unknown);
    } catch {
      return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, 'http.body', 'response is not valid JSON');
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
      return adapterErr(AdapterErrorCode.TIMEOUT, 'http', 'request timed out');
    }
    return adapterErr(AdapterErrorCode.HTTP_ERROR, 'http', 'network request failed');
  } finally {
    clearTimeout(timeout);
  }
}

export class RobinhoodClient {
  readonly #fetch: FetchLike;
  readonly #timeoutMilliseconds: number;
  readonly #now: () => UnixSeconds;
  readonly #apiBaseUrl: string;
  readonly #rpcUrl: string;

  constructor(options: ClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
    this.#now = options.nowUnixSeconds ?? defaultNow;
    this.#apiBaseUrl = options.apiBaseUrl ?? ROBINHOOD_API_BASE_URL;
    this.#rpcUrl = options.rpcUrl ?? ROBINHOOD_MAINNET_RPC_URL;
  }

  async assets(): Promise<AdapterResult<readonly NormalizedRobinhoodAsset[]>> {
    const response = await fetchJson(this.#fetch, `${this.#apiBaseUrl}/assets`, { method: 'GET' }, this.#timeoutMilliseconds);
    if (!response.ok) return response;
    return parseRobinhoodAssetsResponse(response.value, { fetchedAtUnixSeconds: this.#now() });
  }

  async price(symbol: string): Promise<AdapterResult<NormalizedRobinhoodPrice>> {
    if (!/^[A-Z0-9.\-]{1,16}$/.test(symbol)) return adapterErr(AdapterErrorCode.INVALID_IDENTITY, 'symbol', 'invalid Stock Token symbol');
    const response = await fetchJson(
      this.#fetch, `${this.#apiBaseUrl}/prices/${encodeURIComponent(symbol)}`, { method: 'GET' }, this.#timeoutMilliseconds, true,
    );
    if (!response.ok) return response;
    return parseRobinhoodPriceResponse(response.value, { fetchedAtUnixSeconds: this.#now() });
  }

  async corporateActions(): Promise<AdapterResult<readonly NormalizedCorporateAction[]>> {
    const response = await fetchJson(this.#fetch, `${this.#apiBaseUrl}/corporate-actions`, { method: 'GET' }, this.#timeoutMilliseconds);
    if (!response.ok) return response;
    return parseCorporateActionsResponse(response.value, this.#now());
  }

  async rpc(method: string, params: readonly unknown[]): Promise<AdapterResult<unknown>> {
    const response = await fetchJson(this.#fetch, this.#rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }, this.#timeoutMilliseconds);
    if (!response.ok) return response;
    if (typeof response.value !== 'object' || response.value === null || Array.isArray(response.value)) {
      return adapterErr(AdapterErrorCode.RPC_ERROR, 'rpc', 'JSON-RPC response is not an object');
    }
    const record = response.value as Record<string, unknown>;
    if (record['jsonrpc'] !== '2.0' || record['id'] !== 1 || 'error' in record || !('result' in record)) {
      return adapterErr(AdapterErrorCode.RPC_ERROR, 'rpc', 'JSON-RPC response is partial or contains an error');
    }
    return adapterOk(record['result']);
  }

  async assertMainnetChain(): Promise<AdapterResult<bigint>> {
    const result = await this.rpc('eth_chainId', []);
    if (!result.ok) return result;
    if (typeof result.value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(result.value)) {
      return adapterErr(AdapterErrorCode.RPC_ERROR, 'rpc.chainId', 'invalid chain ID response');
    }
    const chainId = BigInt(result.value);
    if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
      return adapterErr(AdapterErrorCode.CHAIN_MISMATCH, 'rpc.chainId', `expected ${ROBINHOOD_MAINNET_CHAIN_ID}, received ${chainId}`);
    }
    return adapterOk(chainId);
  }
}
