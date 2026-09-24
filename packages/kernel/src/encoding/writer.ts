/**
 * MCE v1 primitive writers (ADR 0002).
 *
 * Big-endian, fixed-width integers; length-prefixed strings; sets sorted by
 * their encoded bytes. Big-endian because it is what the EVM uses natively, so
 * a Solidity reimplementation of this encoding needs no byte reversal.
 *
 * Every writer range-checks its argument and throws on violation. Throwing is
 * correct here and only here: reaching a writer with an out-of-range value
 * means a parser was bypassed, which is a bug in this package rather than a
 * financial outcome. Parsers return `Result`; writers assert.
 */

const encoder = new TextEncoder();

export class ByteWriter {
  readonly #chunks: Uint8Array[] = [];
  #length = 0;

  raw(bytes: Uint8Array): this {
    this.#chunks.push(bytes);
    this.#length += bytes.length;
    return this;
  }

  /** ASCII domain tag: fixed bytes, no length prefix, no terminator. */
  tag(tag: string): this {
    if (!/^[A-Z0-9.]+$/.test(tag)) throw new Error(`invalid domain tag: ${tag}`);
    return this.raw(encoder.encode(tag));
  }

  uint(value: bigint, byteLength: number): this {
    if (value < 0n) throw new Error(`negative value in unsigned field: ${value}`);
    const max = (1n << BigInt(byteLength * 8)) - 1n;
    if (value > max) throw new Error(`value ${value} exceeds ${byteLength}-byte unsigned field`);
    const out = new Uint8Array(byteLength);
    let v = value;
    for (let i = byteLength - 1; i >= 0; i -= 1) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return this.raw(out);
  }

  u8(value: bigint | number): this {
    return this.uint(BigInt(value), 1);
  }

  u16(value: bigint | number): this {
    return this.uint(BigInt(value), 2);
  }

  u32(value: bigint | number): this {
    return this.uint(BigInt(value), 4);
  }

  u64(value: bigint): this {
    return this.uint(value, 8);
  }

  u256(value: bigint): this {
    return this.uint(value, 32);
  }

  /** Signed 64-bit, two's complement. Used only for Unix-second timestamps. */
  i64(value: bigint): this {
    const min = -(2n ** 63n);
    const max = 2n ** 63n - 1n;
    if (value < min || value > max) throw new Error(`value ${value} outside int64`);
    return this.uint(value < 0n ? value + (1n << 64n) : value, 8);
  }

  /** `u16` byte length, then UTF-8 bytes. The identifier charset is ASCII, so length in bytes equals length in code units. */
  str(value: string): this {
    const bytes = encoder.encode(value);
    if (bytes.length > 1024) throw new Error(`string exceeds 1024 bytes`);
    return this.u16(bytes.length).raw(bytes);
  }

  bytes32(value: Uint8Array): this {
    if (value.length !== 32) throw new Error(`expected 32 bytes, got ${value.length}`);
    return this.raw(value);
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/**
 * Order of two identifiers as their encoded forms compare.
 *
 * The encoded form is a big-endian `u16` length followed by ASCII bytes, so
 * byte order is length first, then content. This is *not* plain lexicographic
 * string order, and using plain string order would make the encoder and the
 * decoder's ascending-order check disagree about canonicality.
 */
export function compareIdentifierBytes(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `u16` count, then each element, sorted by encoded bytes. */
export function writeIdentifierSet(w: ByteWriter, values: readonly string[]): void {
  const sorted = [...values].sort(compareIdentifierBytes);
  w.u16(sorted.length);
  for (const v of sorted) w.str(v);
}
