/**
 * Robinhood Chain testnet access for the settlement path — the only module
 * in the Live AI Lab that holds an RPC client or a transaction-signing key.
 *
 * It is built on the Phase 7E.3 `ChainClient` (which refuses every host but
 * the documented public testnet RPC and every chain but the one configured)
 * and `TxSender` (which signs typed transactions for one fixed chain, never
 * arbitrary bytes). The sender is the 7E.3 gas payer: it holds no authority,
 * because the gate accepts `execute` from anyone and moves funds only for a
 * principal-signed mandate.
 *
 * It can call exactly one function on exactly one contract: `execute` on
 * the gate it was constructed for. There is no generic call, no arbitrary
 * calldata and no other destination; everything else is a read.
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
  /** The signed transaction. Public once broadcast, but never logged or emitted. */
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

/** What the settlement path needs from a chain. `RobinhoodTestnetRpc` is the only network implementation. */
export interface TestnetRpc {
  readonly transport: Transport;
  /** The gas payer's public address. */
  readonly submitter: Address;
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
  /** Sign `execute(call)` to the gate from the submitter; nothing is sent. */
  prepareExecute(gate: Address, call: GateCall, gasLimit: bigint): Promise<Read<PreparedTx>>;
  broadcast(tx: PreparedTx): Promise<BroadcastResult>;
  transactionKnown(hash: string): Promise<Read<boolean>>;
  receipt(hash: string): Promise<Read<Receipt>>;
}

/** Robinhood Chain's documented public testnet RPC; `ChainClient` refuses any other. */
export const PUBLIC_TESTNET_RPC = 'https://rpc.testnet.chain.robinhood.com';

export class RobinhoodTestnetRpc implements TestnetRpc {
  readonly transport = 'ROBINHOOD_TESTNET_RPC' as const;
  readonly submitter: Address;
  readonly #chain: ChainClient;
  readonly #sender: TxSender;
  readonly #gate: Address;

  /**
   * `submitterKey` is the 7E.3 disposable gas-payer key; it is kept in the
   * `TxSender`'s private field. `gate` is the manifest's gate: the only
   * contract this client will ever address a transaction or `eth_call` to.
   */
  constructor(submitterKey: string, gate: Address, url: string = PUBLIC_TESTNET_RPC) {
    this.#chain = new ChainClient(new JsonRpcClient(url), ROBINHOOD_TESTNET);
    this.#sender = new TxSender(submitterKey, ROBINHOOD_TESTNET);
    this.#gate = gate;
    this.submitter = this.#sender.address;
  }

  async chainId(): Promise<Read<bigint>> {
    const id = await this.#chain.rpc.request<string>('eth_chainId', []);
    return id.ok ? { ok: true, value: BigInt(id.value) } : id;
  }

  latest(): Promise<Read<BlockRef>> {
    return this.#chain.block('latest');
  }

  codehash(address: Address): Promise<Read<string>> {
    return this.#chain.codehash(address);
  }

  domainSeparator(gate: Address): Promise<Read<string>> {
    return this.#chain.domainSeparator(gate);
  }

  nativeBalance(address: Address): Promise<Read<bigint>> {
    return this.#chain.balance(address);
  }

  tokenBalance(token: Address, owner: Address, block?: bigint): Promise<Read<bigint>> {
    return this.#chain.erc20Balance(token, owner, block ?? 'latest');
  }

  allowance(token: Address, owner: Address, spender: Address): Promise<Read<bigint>> {
    return this.#chain.erc20Allowance(token, owner, spender);
  }

  executionCommitmentOf(gate: Address, mandateDigest: string, block?: bigint): Promise<Read<string>> {
    return this.#chain.executionCommitmentOf(gate, mandateDigest, block ?? 'latest');
  }

  gateMarkets(policy: GateSpotPolicy): Promise<GateStateRead> {
    return readGateMarkets(this.#chain, policy);
  }

  async simulateExecute(gate: Address, call: GateCall): Promise<Simulation> {
    if (gate !== this.#gate) return { ok: false, revert: 'TARGET_NOT_THE_GATE' };
    return this.#chain.call(gate, call.calldata, 'latest', this.submitter);
  }

  async estimateExecute(gate: Address, call: GateCall): Promise<Read<bigint>> {
    if (gate !== this.#gate) return { ok: false, error: 'TARGET_NOT_THE_GATE' };
    return this.#chain.estimateGas(this.submitter, gate, call.calldata);
  }

  async prepareExecute(gate: Address, call: GateCall, gasLimit: bigint): Promise<Read<PreparedTx>> {
    if (gate !== this.#gate) return { ok: false, error: 'TARGET_NOT_THE_GATE' };
    const to = gate;
    const data = call.calldata;
    const nonce = await this.#chain.nonce(this.submitter);
    if (!nonce.ok) return { ok: false, error: `NONCE.${nonce.error}` };
    const block = await this.#chain.rpc.request<{ baseFeePerGas?: string } | null>('eth_getBlockByNumber', ['latest', false]);
    if (!block.ok || block.value === null || block.value.baseFeePerGas === undefined) return { ok: false, error: 'BASE_FEE_UNREADABLE' };
    // The 7E.3 fee rule: no tip, twice the base fee plus one.
    const maxFeePerGas = BigInt(block.value.baseFeePerGas) * 2n + 1n;
    const signed = this.#sender.signTransaction({ chainId: ROBINHOOD_TESTNET, nonce: nonce.value, maxPriorityFeePerGas: 0n, maxFeePerGas, gasLimit, to, value: 0n, data });
    return { ok: true, value: { hash: signed.hash, raw: signed.raw, call, from: this.submitter, to, nonce: nonce.value, gasLimit, maxFeePerGas } };
  }

  async broadcast(tx: PreparedTx): Promise<BroadcastResult> {
    if (tx.to !== this.#gate || tx.from !== this.submitter) return { kind: 'ERROR', error: 'NOT_A_PREPARED_GATE_EXECUTE' };
    const sent = await this.#chain.rpc.request<string>('eth_sendRawTransaction', [tx.raw]);
    if (!sent.ok) return { kind: 'ERROR', error: sent.error };
    return { kind: 'ACCEPTED', hash: sent.value.toLowerCase() };
  }

  async transactionKnown(hash: string): Promise<Read<boolean>> {
    const t = await this.#chain.rpc.request<object | null>('eth_getTransactionByHash', [hash]);
    return t.ok ? { ok: true, value: t.value !== null } : t;
  }

  receipt(hash: string): Promise<Read<Receipt>> {
    return this.#chain.receipt(hash);
  }
}
