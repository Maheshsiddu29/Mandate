/**
 * Robinhood Chain testnet access for the settlement path — the only module
 * in the Live AI Lab that holds an RPC client or a transaction-signing key.
 *
 * It is built on the Phase 7E.3 `ChainClient` (which refuses every host but
 * the documented public testnet RPC — or, when the operator configured one,
 * a QuickNode endpoint — and every chain but the one configured) and
 * `TxSender` (which signs typed transactions for one fixed chain, never
 * arbitrary bytes). The sender is the 7E.3 gas payer: it holds no authority,
 * because the gate accepts `execute` from anyone and moves funds only for a
 * principal-signed mandate.
 *
 * Capabilities are split (B.5.3, docs/demo/wallet-settlement-boundaries.md §6):
 *
 * - `ChainReader` — bounded reads: chain id, blocks, code, balances, the
 *   gate's commitment and markets, `eth_call` / `estimateGas` of the gate's
 *   `execute`, one-shot transaction and receipt lookups, the sender's nonce.
 *   Reads may fall back from the primary endpoint to the public RPC on a
 *   *transport* failure only, and each endpoint proves its chain id before
 *   it is trusted: a fallback can never cross from testnet to anything else.
 * - `TransactionBroadcaster` — `broadcastExactSignedTransaction`: one
 *   already-signed gate `execute`, sent once to the primary endpoint. A send
 *   never fails over.
 *
 * Provider choice is infrastructure. It never decides what is authorized:
 * that was settled by Mandate before any of this is asked. Endpoint URLs —
 * a QuickNode URL carries its credential — never leave this module; only a
 * provenance label (`quicknode`, `public`, `public-fallback`) does.
 *
 * Submission is split so that nothing is ever sent twice: `prepareExecute`
 * signs and returns the transaction and its hash without sending;
 * `broadcast` sends that one signed transaction once; when a broadcast's
 * answer is ambiguous, `transactionKnown` asks the chain about that same
 * hash. There is no resend.
 */

import { ChainClient, JsonRpcClient, TxSender, readGateMarkets, type Address, type BlockRef, type GateCall, type GateSpotPolicy, type GateStateRead, type Read, type Receipt, type Simulation } from '@mandate/evm-robinhood';
import { ROBINHOOD_TESTNET } from './deployment.ts';
import type { Transport } from './evidence.ts';

export interface PreparedTx {
  readonly hash: string;
  /** The signed transaction. Public once broadcast, but never logged, emitted or persisted. */
  readonly raw: string;
  /** The gate call it carries. */
  readonly call: GateCall;
  readonly from: Address;
  readonly to: Address;
  readonly nonce: bigint;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
}

export type BroadcastResult = { readonly kind: 'ACCEPTED'; readonly hash: string } | { readonly kind: 'ERROR'; readonly error: string };

/** Which endpoint answered: a label, never a URL. */
export type RpcProvenance = 'quicknode' | 'public' | 'public-fallback' | 'mock';

/** A one-shot transaction lookup: whether the node knows it, and where it was mined if it was. */
export interface TxLookup {
  readonly blockNumber: bigint | null;
  readonly from: Address;
  readonly nonce: bigint;
}

/** Bounded reads. Nothing here can authorize: Mandate decided before any of these is asked. */
export interface ChainReader {
  readonly transport: Transport;
  /** The endpoint that answered the most recent read. */
  provenance(): RpcProvenance;
  /** A fresh `eth_chainId`, never cached. */
  chainId(): Promise<Read<bigint>>;
  latest(): Promise<Read<BlockRef>>;
  codehash(address: Address): Promise<Read<string>>;
  domainSeparator(gate: Address): Promise<Read<string>>;
  nativeBalance(address: Address): Promise<Read<bigint>>;
  tokenBalance(token: Address, owner: Address, block?: bigint): Promise<Read<bigint>>;
  allowance(token: Address, owner: Address, spender: Address): Promise<Read<bigint>>;
  executionCommitmentOf(gate: Address, mandateDigest: string, block?: bigint): Promise<Read<string>>;
  gateMarkets(policy: GateSpotPolicy): Promise<GateStateRead>;
  /** `eth_call` of `execute(call)` on the gate. */
  simulateExecute(gate: Address, call: GateCall): Promise<Simulation>;
  /** `eth_estimateGas` of `execute(call)` on the gate. */
  estimateExecute(gate: Address, call: GateCall): Promise<Read<bigint>>;
  transactionKnown(hash: string): Promise<Read<boolean>>;
  /** One lookup, no waiting: `null` when the node does not know the hash. */
  transaction(hash: string): Promise<Read<TxLookup | null>>;
  /** One lookup, no waiting: `null` when there is no receipt yet. */
  receiptOnce(hash: string): Promise<Read<Receipt | null>>;
  /** The account's transaction count at `tag`: `latest` counts mined transactions, `pending` adds the node's pool. */
  nonceAt(address: Address, tag: 'latest' | 'pending'): Promise<Read<bigint>>;
}

