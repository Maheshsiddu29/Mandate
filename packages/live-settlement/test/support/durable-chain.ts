/**
 * The reference-model chain, made to outlive a process — for the real
 * SIGKILL crash tests. A node persists what it has accepted; so does this:
 * every broadcast it accepts is mined and written (fsync, then rename)
 * before `broadcast` returns, and a new process replays the mined calls, in
 * order and at their recorded chain times, onto a fresh `ModelChain` — so
 * balances, the gate's consumed replay keys and receipts are exactly what
 * the killed process left behind. A broadcast in flight when a process dies
 * is lost, as with any node that never received it.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import type { Address, GateCall, Read, Receipt } from '@mandate/evm-robinhood';
import type { BroadcastResult, PreparedTx, TxLookup } from '../../src/rpc.ts';
import { ModelRpc, SUBMITTER } from './world.ts';

interface Persisted {
  time: string;
  mined: { hash: string; time: string; call: GateCall; result: 'SUCCESS' | 'REVERTED'; block: string }[];
}

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? { $big: v.toString() } : v);
const reviver = (_k: string, v: unknown) => (typeof v === 'object' && v !== null && '$big' in v && Object.keys(v).length === 1 ? BigInt((v as { $big: string }).$big) : v);

export class DurableModelRpc extends ModelRpc {
  readonly #path: string;
  readonly #mined = new Map<string, { result: 'SUCCESS' | 'REVERTED'; block: bigint }>();
  #log: Persisted['mined'] = [];

  constructor(path: string) {
    super();
    this.#path = path;
    if (existsSync(path)) {
      const p = JSON.parse(readFileSync(path, 'utf8'), reviver) as Persisted;
      for (const m of p.mined) {
        this.chain.time = BigInt(m.time);
        const tx = this.chain.mine(m.call);
        this.#mined.set(m.hash, { result: tx.result, block: tx.block });
      }
      this.#log = p.mined;
      this.chain.time = BigInt(p.time);
    }
  }

  #persist(): void {
    const tmp = `${this.#path}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    writeSync(fd, JSON.stringify({ time: this.chain.time.toString(), mined: this.#log } satisfies Persisted, replacer));
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.#path);
  }

  /** Move chain time forward, durably. */
  advance(seconds: bigint): void {
    this.chain.time += seconds;
    this.#persist();
  }

  override async broadcast(tx: PreparedTx): Promise<BroadcastResult> {
    this.broadcasts += 1;
    const time = this.chain.time;
    const mined = this.chain.mine(tx.call);
    this.#mined.set(tx.hash, { result: mined.result, block: mined.block });
    this.#log.push({ hash: tx.hash, time: time.toString(), call: tx.call, result: mined.result, block: mined.block.toString() });
    this.#persist();
    return { kind: 'ACCEPTED', hash: tx.hash };
  }

  override async transactionKnown(hash: string): Promise<Read<boolean>> {
    return { ok: true, value: this.#mined.has(hash) };
  }

  override async transaction(hash: string): Promise<Read<TxLookup | null>> {
    const m = this.#mined.get(hash);
    return { ok: true, value: m === undefined ? null : { blockNumber: m.block, from: SUBMITTER, nonce: 0n } };
  }

  override async receipt(hash: string): Promise<Read<Receipt>> {
    const m = this.#mined.get(hash);
    if (m === undefined) return { ok: false, error: 'RECEIPT_TIMEOUT' };
    return { ok: true, value: { status: m.result, blockNumber: m.block, blockHash: `0x${m.block.toString(16).padStart(64, '0')}`, gasUsed: 250_000n, effectiveGasPrice: 20_000_000n, contractAddress: null, logs: m.result === 'SUCCESS' ? 3 : 0 } };
  }

  override async receiptOnce(hash: string): Promise<Read<Receipt | null>> {
    return this.#mined.has(hash) ? this.receipt(hash) : { ok: true, value: null };
  }

  override async nonceAt(_a?: Address): Promise<Read<bigint>> {
    return { ok: true, value: BigInt(this.#mined.size) };
  }

  /** Transactions the chain has ever mined. */
  get minedCount(): number {
    return this.#mined.size;
  }
}
