/**
 * Minimal Solidity ABI encoding for the calls this adapter makes (Phase 7E.3).
 *
 * Supports only what those calls use: unsigned and signed integers, `address`,
 * `bytes32`, `bool`, `string`, `bytes`, dynamic arrays and tuples. The gate's
 * `execute` arguments are encoded from `@mandate/execution-gate`'s wire types
 * field for field, in Solidity struct order (`MandateTypes.sol`). Tested
 * against the differential corpus's encoder and exercised against the
 * deployed gate itself; pure.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import type { GateCandidate, GateMandate, GateTerms } from '@mandate/execution-gate';

export type AbiType =
  | { readonly kind: 'uint'; readonly bits: number }
  | { readonly kind: 'int'; readonly bits: number }
  | { readonly kind: 'address' }
  | { readonly kind: 'bytes32' }
  | { readonly kind: 'bool' }
  | { readonly kind: 'string' }
  | { readonly kind: 'bytes' }
  | { readonly kind: 'array'; readonly of: AbiType }
  | { readonly kind: 'tuple'; readonly fields: readonly (readonly [string, AbiType])[] };

/** A value the encoder accepts: integers are `bigint`, byte strings lowercase `0x` hex. */
export type AbiValue = bigint | boolean | string | readonly AbiValue[] | { readonly [field: string]: AbiValue };

export const uint = (bits: number): AbiType => ({ kind: 'uint', bits });
export const int = (bits: number): AbiType => ({ kind: 'int', bits });
export const address: AbiType = { kind: 'address' };
export const bytes32: AbiType = { kind: 'bytes32' };
export const bool: AbiType = { kind: 'bool' };
export const string: AbiType = { kind: 'string' };
export const bytes: AbiType = { kind: 'bytes' };
export const array = (of: AbiType): AbiType => ({ kind: 'array', of });
export const tuple = (...fields: (readonly [string, AbiType])[]): AbiType => ({ kind: 'tuple', fields });

const utf8 = new TextEncoder();

function isDynamic(t: AbiType): boolean {
  if (t.kind === 'string' || t.kind === 'bytes' || t.kind === 'array') return true;
  if (t.kind === 'tuple') return t.fields.some(([, f]) => isDynamic(f));
  return false;
}

export function word(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw new Error(`word out of range: ${value}`);
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function hexBytes(hex: string): Uint8Array {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(hex)) throw new Error(`not lowercase even hex: ${hex.slice(0, 20)}`);
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = '0x';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function padded(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32);
  out.set(b);
  return out;
}

function encodeValue(t: AbiType, v: AbiValue): Uint8Array {
  switch (t.kind) {
    case 'uint': {
      const n = v as bigint;
      if (typeof n !== 'bigint' || n < 0n || n >= 1n << BigInt(t.bits)) throw new Error(`uint${t.bits} out of range`);
      return word(n);
    }
    case 'int': {
      const n = v as bigint;
      if (typeof n !== 'bigint' || n < -(1n << BigInt(t.bits - 1)) || n >= 1n << BigInt(t.bits - 1)) throw new Error(`int${t.bits} out of range`);
      return word(n < 0n ? (1n << 256n) + n : n);
    }
    case 'address': {
      const a = v as string;
      if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`not a lowercase address: ${a}`);
      return word(BigInt(a));
    }
    case 'bytes32': {
      const h = v as string;
      if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error('not bytes32');
      return hexBytes(h);
    }
    case 'bool':
      return word((v as boolean) ? 1n : 0n);
    case 'string':
    case 'bytes': {
      const raw = t.kind === 'string' ? utf8.encode(v as string) : hexBytes(v as string);
      return concat([word(BigInt(raw.length)), padded(raw)]);
    }
    case 'array': {
      const items = v as readonly AbiValue[];
      return concat([word(BigInt(items.length)), encodeSequence(items.map(() => t.of), items)]);
    }
    case 'tuple': {
      const obj = v as { readonly [field: string]: AbiValue };
      return encodeSequence(
        t.fields.map(([, f]) => f),
        t.fields.map(([name]) => {
          const x = obj[name];
          if (x === undefined) throw new Error(`missing tuple field ${name}`);
          return x;
        }),
      );
    }
  }
}

/** Head bytes of a static value: a static tuple is laid out inline, everything else is one word. */
function staticSize(t: AbiType): number {
  return t.kind === 'tuple' ? t.fields.reduce((n, [, f]) => n + staticSize(f), 0) : 32;
}

function encodeSequence(types: readonly AbiType[], values: readonly AbiValue[]): Uint8Array {
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailOffset = types.reduce((n, t) => n + (isDynamic(t) ? 32 : staticSize(t)), 0);
  types.forEach((t, i) => {
    const enc = encodeValue(t, values[i] as AbiValue);
    if (isDynamic(t)) {
      heads.push(word(BigInt(tailOffset)));
      tails.push(enc);
      tailOffset += enc.length;
    } else heads.push(enc);
  });
  return concat([...heads, ...tails]);
}

/** ABI-encode an argument list (no selector). */
export function encodeArguments(types: readonly AbiType[], values: readonly AbiValue[]): Uint8Array {
  return encodeSequence(types, values);
}