/** The one write: an already-signed gate `execute`, exactly as signed, once. */
export interface TransactionBroadcaster {
  broadcast(tx: PreparedTx): Promise<BroadcastResult>;
}

/** What the settlement path needs from a chain. `RobinhoodTestnetRpc` is the only network implementation. */
export interface TestnetRpc extends ChainReader, TransactionBroadcaster {
  /** The gas payer's public address. */
  readonly submitter: Address;
  /** Sign `execute(call)` to the gate from the submitter; nothing is sent. */
  prepareExecute(gate: Address, call: GateCall, gasLimit: bigint): Promise<Read<PreparedTx>>;
  /** Waits for a receipt (bounded). */
  receipt(hash: string): Promise<Read<Receipt>>;
}

/** Robinhood Chain's documented public testnet RPC; `ChainClient` refuses any other host but an operator QuickNode endpoint. */
export const PUBLIC_TESTNET_RPC = 'https://rpc.testnet.chain.robinhood.com';

/** Where reads and the one send go. `quicknode` is an operator-configured URL (a credential); the public RPC needs none. */
export interface RpcEndpoints {
  readonly quicknode: string | null;
  /** Reads fall back to the public RPC on a transport failure of the primary (never for a send). */
  readonly publicFallback: boolean;
}

export const PUBLIC_ONLY: RpcEndpoints = { quicknode: null, publicFallback: false };

/** A failure of the connection, not an answer: the only kind a read may fall back on. */
export function isTransportFailure(error: string): boolean {
  return /^(NETWORK\.|HTTP_5\d\d|HTTP_429|NOT_JSON|NO_RESULT)/.test(error) || /^(BLOCK|MARKET)\.(NETWORK\.|HTTP_5\d\d|HTTP_429|NOT_JSON)/.test(error);
}

const big = (h: string): bigint => BigInt(h);

/** One endpoint: its chain client and the label it is reported by. */
export interface Endpoint {
  readonly chain: ChainClient;
  readonly label: RpcProvenance;
}

function endpointsOf(e: RpcEndpoints): { readonly primary: Endpoint; readonly fallback: Endpoint | null } {
  const publicClient = (): ChainClient => new ChainClient(new JsonRpcClient(PUBLIC_TESTNET_RPC), ROBINHOOD_TESTNET);
  if (e.quicknode === null) return { primary: { chain: publicClient(), label: 'public' }, fallback: null };
  return {
    primary: { chain: new ChainClient(new JsonRpcClient(e.quicknode, { operatorEndpoint: 'QUICKNODE' }), ROBINHOOD_TESTNET), label: 'quicknode' },
    fallback: e.publicFallback ? { chain: publicClient(), label: 'public-fallback' } : null,
  };
}

/**
 * Bounded reads over a primary endpoint and, optionally, the public RPC as
 * a read fallback. Each `ChainClient` verifies its own endpoint's chain id
 * (46630) before its first answer is used, and refuses every mainnet.
 */
export class RobinhoodTestnetReader implements ChainReader {
  readonly transport = 'ROBINHOOD_TESTNET_RPC' as const;
  readonly #primary: Endpoint;
  readonly #fallback: Endpoint | null;
  readonly #gate: Address;
  #last: RpcProvenance;

  /**
   * `gate` is the manifest's gate: the only contract an `eth_call` or
   * `estimateGas` may address. `endpoints` are URLs from the operator's
   * configuration, or already-built clients (tests: loopback mock nodes).
   */
  constructor(gate: Address, endpoints: RpcEndpoints | { readonly primary: Endpoint; readonly fallback: Endpoint | null } = PUBLIC_ONLY) {
    this.#gate = gate;
    const e = 'primary' in endpoints ? endpoints : endpointsOf(endpoints);
    this.#primary = e.primary;
    this.#fallback = e.fallback;
    this.#last = this.#primary.label;
  }

