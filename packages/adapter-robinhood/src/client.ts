import type { UnixSeconds } from '@mandate/kernel';
import { ROBINHOOD_MAINNET_CHAIN_ID, parseRobinhoodAssetsResponse, type NormalizedRobinhoodAsset } from './asset.ts';
import { parseCorporateActionsResponse, type NormalizedCorporateAction } from './corporate-action.ts';
import { parseRobinhoodPriceResponse, type NormalizedRobinhoodPrice } from './price.ts';
import { AdapterErrorCode, adapterErr, adapterOk, type AdapterResult } from './result.ts';

export const ROBINHOOD_API_BASE_URL = 'https://api.robinhood.com/rhj';

/**
 * Byte bound on a response body.
 *
 * `await response.json()` buffers whatever arrives, and the request deadline
 * bounds a slow body but not a fast large one, so a broken or hostile endpoint
 * could deliver gigabytes inside the timeout (pressure-test finding F-11). The
 * full asset listing is the largest legitimate response and is comfortably under
 * a megabyte, so 8 MiB is roughly an order of magnitude of headroom and exists
 * to bound allocation rather than to police the issuer's schema.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const ROBINHOOD_MAINNET_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

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

type BoundedBody =
  | { readonly ok: true; readonly oversized: false; readonly value: unknown }
  | { readonly ok: false; readonly oversized: boolean };

/**
 * Read at most `limit` bytes of a response and parse them as JSON.
 *
 * A declared `content-length` past the limit short-circuits, but the
 * incremental count is what enforces the bound: a server may omit or understate
 * the header. Reading stops the moment the limit is passed, so peak allocation
 * is bounded by the limit rather than by what the server chose to send.
 */
export async function readBoundedJson(response: Response, limit: number): Promise<BoundedBody> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    try {
      await response.body?.cancel();
    } catch {
      // Already closed.
    }
    return { ok: false, oversized: true };
  }
  const stream = response.body;
  if (stream === null) {
    try {
      return { ok: true, oversized: false, value: JSON.parse(await response.text()) as unknown };
    } catch {
      return { ok: false, oversized: false };
    }
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) return { ok: false, oversized: true };
      chunks.push(value);
    }
  } catch {
    return { ok: false, oversized: false };
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, oversized: false, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown };
  } catch {
    return { ok: false, oversized: false };
  }
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
    const body = await readBoundedJson(response, MAX_RESPONSE_BYTES);
    if (body.oversized) {
      return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, 'http.body', `response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }
    if (!body.ok) return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, 'http.body', 'response is not valid JSON');
    return adapterOk(body.value);
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
