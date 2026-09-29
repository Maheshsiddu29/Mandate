/**
 * The Venue Signer's view of Lighter's API (Phase 7E.1).
 *
 * `VenueClient` is the narrow set of calls the signer makes: read the
 * registered API keys and the next nonce (pre-execution evidence), and submit
 * one signed transaction. `HttpVenueClient` is its only network implementation
 * and **refuses any host but Lighter's testnet** — this phase contacts no
 * mainnet endpoint, and a misconfigured URL cannot change that.
 *
 * Submission outcomes are reported exactly as observed and nothing more:
 * `ACK` means the API accepted the syntax (`code = 200`), never that the order
 * executed (venue-evidence.md L-TX-8); `REJECTED` is an API error; `UNKNOWN`
 * is a timeout, a connection failure or an unreadable reply — the outcome of
 * the artifact is then not known, and it stays quarantined.
 */

export type VenueRead<T> = { readonly ok: true; readonly value: T; readonly raw: string } | { readonly ok: false; readonly error: string };

export interface RegisteredKey {
  readonly apiKeyIndex: number;
  /** Hex public key; all zeros when revoked. */
  readonly publicKey: string;
}

export type Submission =
  | { readonly kind: 'ACK'; readonly txHash: string; readonly raw: string }
  | { readonly kind: 'REJECTED'; readonly code: number; readonly message: string; readonly raw: string }
  | { readonly kind: 'UNKNOWN'; readonly error: string };

export interface VenueClient {
  apiKeys(accountIndex: bigint): Promise<VenueRead<readonly RegisteredKey[]>>;
  nextNonce(accountIndex: bigint, apiKeyIndex: number): Promise<VenueRead<bigint>>;
  sendTx(txType: number, txInfo: string): Promise<Submission>;
}

/** The only hosts this phase may contact. */
export const TESTNET_HOSTS: readonly string[] = ['testnet.zklighter.elliot.ai'];

export class VenueHostRefused extends Error {
  constructor(host: string) {
    super(`refusing Lighter host ${host}: Phase 7E.1 contacts testnet only`);
    this.name = 'VenueHostRefused';
  }
}

interface KeysReply {
  readonly code?: number;
  readonly api_keys?: readonly { readonly api_key_index?: number; readonly public_key?: string }[];
}

interface NonceReply {
  readonly code?: number;
  readonly nonce?: number;
}

interface SendReply {
  readonly code?: number;
  readonly message?: string;
  readonly tx_hash?: string;
}

export class HttpVenueClient implements VenueClient {
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 10_000) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || !TESTNET_HOSTS.includes(url.hostname)) throw new VenueHostRefused(url.hostname);
    this.#base = `${url.origin}/api/v1`;
    this.#timeoutMs = timeoutMs;
  }

  async #get(path: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    try {
      const res = await fetch(`${this.#base}${path}`, { signal: AbortSignal.timeout(this.#timeoutMs) });
      return { ok: true, text: await res.text() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.name : 'FETCH_FAILED' };
    }
  }

  async apiKeys(accountIndex: bigint): Promise<VenueRead<readonly RegisteredKey[]>> {
    const r = await this.#get(`/apikeys?account_index=${accountIndex}&api_key_index=255`);
    if (!r.ok) return r;
    try {
      const body = JSON.parse(r.text) as KeysReply;
      if (body.code !== 200 || !Array.isArray(body.api_keys)) return { ok: false, error: `APIKEYS_CODE_${String(body.code)}` };
      const keys = body.api_keys.map((k) => ({ apiKeyIndex: k.api_key_index ?? -1, publicKey: k.public_key ?? '' }));
      return { ok: true, value: keys, raw: r.text };
    } catch {
      return { ok: false, error: 'APIKEYS_REPLY_MALFORMED' };
    }
  }

  async nextNonce(accountIndex: bigint, apiKeyIndex: number): Promise<VenueRead<bigint>> {
    const r = await this.#get(`/nextNonce?account_index=${accountIndex}&api_key_index=${apiKeyIndex}`);
    if (!r.ok) return r;
    try {
      const body = JSON.parse(r.text) as NonceReply;
      if (body.code !== 200 || typeof body.nonce !== 'number' || !Number.isSafeInteger(body.nonce)) return { ok: false, error: `NONCE_CODE_${String(body.code)}` };
      return { ok: true, value: BigInt(body.nonce), raw: r.text };
    } catch {
      return { ok: false, error: 'NONCE_REPLY_MALFORMED' };
    }
  }

  async sendTx(txType: number, txInfo: string): Promise<Submission> {
    const form = new FormData();
    form.set('tx_type', String(txType));
    form.set('tx_info', txInfo);
    let text: string;
    try {
      const res = await fetch(`${this.#base}/sendTx`, { method: 'POST', body: form, signal: AbortSignal.timeout(this.#timeoutMs) });
      text = await res.text();
    } catch (e) {
      return { kind: 'UNKNOWN', error: e instanceof Error ? e.name : 'FETCH_FAILED' };
    }
    try {
      const body = JSON.parse(text) as SendReply;
      if (body.code === 200 && typeof body.tx_hash === 'string') return { kind: 'ACK', txHash: body.tx_hash, raw: text };
      if (typeof body.code === 'number') return { kind: 'REJECTED', code: body.code, message: body.message ?? '', raw: text };
      return { kind: 'UNKNOWN', error: 'SEND_REPLY_UNRECOGNIZED' };
    } catch {
      return { kind: 'UNKNOWN', error: 'SEND_REPLY_MALFORMED' };
    }
  }
}

// --- Live state reads (Phase 7E.2) ----------------------------------------------------------

/** One raw read: exactly what came back, or why nothing did. `endpoint` never carries the auth token. */
export type RawRead =
  | { readonly ok: true; readonly endpoint: string; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly endpoint: string; readonly error: string };

/** The state adapter's reads: account, market metadata with marks, and one market's active orders. */
export interface StateClient {
  account(accountIndex: bigint): Promise<RawRead>;
  orderBookDetails(): Promise<RawRead>;
  /** `token` is a read-only auth token; it travels in the `Authorization` header, never the URL. */
  activeOrders(accountIndex: bigint, marketIndex: number, token: string): Promise<RawRead>;
}

export class HttpStateClient implements StateClient {
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 10_000) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || !TESTNET_HOSTS.includes(url.hostname)) throw new VenueHostRefused(url.hostname);
    this.#base = `${url.origin}/api/v1`;
    this.#timeoutMs = timeoutMs;
  }

  async #get(endpoint: string, token: string | null): Promise<RawRead> {
    try {
      const res = await fetch(`${this.#base}${endpoint}`, { headers: token === null ? {} : { Authorization: token }, signal: AbortSignal.timeout(this.#timeoutMs) });
      return { ok: true, endpoint, status: res.status, body: await res.text() };
    } catch (e) {
      return { ok: false, endpoint, error: e instanceof Error ? e.name : 'FETCH_FAILED' };
    }
  }

  account(accountIndex: bigint): Promise<RawRead> {
    return this.#get(`/account?by=index&value=${accountIndex}`, null);
  }

  orderBookDetails(): Promise<RawRead> {
    return this.#get('/orderBookDetails', null);
  }

  activeOrders(accountIndex: bigint, marketIndex: number, token: string): Promise<RawRead> {
    return this.#get(`/accountActiveOrders?account_index=${accountIndex}&market_id=${marketIndex}`, token);
  }
}
