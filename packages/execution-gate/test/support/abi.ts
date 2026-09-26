/**
 * Minimal Solidity ABI encoder, for the differential corpus only.
 *
 * The Foundry side decodes each vector with `abi.decode(blob, (GateVector))`,
 * so the corpus carries inputs in exactly the form the gate's calldata takes.
 * Parsing a large JSON document field by field from Solidity would re-parse the
 * whole file per field; one ABI blob per vector avoids that.
 *
 * Supports only what the gate's structs use: unsigned and signed integers,
 * `address`, `bytes32`, `bool`, `string`, `bytes`, dynamic arrays and tuples.
 * Test support, not product code — the product never ABI-encodes anything.
 */

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

function word(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function hexBytes(hex: unknown): Uint8Array {
  if (typeof hex !== 'string' || !/^0x([0-9a-f]{2})*$/.test(hex)) throw new Error(`expected lowercase hex, got ${String(hex)}`);
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

function big(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  throw new Error(`expected integer, got ${String(v)}`);
}

function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 32) * 32);
  out.set(data);
  return out;
}

/** Encode `values` as a sequence of components (a tuple body), heads then tails. */
function encodeSequence(types: readonly AbiType[], values: readonly unknown[]): Uint8Array {
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  const headSize = types.reduce((n, t) => n + (isDynamic(t) ? 32 : staticSize(t)), 0);
  let tailOffset = headSize;
  types.forEach((t, i) => {
    const encoded = encodeValue(t, values[i]);
    if (isDynamic(t)) {
      heads.push(word(BigInt(tailOffset)));
      tails.push(encoded);
      tailOffset += encoded.length;
    } else {
      heads.push(encoded);
    }
  });
  return concat([...heads, ...tails]);
}

function staticSize(t: AbiType): number {
  if (t.kind === 'tuple') return t.fields.reduce((n, [, f]) => n + staticSize(f), 0);
  return 32;
}

function encodeValue(t: AbiType, v: unknown): Uint8Array {
  switch (t.kind) {
    case 'uint': {
      const n = big(v);
      if (n < 0n || n >= 1n << BigInt(t.bits)) throw new Error(`uint${t.bits} out of range: ${n}`);
      return word(n);
    }
    case 'int': {
      const n = big(v);
      const bound = 1n << BigInt(t.bits - 1);
      if (n < -bound || n >= bound) throw new Error(`int${t.bits} out of range: ${n}`);
      return word(n < 0n ? n + (1n << 256n) : n);
    }
    case 'address': {
      const b = hexBytes(v);
      if (b.length !== 20) throw new Error(`bad address ${String(v)}`);
      return word(BigInt(v as string));
    }
    case 'bytes32': {
      const b = hexBytes(v);
      if (b.length !== 32) throw new Error(`bad bytes32 ${String(v)}`);
      return b;
    }
    case 'bool':
      return word(v === true ? 1n : 0n);
    case 'string': {
      if (typeof v !== 'string') throw new Error('expected string');
      const b = utf8.encode(v);
      return concat([word(BigInt(b.length)), padded(b)]);
    }
    case 'bytes': {
      const b = hexBytes(v);
      return concat([word(BigInt(b.length)), padded(b)]);
    }
    case 'array': {
      if (!Array.isArray(v)) throw new Error('expected array');
      return concat([word(BigInt(v.length)), encodeSequence(v.map(() => t.of), v)]);
    }
    case 'tuple': {
      if (typeof v !== 'object' || v === null) throw new Error('expected object');
      const record = v as Record<string, unknown>;
      return encodeSequence(
        t.fields.map(([, f]) => f),
        t.fields.map(([name]) => {
          if (!(name in record)) throw new Error(`missing field ${name}`);
          return record[name];
        }),
      );
    }
  }
}

/** `abi.encode(value)` for a single value of type `t`, as lowercase hex. */
export function abiEncode(t: AbiType, value: unknown): string {
  const body = encodeSequence([t], [value]);
  let hex = '0x';
  for (const b of body) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Solidity function-argument encoding for the fields of one tuple. */
export function abiEncodeArguments(t: AbiType, value: unknown): string {
  if (t.kind !== 'tuple' || typeof value !== 'object' || value === null) throw new Error('expected tuple arguments');
  const record = value as Record<string, unknown>;
  const body = encodeSequence(
    t.fields.map(([, field]) => field),
    t.fields.map(([name]) => record[name]),
  );
  let hex = '0x';
  for (const b of body) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// --- The gate's structs ------------------------------------------------------

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
