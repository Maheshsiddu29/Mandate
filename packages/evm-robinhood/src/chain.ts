/**
 * Robinhood Chain testnet JSON-RPC access (Phase 7E.3) — the only module in
 * this package that performs network I/O.
 *
 * It refuses every host but Robinhood Chain's documented public testnet RPC
 * (and, when explicitly enabled, a loopback node for a local dry run, or an
 * operator-configured QuickNode endpoint — infrastructure, never authority),
 * and it
 * refuses to act on any chain but the one it was configured for — never
 * Ethereum, Arbitrum One, Arbitrum Nova or Robinhood Chain mainnet, whatever
 * the endpoint answers.
 *
 * Nothing here decides anything. Reads return typed values or a reason; a
 * submission returns the transaction hash it broadcast or why it could not.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { addressAt, bytes32At, calldata, hexBytes, toHex, wordAt, address as abiAddress, bytes32 as abiBytes32 } from './abi.ts';
import { TxSender, type Eip1559Tx } from './transaction.ts';
import type { Address, GateMarketSnapshot } from './vocabulary.ts';

export const ROBINHOOD_TESTNET_CHAIN_ID = 46630n;
/** Robinhood Chain's documented public testnet RPC (docs.robinhood.com/chain/connecting). */
export const TESTNET_RPC_HOSTS = ['rpc.testnet.chain.robinhood.com'] as const;
/** Mainnets this phase never acts on: Ethereum, Arbitrum One, Arbitrum Nova, Robinhood Chain. */
export const REFUSED_CHAIN_IDS = [1n, 42_161n, 42_170n, 4_663n] as const;

export class RpcHostRefused extends Error {}

export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const fail = (error: string): Read<never> => ({ ok: false, error });

export interface RpcOptions {
  /** Permit `http://127.0.0.1:<port>` / `http://localhost:<port>` — a local dry-run node only. */
  readonly allowLoopback?: boolean;
  /**
   * Permit an operator-configured QuickNode endpoint: `https://<name>.quiknode.pro/<token>/`. The
   * token travels in the path, so the URL is a credential: it is kept private here and never
   * reported. It changes only which node answers — `ChainClient` still verifies the chain id on
   * first use and refuses every mainnet, whatever the endpoint says.
   */
  readonly operatorEndpoint?: 'QUICKNODE';
}

/** Which kind of endpoint a client talks to: safe to report, unlike the URL. */
export type RpcEndpointKind = 'ROBINHOOD_PUBLIC_TESTNET' | 'QUICKNODE' | 'LOOPBACK';

/** A QuickNode endpoint host: `*.quiknode.pro`, never the bare domain. */
export function isQuickNodeHost(hostname: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.quiknode\.pro$/.test(hostname);
}

export class JsonRpcClient {
  /** Kept private: an operator endpoint's URL carries its credential. */
  readonly #url: string;
  readonly endpoint: RpcEndpointKind;
  #id = 0;

  constructor(url: string, o: RpcOptions = {}) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new RpcHostRefused(`not a URL: ${url}`);
    }
    const loopback = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && o.allowLoopback === true;
    const testnet = u.protocol === 'https:' && (TESTNET_RPC_HOSTS as readonly string[]).includes(u.hostname) && u.pathname === '/' && u.search === '';
    const quicknode = o.operatorEndpoint === 'QUICKNODE' && u.protocol === 'https:' && isQuickNodeHost(u.hostname) && u.username === '' && u.password === '' && u.search === '' && u.hash === '' && u.port === '';
    // The refusal names the host only: a QuickNode path carries the credential.
    if (!loopback && !testnet && !quicknode) throw new RpcHostRefused(`RPC host refused: ${u.protocol}//${u.hostname}`);
    this.#url = u.toString();
    this.endpoint = testnet ? 'ROBINHOOD_PUBLIC_TESTNET' : quicknode ? 'QUICKNODE' : 'LOOPBACK';
  }

  async request<T>(method: string, params: readonly (string | boolean | object)[]): Promise<Read<T>> {
    this.#id += 1;
    let res: Response;
    try {
      res = await fetch(this.#url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: this.#id, method, params }), signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      return fail(`NETWORK.${e instanceof Error ? e.name : 'Error'}`);
    }
    if (!res.ok) return fail(`HTTP_${res.status}`);
    let body: { result?: T; error?: { code?: number; message?: string; data?: string } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return fail('NOT_JSON');
    }
    if (body.error !== undefined) return fail(`RPC_${body.error.code ?? 'ERROR'}${typeof body.error.data === 'string' ? `:${body.error.data}` : ''}:${body.error.message ?? ''}`);
    if (body.result === undefined) return fail('NO_RESULT');
    return { ok: true, value: body.result };
  }
}

