/**
 * EIP-1559 transaction encoding and a sender key (Phase 7E.3).
 *
 * The gate accepts `execute` from any sender (execution-gate.md §15,
 * front-running): the submitting key pays gas and holds no authority. The
 * deployment scripts use the same encoder to create the demo contracts. The
 * only key operation exported is `TxSender.signTransaction`, which signs a
 * typed transaction for one fixed chain — never arbitrary bytes.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { concat, hexBytes, toHex } from './abi.ts';
import type { Address } from './vocabulary.ts';

export interface Eip1559Tx {
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimit: bigint;
  /** `null` creates a contract from `data`. */
  readonly to: Address | null;
  readonly value: bigint;
  readonly data: string;
}

type Rlp = Uint8Array | readonly Rlp[];

function lengthPrefix(len: number, offset: number): Uint8Array {
  if (len < 56) return new Uint8Array([offset + len]);
  const bytes: number[] = [];
  for (let n = len; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return new Uint8Array([offset + 55 + bytes.length, ...bytes]);
}

export function rlpEncode(item: Rlp): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && (item[0] as number) < 0x80) return item;
    return concat([lengthPrefix(item.length, 0x80), item]);
  }
  const body = concat((item as readonly Rlp[]).map(rlpEncode));
  return concat([lengthPrefix(body.length, 0xc0), body]);
}

/** Minimal big-endian bytes of a non-negative integer; zero is the empty string. */
export function quantityBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('negative quantity');
  if (n === 0n) return new Uint8Array(0);
  const hex = n.toString(16);
  return hexBytes(`0x${hex.length % 2 === 0 ? hex : `0${hex}`}`);
}

function fields(tx: Eip1559Tx): Rlp[] {
  return [
    quantityBytes(tx.chainId),
    quantityBytes(tx.nonce),
    quantityBytes(tx.maxPriorityFeePerGas),
    quantityBytes(tx.maxFeePerGas),
    quantityBytes(tx.gasLimit),
    tx.to === null ? new Uint8Array(0) : hexBytes(tx.to),
    quantityBytes(tx.value),
    hexBytes(tx.data),
    [],
  ];
}

/** keccak256(0x02 ‖ rlp(unsigned fields)): the hash a sender signs. */
export function signingHash(tx: Eip1559Tx): Uint8Array {
  return keccak_256(concat([new Uint8Array([2]), rlpEncode(fields(tx))]));
}

export interface SignedTx {
  readonly raw: string;
  readonly hash: string;
}

export class TxSender {
  readonly #key: Uint8Array;
  readonly #chainId: bigint;
  readonly address: Address;

  constructor(privateKeyHex: string, chainId: bigint) {
    if (!/^0x[0-9a-f]{64}$/.test(privateKeyHex)) throw new Error('private key must be 32 bytes of lowercase 0x hex');
    this.#key = hexBytes(privateKeyHex);
    this.#chainId = chainId;
    this.address = toHex(keccak_256(secp256k1.getPublicKey(this.#key, false).subarray(1)).subarray(12));
  }

  signTransaction(tx: Eip1559Tx): SignedTx {
    if (tx.chainId !== this.#chainId) throw new Error(`sender is bound to chain ${this.#chainId}, not ${tx.chainId}`);
    const sig = secp256k1.sign(signingHash(tx), this.#key, { prehash: false, format: 'recovered', lowS: true });
    const yParity = BigInt(sig[0] as number);
    const r = BigInt(toHex(sig.subarray(1, 33)));
    const s = BigInt(toHex(sig.subarray(33, 65)));
    const raw = concat([new Uint8Array([2]), rlpEncode([...fields(tx), quantityBytes(yParity), quantityBytes(r), quantityBytes(s)])]);
    return { raw: toHex(raw), hash: toHex(keccak_256(raw)) };
  }
}

/** The address a contract created by `sender` at `nonce` lands on: `keccak256(rlp([sender, nonce]))[12:]`. */
export function createAddress(sender: Address, nonce: bigint): Address {
  return toHex(keccak_256(rlpEncode([hexBytes(sender), quantityBytes(nonce)])).subarray(12));
}
