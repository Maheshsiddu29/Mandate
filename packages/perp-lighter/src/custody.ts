/**
 * Key custody (Phase 7E.1; signer-architecture.md §6).
 *
 * `KeyCustody` is the only interface through which anything reaches the
 * Lighter private key. It has exactly three operations and no other:
 *
 * - `publicKey` — for the `CREDENTIAL_SCOPE` check;
 * - `hash(tx)` — the venue's exact transaction hash, computed **without** the
 *   key, so it can be committed in `ADMIT_ATTEMPT` first;
 * - `sign(tx, expectedHash, attempt)` — signs only a transaction whose
 *   recomputed hash equals the committed one, only of an allowed shape, only
 *   for the configured account and key, and at most one hash per nonce slot.
 *
 * There is no `sign(bytes)`, no raw key accessor and no SDK client here.
 * `GoKeyCustody` runs the separate `lighter-custody` process (custody/main.go),
 * which wraps the official lighter-go SDK; the key lives only in that
 * process's memory and in its key file.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** The only transaction description custody accepts (mirrors custody/main.go `Tx`). */
export interface CustodyTx {
  /** `CREATE_ORDER` | `CANCEL_ORDER`; anything else is refused by both the signer and custody. */
  readonly type: string;
  readonly chainId: number;
  readonly accountIndex: bigint;
  readonly apiKeyIndex: number;
  readonly marketIndex: number;
  readonly clientOrderIndex: bigint;
  readonly baseAmount: bigint;
  readonly price: bigint;
  readonly isAsk: number;
  readonly orderType: number;
  readonly timeInForce: number;
  readonly reduceOnly: number;
  readonly orderExpiry: bigint;
  readonly cancelIndex: bigint;
  readonly expiredAt: bigint;
  readonly nonce: bigint;
  readonly selfTradeBehavior: number;
  readonly selfTradeEquality: number;
}

export type CustodyResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface HashedTx {
  /** 80 lowercase hex characters: Lighter's 40-byte transaction hash. */
  readonly hash: string;
  readonly txType: number;
}

export interface SignedTx extends HashedTx {
  /** The JSON `tx_info` `sendTx` takes, signature included. Never leaves the signer's boundary. */
  readonly txInfo: string;
}

export interface KeyCustody {
  publicKey(): Promise<CustodyResult<string>>;
  hash(tx: CustodyTx): Promise<CustodyResult<HashedTx>>;
  sign(tx: CustodyTx, expectedHash: string, attempt: string): Promise<CustodyResult<SignedTx>>;
  close(): void;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function jsonInt(x: bigint): number {
  if (x < 0n || x > MAX_SAFE) throw new RangeError('custody integer out of range');
  return Number(x);
}

/** The JSON form custody/main.go decodes. Every integer here is at most 2^48 by Lighter's own bounds. */
export function custodyJson(tx: CustodyTx): { [k: string]: string | number } {
  return {
    type: tx.type,
    chainId: tx.chainId,
    accountIndex: jsonInt(tx.accountIndex),
    apiKeyIndex: tx.apiKeyIndex,
    marketIndex: tx.marketIndex,
    clientOrderIndex: jsonInt(tx.clientOrderIndex),
    baseAmount: jsonInt(tx.baseAmount),
    price: jsonInt(tx.price),
    isAsk: tx.isAsk,
    orderType: tx.orderType,
    timeInForce: tx.timeInForce,
    reduceOnly: tx.reduceOnly,
    orderExpiry: jsonInt(tx.orderExpiry),
    cancelIndex: jsonInt(tx.cancelIndex),
    expiredAt: jsonInt(tx.expiredAt),
    nonce: jsonInt(tx.nonce),
    selfTradeBehavior: tx.selfTradeBehavior,
    selfTradeEquality: tx.selfTradeEquality,
  };
}

export interface GoCustodyOptions {
  /** Path of the built `lighter-custody` binary. */
  readonly binary: string;
  readonly keyFile: string;
  readonly chainId: number;
  readonly accountIndex: bigint;
  readonly apiKeyIndex: number;
  readonly journal: string;
}

interface Reply {
  readonly ok: boolean;
  readonly error?: string;
  readonly hash?: string;
  readonly txType?: number;
  readonly txInfo?: string;
  readonly publicKey?: string;
}

/**
 * The separate key-custody process. Requests are strictly serialized: one line
 * in, one line out. The process's environment carries only its own
 * configuration; nothing it prints can contain the key.
 */
export class GoKeyCustody implements KeyCustody {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #replies: ((line: string) => void)[] = [];
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(o: GoCustodyOptions) {
    this.#child = spawn(o.binary, [], {
      env: {
        LIGHTER_CUSTODY_KEY_FILE: o.keyFile,
        LIGHTER_CUSTODY_CHAIN_ID: String(o.chainId),
        LIGHTER_CUSTODY_ACCOUNT_INDEX: o.accountIndex.toString(),
        LIGHTER_CUSTODY_API_KEY_INDEX: String(o.apiKeyIndex),
        LIGHTER_CUSTODY_JOURNAL: o.journal,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    createInterface({ input: this.#child.stdout }).on('line', (line) => this.#replies.shift()?.(line));
    this.#child.on('exit', () => {
      this.#closed = true;
      for (const r of this.#replies.splice(0)) r('{"ok":false,"error":"CUSTODY_EXITED"}');
    });
  }

  #call(request: object): Promise<Reply> {
    const run = this.#queue.then(
      () =>
        new Promise<Reply>((resolve) => {
          if (this.#closed) {
            resolve({ ok: false, error: 'CUSTODY_EXITED' });
            return;
          }
          this.#replies.push((line) => {
            try {
              resolve(JSON.parse(line) as Reply);
            } catch {
              resolve({ ok: false, error: 'CUSTODY_REPLY_MALFORMED' });
            }
          });
          this.#child.stdin.write(`${JSON.stringify(request)}\n`);
        }),
    );
    this.#queue = run.then(() => undefined);
    return run;
  }

  async publicKey(): Promise<CustodyResult<string>> {
    const r = await this.#call({ op: 'publicKey' });
    return r.ok && typeof r.publicKey === 'string' ? { ok: true, value: r.publicKey } : { ok: false, error: r.error ?? 'CUSTODY_FAILED' };
  }

  async hash(tx: CustodyTx): Promise<CustodyResult<HashedTx>> {
    const r = await this.#call({ op: 'hash', tx: custodyJson(tx) });
    return r.ok && typeof r.hash === 'string' && typeof r.txType === 'number' ? { ok: true, value: { hash: r.hash, txType: r.txType } } : { ok: false, error: r.error ?? 'CUSTODY_FAILED' };
  }

  async sign(tx: CustodyTx, expectedHash: string, attempt: string): Promise<CustodyResult<SignedTx>> {
    const r = await this.#call({ op: 'sign', tx: custodyJson(tx), expectedHash, attempt });
    return r.ok && typeof r.hash === 'string' && typeof r.txType === 'number' && typeof r.txInfo === 'string' ? { ok: true, value: { hash: r.hash, txType: r.txType, txInfo: r.txInfo } } : { ok: false, error: r.error ?? 'CUSTODY_FAILED' };
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#child.stdin.end();
      this.#child.kill();
    }
  }
}