  /** The primary endpoint's client: what a send uses. */
  get primary(): ChainClient {
    return this.#primary.chain;
  }

  provenance(): RpcProvenance {
    return this.#last;
  }

  async #read<T>(f: (c: ChainClient) => Promise<Read<T>>): Promise<Read<T>> {
    const r = await f(this.#primary.chain);
    if (r.ok || this.#fallback === null || !isTransportFailure(r.error)) {
      this.#last = this.#primary.label;
      return r;
    }
    const again = await f(this.#fallback.chain);
    this.#last = this.#fallback.label;
    return again;
  }

  /** A raw read through `ChainClient`'s chain check: the fallback proves its chain id before its answer is used. */
  #request<T>(method: string, params: readonly (string | boolean | object)[]): Promise<Read<T>> {
    return this.#read(async (c) => {
      const ok = await c.ensureChain();
      return ok.ok ? c.rpc.request<T>(method, params) : ok;
    });
  }

  async chainId(): Promise<Read<bigint>> {
    // Fresh and unverified on purpose: preflight compares it to the manifest itself.
    const r = await this.#read((c) => c.rpc.request<string>('eth_chainId', []));
    return r.ok ? { ok: true, value: big(r.value) } : r;
  }

  latest(): Promise<Read<BlockRef>> {
    return this.#read((c) => c.block('latest'));
  }

  codehash(address: Address): Promise<Read<string>> {
    return this.#read((c) => c.codehash(address));
  }

  domainSeparator(gate: Address): Promise<Read<string>> {
    return this.#read((c) => c.domainSeparator(gate));
  }

  nativeBalance(address: Address): Promise<Read<bigint>> {
    return this.#read((c) => c.balance(address));
  }

  tokenBalance(token: Address, owner: Address, block?: bigint): Promise<Read<bigint>> {
    return this.#read((c) => c.erc20Balance(token, owner, block ?? 'latest'));
  }

  allowance(token: Address, owner: Address, spender: Address): Promise<Read<bigint>> {
    return this.#read((c) => c.erc20Allowance(token, owner, spender));
  }

  executionCommitmentOf(gate: Address, mandateDigest: string, block?: bigint): Promise<Read<string>> {
    return this.#read((c) => c.executionCommitmentOf(gate, mandateDigest, block ?? 'latest'));
  }

  async gateMarkets(policy: GateSpotPolicy): Promise<GateStateRead> {
    const r = await readGateMarkets(this.#primary.chain, policy);
    if (r.status === 'OK' || this.#fallback === null || !isTransportFailure(r.reason)) {
      this.#last = this.#primary.label;
      return r;
    }
    this.#last = this.#fallback.label;
    return readGateMarkets(this.#fallback.chain, policy);
  }

  async simulateExecute(gate: Address, call: GateCall): Promise<Simulation> {
    if (gate !== this.#gate) return { ok: false, revert: 'TARGET_NOT_THE_GATE' };
    const r = await this.#primary.chain.call(gate, call.calldata, 'latest');
    this.#last = this.#primary.label;
    if (r.ok || this.#fallback === null || !isTransportFailure(r.revert)) return r;
    this.#last = this.#fallback.label;
    return this.#fallback.chain.call(gate, call.calldata, 'latest');
  }

  async estimateExecute(gate: Address, call: GateCall, from?: Address): Promise<Read<bigint>> {
    if (gate !== this.#gate) return { ok: false, error: 'TARGET_NOT_THE_GATE' };
    return this.#read((c) => c.estimateGas(from ?? '0x0000000000000000000000000000000000000000', gate, call.calldata));
  }

  async transactionKnown(hash: string): Promise<Read<boolean>> {
    const t = await this.transaction(hash);
    return t.ok ? { ok: true, value: t.value !== null } : t;
  }

  async transaction(hash: string): Promise<Read<TxLookup | null>> {
    const t = await this.#request<{ blockNumber: string | null; from: string; nonce: string } | null>('eth_getTransactionByHash', [hash]);
    if (!t.ok) return t;
    if (t.value === null) return { ok: true, value: null };
    return { ok: true, value: { blockNumber: t.value.blockNumber === null ? null : big(t.value.blockNumber), from: t.value.from.toLowerCase(), nonce: big(t.value.nonce) } };
  }

  async receiptOnce(hash: string): Promise<Read<Receipt | null>> {
    const r = await this.#request<{ status: string; blockNumber: string; blockHash: string; gasUsed: string; effectiveGasPrice?: string; contractAddress: string | null; logs: readonly object[] } | null>('eth_getTransactionReceipt', [hash]);
    if (!r.ok) return r;
    if (r.value === null) return { ok: true, value: null };
    const v = r.value;
    return { ok: true, value: { status: v.status === '0x1' ? 'SUCCESS' : 'REVERTED', blockNumber: big(v.blockNumber), blockHash: v.blockHash, gasUsed: big(v.gasUsed), effectiveGasPrice: big(v.effectiveGasPrice ?? '0x0'), contractAddress: v.contractAddress === null ? null : v.contractAddress.toLowerCase(), logs: v.logs.length } };
  }

  async nonceAt(address: Address, tag: 'latest' | 'pending'): Promise<Read<bigint>> {
    const n = await this.#request<string>('eth_getTransactionCount', [address, tag]);
    return n.ok ? { ok: true, value: big(n.value) } : n;
  }
}

export class RobinhoodTestnetRpc extends RobinhoodTestnetReader implements TestnetRpc {
  readonly submitter: Address;
  readonly #sender: TxSender;
  readonly #gate: Address;

  /**
   * `submitterKey` is the 7E.3 disposable gas-payer key; it is kept in the
   * `TxSender`'s private field. `gate` is the manifest's gate: the only
   * contract this client will ever address a transaction or `eth_call` to.
   */
  constructor(submitterKey: string, gate: Address, endpoints: RpcEndpoints | { readonly primary: Endpoint; readonly fallback: Endpoint | null } = PUBLIC_ONLY) {
    super(gate, endpoints);
    this.#sender = new TxSender(submitterKey, ROBINHOOD_TESTNET);
    this.#gate = gate;
    this.submitter = this.#sender.address;
  }

  override async simulateExecute(gate: Address, call: GateCall): Promise<Simulation> {
    if (gate !== this.#gate) return { ok: false, revert: 'TARGET_NOT_THE_GATE' };
    // From the submitter, exactly as the send would be.
    return this.primary.call(gate, call.calldata, 'latest', this.submitter);
  }

  override estimateExecute(gate: Address, call: GateCall): Promise<Read<bigint>> {
    return super.estimateExecute(gate, call, this.submitter);
  }

  async prepareExecute(gate: Address, call: GateCall, gasLimit: bigint): Promise<Read<PreparedTx>> {
    if (gate !== this.#gate) return { ok: false, error: 'TARGET_NOT_THE_GATE' };
    const to = gate;
    const data = call.calldata;
    const nonce = await this.primary.nonce(this.submitter);
    if (!nonce.ok) return { ok: false, error: `NONCE.${nonce.error}` };
    const block = await this.primary.rpc.request<{ baseFeePerGas?: string } | null>('eth_getBlockByNumber', ['latest', false]);
    if (!block.ok || block.value === null || block.value.baseFeePerGas === undefined) return { ok: false, error: 'BASE_FEE_UNREADABLE' };
    // The 7E.3 fee rule: no tip, twice the base fee plus one.
    const maxFeePerGas = BigInt(block.value.baseFeePerGas) * 2n + 1n;
    const signed = this.#sender.signTransaction({ chainId: ROBINHOOD_TESTNET, nonce: nonce.value, maxPriorityFeePerGas: 0n, maxFeePerGas, gasLimit, to, value: 0n, data });
    return { ok: true, value: { hash: signed.hash, raw: signed.raw, call, from: this.submitter, to, nonce: nonce.value, gasLimit, maxFeePerGas } };
  }

  /** `broadcastExactSignedTransaction`: the one send, to the primary endpoint only; never a fallback. */
  async broadcast(tx: PreparedTx): Promise<BroadcastResult> {
    if (tx.to !== this.#gate || tx.from !== this.submitter) return { kind: 'ERROR', error: 'NOT_A_PREPARED_GATE_EXECUTE' };
    const ok = await this.primary.ensureChain();
    if (!ok.ok) return { kind: 'ERROR', error: ok.error };
    const sent = await this.primary.rpc.request<string>('eth_sendRawTransaction', [tx.raw]);
    if (!sent.ok) return { kind: 'ERROR', error: sent.error };
    return { kind: 'ACCEPTED', hash: sent.value.toLowerCase() };
  }

  receipt(hash: string): Promise<Read<Receipt>> {
    return this.primary.receipt(hash);
  }
}