export interface BlockRef {
  readonly number: bigint;
  readonly hash: string;
  readonly timestamp: bigint;
}

export interface Receipt {
  readonly status: 'SUCCESS' | 'REVERTED';
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly contractAddress: Address | null;
  readonly logs: number;
}

export type Submission = { readonly kind: 'SENT'; readonly txHash: string } | { readonly kind: 'UNKNOWN'; readonly error: string };

export type Simulation = { readonly ok: true; readonly returnData: string } | { readonly ok: false; readonly revert: string };

const hexQ = (n: bigint) => `0x${n.toString(16)}`;
const big = (h: string) => BigInt(h);

function revertDataOf(error: string): string {
  const m = /^RPC_[-\d]+:(0x[0-9a-fA-F]*):/.exec(error);
  return m === null ? error : (m[1] as string).toLowerCase();
}

/**
 * Typed reads and writes against one chain. Every method first establishes
 * that the endpoint serves the configured chain.
 */
export class ChainClient {
  readonly rpc: JsonRpcClient;
  readonly chainId: bigint;
  #verified = false;

  constructor(rpc: JsonRpcClient, chainId: bigint) {
    if ((REFUSED_CHAIN_IDS as readonly bigint[]).includes(chainId)) throw new RpcHostRefused(`chain ${chainId} is a refused mainnet`);
    this.rpc = rpc;
    this.chainId = chainId;
  }

  async ensureChain(): Promise<Read<true>> {
    if (this.#verified) return { ok: true, value: true };
    const id = await this.rpc.request<string>('eth_chainId', []);
    if (!id.ok) return id;
    const served = big(id.value);
    if ((REFUSED_CHAIN_IDS as readonly bigint[]).includes(served)) return fail(`MAINNET_REFUSED_${served}`);
    if (served !== this.chainId) return fail(`WRONG_CHAIN_${served}`);
    this.#verified = true;
    return { ok: true, value: true };
  }

  async #req<T>(method: string, params: readonly (string | boolean | object)[]): Promise<Read<T>> {
    const c = await this.ensureChain();
    if (!c.ok) return c;
    return this.rpc.request<T>(method, params);
  }

  async block(tag: 'latest' | 'safe' | 'finalized' | bigint): Promise<Read<BlockRef>> {
    const b = await this.#req<{ number: string; hash: string; timestamp: string } | null>('eth_getBlockByNumber', [typeof tag === 'bigint' ? hexQ(tag) : tag, false]);
    if (!b.ok) return b;
    if (b.value === null) return fail('BLOCK_NOT_FOUND');
    return { ok: true, value: { number: big(b.value.number), hash: b.value.hash, timestamp: big(b.value.timestamp) } };
  }

  async call(to: Address, data: string, block: bigint | 'latest' = 'latest', from?: Address): Promise<Simulation> {
    const r = await this.#req<string>('eth_call', [{ to, data, ...(from === undefined ? {} : { from }) }, typeof block === 'bigint' ? hexQ(block) : block]);
    return r.ok ? { ok: true, returnData: r.value } : { ok: false, revert: revertDataOf(r.error) };
  }

