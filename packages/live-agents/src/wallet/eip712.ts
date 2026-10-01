/**
 * EIP-712 typed-data hashing for flat structs, and signer recovery — the
 * only module in this package that touches secp256k1 outside the
 * demonstration signers, and it only *recovers*: it holds no key and signs
 * nothing.
 *
 * Flat means every field is an atomic EIP-712 type (`string`, `bytes32`,
 * `address`, `uint64`, `uint256`); that is all the principal's mandate
 * approval needs, and a smaller encoder is a smaller thing to get wrong. The
 * encoder is cross-checked in tests against the kernel's
 * `eip712SigningHash`, which the frozen gate corpus proves equal to the
 * Solidity gate's.
 *
 * ```text
 * typeHash   = keccak256("Name(type1 name1,type2 name2,…)")
 * structHash = keccak256(typeHash ‖ enc(v1) ‖ enc(v2) ‖ …)      string → keccak256(utf8), others → one 32-byte word
 * digest     = keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ structHash)
 * ```
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export type AtomicType = 'string' | 'bytes32' | 'address' | 'uint64' | 'uint256';

export interface TypedField {
  readonly name: string;
  readonly type: AtomicType;
}

export type FieldValue = string | bigint;

/** The domain. `verifyingContract` is present only when a contract actually verifies the signature. */
export interface TypedDomain {
  readonly name: string;
  readonly version: string;
  readonly chainId: bigint;
  readonly verifyingContract?: string;
}

const utf8 = new TextEncoder();
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const N = secp256k1.Point.Fn.ORDER;
const HALF_N = N >> 1n;

export function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function bytesOf(h: string): Uint8Array {
  const body = h.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function word(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function typeString(name: string, fields: readonly TypedField[]): string {
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
}

/** One field's 32-byte encoding. Throws on a value its type cannot hold: callers build messages from server state, never from input. */
function encodeValue(type: AtomicType, v: FieldValue): Uint8Array {
  switch (type) {
    case 'string':
      if (typeof v !== 'string') throw new Error('string field needs a string');
      return keccak_256(utf8.encode(v));
    case 'bytes32':
      if (typeof v !== 'string' || !BYTES32.test(v)) throw new Error('bytes32 field needs 0x-prefixed lowercase 32 bytes');
      return bytesOf(v);
    case 'address':
      if (typeof v !== 'string' || !ADDRESS.test(v)) throw new Error('address field needs a 0x-prefixed lowercase address');
      return word(BigInt(v));
    case 'uint64':
    case 'uint256': {
      if (typeof v !== 'bigint' || v < 0n || v > (type === 'uint64' ? 2n ** 64n - 1n : 2n ** 256n - 1n)) throw new Error(`${type} out of range`);
      return word(v);
    }
  }
}

export function hashStruct(name: string, fields: readonly TypedField[], values: { readonly [k: string]: FieldValue }): Uint8Array {
  const parts: Uint8Array[] = [keccak_256(utf8.encode(typeString(name, fields)))];
  for (const f of fields) {
    const v = values[f.name];
    if (v === undefined) throw new Error(`missing field ${f.name}`);
    parts.push(encodeValue(f.type, v));
  }
  return keccak_256(concat(parts));
}

export function domainFields(d: TypedDomain): readonly TypedField[] {
  const fields: TypedField[] = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
  ];
  if (d.verifyingContract !== undefined) fields.push({ name: 'verifyingContract', type: 'address' });
  return fields;
}

export function domainSeparator(d: TypedDomain): Uint8Array {
  const values: { [k: string]: FieldValue } = { name: d.name, version: d.version, chainId: d.chainId };
  if (d.verifyingContract !== undefined) values['verifyingContract'] = d.verifyingContract;
  return hashStruct('EIP712Domain', domainFields(d), values);
}

/** `keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ hashStruct(message))` — the 32 bytes a wallet signs for `eth_signTypedData_v4`. */
export function typedDataHash(d: TypedDomain, primaryType: string, fields: readonly TypedField[], message: { readonly [k: string]: FieldValue }): Uint8Array {
  return keccak_256(concat([new Uint8Array([0x19, 0x01]), domainSeparator(d), hashStruct(primaryType, fields, message)]));
}

export type Recovered = { readonly ok: true; readonly address: string; readonly normalized: string } | { readonly ok: false; readonly reason: 'SIGNATURE_MALFORMED' | 'SIGNATURE_HIGH_S' | 'SIGNATURE_UNRECOVERABLE' };

/**
 * The address that signed `hash`, from a 65-byte `r ‖ s ‖ v` signature.
 * `v` may be 27/28 or 0/1 (wallets differ); it is normalized to 27/28.
 * A high-`s` twin is refused (EIP-2), so one approval has one encoding.
 */
export function recoverAddress(hash: Uint8Array, signature: string): Recovered {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, reason: 'SIGNATURE_MALFORMED' };
  const sig = bytesOf(signature.toLowerCase());
  let v = sig[64] as number;
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) return { ok: false, reason: 'SIGNATURE_MALFORMED' };
  let r = 0n;
  let s = 0n;
  for (let i = 0; i < 32; i += 1) r = (r << 8n) | BigInt(sig[i] as number);
  for (let i = 32; i < 64; i += 1) s = (s << 8n) | BigInt(sig[i] as number);
  if (r === 0n || r >= N || s === 0n || s >= N) return { ok: false, reason: 'SIGNATURE_MALFORMED' };
  if (s > HALF_N) return { ok: false, reason: 'SIGNATURE_HIGH_S' };
  try {
    const point = secp256k1.Signature.fromBytes(sig.subarray(0, 64)).addRecoveryBit(v - 27).recoverPublicKey(hash);
    const normalized = new Uint8Array(65);
    normalized.set(sig.subarray(0, 64), 0);
    normalized[64] = v;
    return { ok: true, address: hex(keccak_256(point.toBytes(false).subarray(1)).subarray(12)), normalized: hex(normalized) };
  } catch {
    return { ok: false, reason: 'SIGNATURE_UNRECOVERABLE' };
  }
}

/** keccak256 of UTF-8 text, as 0x-prefixed hex. */
export function keccakText(text: string): string {
  return hex(keccak_256(utf8.encode(text)));
}

/** keccak256 of a 0x-prefixed hex byte string, as 0x-prefixed hex. */
export function keccakHex(h: string): string {
  return hex(keccak_256(bytesOf(h.toLowerCase())));
}
