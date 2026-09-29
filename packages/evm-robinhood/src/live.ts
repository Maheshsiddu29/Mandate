/**
 * `GateChain` over Robinhood Chain testnet JSON-RPC (Phase 7E.3).
 *
 * The signer's view of the chain: time from the latest block, the gate's
 * runtime code hash and domain separator, the principal's funding, the gate's
 * replay key, an `eth_call` preflight and submission from a gas-paying sender
 * that holds no authority (the gate accepts `execute` from anyone).
 */

import type { ChainClient, Read, Receipt, Simulation, Submission, BlockRef } from './chain.ts';
import type { GateCall, GateChain } from './issuance.ts';
import type { TxSender } from './transaction.ts';
import type { Address } from './vocabulary.ts';

export class LiveGateChain implements GateChain {
  readonly #chain: ChainClient;
  readonly #gate: Address;
  readonly #sender: TxSender;

  constructor(chain: ChainClient, gate: Address, sender: TxSender) {
    this.#chain = chain;
    this.#gate = gate;
    this.#sender = sender;
  }

  latest(): Promise<Read<BlockRef>> {
    return this.#chain.block('latest');
  }

  async gateIdentity(): Promise<Read<{ codehash: string; domainSeparator: string }>> {
    const [codehash, domainSeparator] = await Promise.all([this.#chain.codehash(this.#gate), this.#chain.domainSeparator(this.#gate)]);
    if (!codehash.ok) return codehash;
    if (!domainSeparator.ok) return domainSeparator;
    return { ok: true, value: { codehash: codehash.value, domainSeparator: domainSeparator.value } };
  }

  async funding(token: Address, owner: Address, spender: Address): Promise<Read<{ balance: bigint; allowance: bigint }>> {
    const [balance, allowance] = await Promise.all([this.#chain.erc20Balance(token, owner), this.#chain.erc20Allowance(token, owner, spender)]);
    if (!balance.ok) return balance;
    if (!allowance.ok) return allowance;
    return { ok: true, value: { balance: balance.value, allowance: allowance.value } };
  }

  executionCommitmentOf(mandateDigest: string): Promise<Read<string>> {
    return this.#chain.executionCommitmentOf(this.#gate, mandateDigest);
  }

  simulate(call: GateCall): Promise<Simulation> {
    return this.#chain.call(this.#gate, call.calldata, 'latest', this.#sender.address);
  }

  submit(call: GateCall): Promise<Submission> {
    return this.#chain.send(this.#sender, this.#gate, call.calldata);
  }

  receipt(txHash: string): Promise<Read<Receipt>> {
    return this.#chain.receipt(txHash);
  }
}