export function selector(signature: string): Uint8Array {
  return keccak_256(utf8.encode(signature)).subarray(0, 4);
}

/** `selector(signature) ‖ encodeArguments(types, values)`, as lowercase hex. */
export function calldata(signature: string, types: readonly AbiType[], values: readonly AbiValue[]): string {
  return toHex(concat([selector(signature), encodeArguments(types, values)]));
}

// --- The gate's structs (MandateTypes.sol) ---------------------------------------------------

export const ASSET = tuple(['assetClass', string], ['idScheme', string], ['value', string]);
export const AMOUNT = tuple(['unit', string], ['decimals', uint(8)], ['atoms', uint(256)]);
export const PRICE = tuple(['numeratorUnit', string], ['denominatorUnit', string], ['decimals', uint(8)], ['atoms', uint(256)]);

export const MANDATE = tuple(
  ['version', uint(16)],
  ['mandateId', bytes32],
  ['nonce', uint(64)],
  ['principal', address],
  ['agent', address],
  ['canonicalAsset', ASSET],
  ['side', uint(8)],
  ['maxNotional', AMOUNT],
  ['economicLimit', AMOUNT],
  ['maxDeviationBps', uint(16)],
  ['syntheticPolicy', uint(8)],
  ['allowedIssuers', array(string)],
  ['allowedChains', array(string)],
  ['allowedVenues', array(string)],
  ['requiredCorporateActionEpoch', uint(64)],
  ['maxPriceAgeSeconds', uint(32)],
  ['maxCorporateActionAgeSeconds', uint(32)],
  ['haltPolicy', uint(8)],
  ['createdAtUnixSeconds', int(64)],
  ['notBeforeUnixSeconds', int(64)],
  ['expiresAtUnixSeconds', int(64)],
);

export const CANDIDATE = tuple(
  ['version', uint(16)],
  ['representationId', string],
  ['canonicalAsset', ASSET],
  ['issuer', string],
  ['chain', string],
  ['venue', string],
  ['side', uint(8)],
  ['agent', address],
  ['quantity', AMOUNT],
  ['executionPrice', PRICE],
  ['notional', AMOUNT],
  ['feeTotal', AMOUNT],
  ['evaluationStateId', string],
  ['evaluationStateDigest', bytes32],
  ['registrySnapshotDigest', bytes32],
  ['corporateActionEpoch', uint(64)],
);

export const TERMS = tuple(['recipient', address], ['fundingLimit', uint(256)], ['deadline', uint(64)], ['executionData', bytes]);

export const EXECUTE_SIGNATURE =
  'execute((uint16,bytes32,uint64,address,address,(string,string,string),uint8,(string,uint8,uint256),(string,uint8,uint256),uint16,uint8,string[],string[],string[],uint64,uint32,uint32,uint8,int64,int64,int64),bytes,(uint16,string,(string,string,string),string,string,string,uint8,address,(string,uint8,uint256),(string,string,uint8,uint256),(string,uint8,uint256),(string,uint8,uint256),string,bytes32,bytes32,uint64),(address,uint256,uint64,bytes),bytes)';

const amount = (a: { unit: string; decimals: number; atoms: bigint }): AbiValue => ({ unit: a.unit, decimals: BigInt(a.decimals), atoms: a.atoms });

export function mandateValue(m: GateMandate): AbiValue {
  return {
    ...m,
    canonicalAsset: { ...m.canonicalAsset },
    maxNotional: amount(m.maxNotional),
    economicLimit: amount(m.economicLimit),
    allowedIssuers: [...m.allowedIssuers],
    allowedChains: [...m.allowedChains],
    allowedVenues: [...m.allowedVenues],
  };
}

export function candidateValue(c: GateCandidate): AbiValue {
  return {
    ...c,
    canonicalAsset: { ...c.canonicalAsset },
    quantity: amount(c.quantity),
    executionPrice: { ...c.executionPrice, decimals: BigInt(c.executionPrice.decimals) },
    notional: amount(c.notional),
    feeTotal: amount(c.feeTotal),
  };
}

export function termsValue(t: GateTerms): AbiValue {
  return { ...t };
}

/** Calldata for `MandateExecutionGate.execute(mandate, principalSignature, candidate, terms, agentSignature)`. */
export function executeCalldata(m: GateMandate, principalSignature: string, c: GateCandidate, t: GateTerms, agentSignature: string): string {
  return calldata(EXECUTE_SIGNATURE, [MANDATE, bytes, CANDIDATE, TERMS, bytes], [mandateValue(m), principalSignature, candidateValue(c), termsValue(t), agentSignature]);
}

// --- Decoding static return words ------------------------------------------------------------

/** The `i`-th 32-byte word of return data, as an unsigned integer. */
export function wordAt(data: string, i: number): bigint {
  const start = 2 + i * 64;
  if (!/^0x[0-9a-f]*$/.test(data) || data.length < start + 64) throw new Error('return data too short');
  return BigInt(`0x${data.slice(start, start + 64)}`);
}

export function addressAt(data: string, i: number): string {
  return `0x${wordAt(data, i).toString(16).padStart(40, '0')}`;
}

export function bytes32At(data: string, i: number): string {
  return `0x${wordAt(data, i).toString(16).padStart(64, '0')}`;
}