  async #word(to: Address, data: string, block: bigint | 'latest'): Promise<Read<string>> {
    const r = await this.call(to, data, block);
    if (!r.ok) return fail(`CALL_REVERTED.${r.revert}`);
    if (r.returnData.length < 66) return fail('RETURN_TOO_SHORT');
    return { ok: true, value: r.returnData };
  }

  async code(address: Address, block: bigint | 'latest' = 'latest'): Promise<Read<string>> {
    return this.#req<string>('eth_getCode', [address, typeof block === 'bigint' ? hexQ(block) : block]);
  }

  async codehash(address: Address, block: bigint | 'latest' = 'latest'): Promise<Read<string>> {
    const c = await this.code(address, block);
    if (!c.ok) return c;
    if (c.value === '0x') return fail('NO_CODE');
    return { ok: true, value: toHex(keccak_256(hexBytes(c.value.toLowerCase()))) };
  }

  async balance(address: Address): Promise<Read<bigint>> {
    const b = await this.#req<string>('eth_getBalance', [address, 'latest']);
    return b.ok ? { ok: true, value: big(b.value) } : b;
  }

  async erc20Balance(token: Address, owner: Address, block: bigint | 'latest' = 'latest'): Promise<Read<bigint>> {
    const r = await this.#word(token, calldata('balanceOf(address)', [abiAddress], [owner]), block);
    return r.ok ? { ok: true, value: wordAt(r.value, 0) } : r;
  }

  async erc20Allowance(token: Address, owner: Address, spender: Address, block: bigint | 'latest' = 'latest'): Promise<Read<bigint>> {
    const r = await this.#word(token, calldata('allowance(address,address)', [abiAddress, abiAddress], [owner, spender]), block);
    return r.ok ? { ok: true, value: wordAt(r.value, 0) } : r;
  }

  async domainSeparator(gate: Address, block: bigint | 'latest' = 'latest'): Promise<Read<string>> {
    const r = await this.#word(gate, calldata('domainSeparator()', [], []), block);
    return r.ok ? { ok: true, value: bytes32At(r.value, 0) } : r;
  }

  async executionCommitmentOf(gate: Address, mandateDigest: string, block: bigint | 'latest' = 'latest'): Promise<Read<string>> {
    const r = await this.#word(gate, calldata('executionCommitmentOf(bytes32)', [abiBytes32], [mandateDigest]), block);
    return r.ok ? { ok: true, value: bytes32At(r.value, 0) } : r;
  }

  /** The gate's market-table entry, its created venue and that venue's fee, all at `block`. */
  async gateMarket(gate: Address, representationId: string, block: bigint): Promise<Read<GateMarketSnapshot>> {
    const key = toHex(keccak_256(new TextEncoder().encode(representationId)));
    const m = await this.#word(gate, calldata('marketOf(bytes32)', [abiBytes32], [key]), block);
    if (!m.ok) return m;
    const v = await this.#word(gate, calldata('fixtureVenueOf(bytes32)', [abiBytes32], [key]), block);
    if (!v.ok) return v;
    const venue = addressAt(v.value, 0);
    const representation = addressAt(m.value, 0);
    if (representation === '0x0000000000000000000000000000000000000000') return fail('MARKET_NOT_LISTED');
    const fee = await this.#word(venue, calldata('FEE_BPS()', [], []), block);
    if (!fee.ok) return fee;
    const small = (i: number) => Number(wordAt(m.value, i));
    return {
      ok: true,
      value: {
        chainId: this.chainId,
        gate,
        representation,
        fundingToken: addressAt(m.value, 1),
        adapter: addressAt(m.value, 2),
        venue,
        representationDecimals: small(3),
        fundingDecimals: small(4),
        synthetic: wordAt(m.value, 5) === 1n,
        classification: small(6),
        canonicalAssetHash: bytes32At(m.value, 7),
        issuerHash: bytes32At(m.value, 8),
        venueHash: bytes32At(m.value, 9),
        quantityUnitHash: bytes32At(m.value, 10),
        settlementUnitHash: bytes32At(m.value, 11),
        fixturePriceDecimals: small(12),
        fixturePriceAtoms: wordAt(m.value, 13),
        feeBps: Number(wordAt(fee.value, 0)),
      },
    };
  }

  async nonce(address: Address): Promise<Read<bigint>> {
    const n = await this.#req<string>('eth_getTransactionCount', [address, 'pending']);
    return n.ok ? { ok: true, value: big(n.value) } : n;
  }

  async estimateGas(from: Address, to: Address | null, data: string): Promise<Read<bigint>> {
    const g = await this.#req<string>('eth_estimateGas', [{ from, ...(to === null ? {} : { to }), data }]);
    return g.ok ? { ok: true, value: big(g.value) } : g;
  }

  /**
   * Sign and broadcast one transaction from `sender`. `gasLimit` is estimated
   * (with 30% headroom) unless given — giving it lets a transaction that will
   * revert be mined anyway, which is how a refusal is put on chain as evidence.
   */
  async send(sender: TxSender, to: Address | null, data: string, o: { readonly gasLimit?: bigint; readonly value?: bigint } = {}): Promise<Submission> {
    const nonce = await this.nonce(sender.address);
    if (!nonce.ok) return { kind: 'UNKNOWN', error: `NONCE.${nonce.error}` };
    const latest = await this.#req<{ baseFeePerGas?: string } | null>('eth_getBlockByNumber', ['latest', false]);
    if (!latest.ok || latest.value === null || latest.value.baseFeePerGas === undefined) return { kind: 'UNKNOWN', error: 'BASE_FEE_UNREADABLE' };
    let gasLimit = o.gasLimit;
    if (gasLimit === undefined) {
      const est = await this.estimateGas(sender.address, to, data);
      if (!est.ok) return { kind: 'UNKNOWN', error: `ESTIMATE.${est.error}` };
      gasLimit = (est.value * 13n) / 10n;
    }
    const baseFee = big(latest.value.baseFeePerGas);
    const tx: Eip1559Tx = { chainId: this.chainId, nonce: nonce.value, maxPriorityFeePerGas: 0n, maxFeePerGas: baseFee * 2n + 1n, gasLimit, to, value: o.value ?? 0n, data };
    const signed = sender.signTransaction(tx);
    const sent = await this.#req<string>('eth_sendRawTransaction', [signed.raw]);
    if (!sent.ok) return { kind: 'UNKNOWN', error: sent.error };
    if (sent.value.toLowerCase() !== signed.hash) return { kind: 'UNKNOWN', error: 'TX_HASH_MISMATCH' };
    return { kind: 'SENT', txHash: signed.hash };
  }

  async receipt(txHash: string, timeoutMs = 120_000): Promise<Read<Receipt>> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.#req<{ status: string; blockNumber: string; blockHash: string; gasUsed: string; effectiveGasPrice?: string; contractAddress: string | null; logs: readonly object[] } | null>('eth_getTransactionReceipt', [txHash]);
      if (r.ok && r.value !== null) {
        const v = r.value;
        return {
          ok: true,
          value: { status: v.status === '0x1' ? 'SUCCESS' : 'REVERTED', blockNumber: big(v.blockNumber), blockHash: v.blockHash, gasUsed: big(v.gasUsed), effectiveGasPrice: big(v.effectiveGasPrice ?? '0x0'), contractAddress: v.contractAddress === null ? null : v.contractAddress.toLowerCase(), logs: v.logs.length },
        };
      }
      if (Date.now() > until) return fail(r.ok ? 'RECEIPT_TIMEOUT' : `RECEIPT.${r.error}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

