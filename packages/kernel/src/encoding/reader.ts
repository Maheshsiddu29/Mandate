/**
 * MCE v1 primitive readers (ADR 0002).
 *
 * The decoder is strict in every direction that matters for canonicality:
 * truncation rejects, trailing bytes reject, a set that is not strictly
 * ascending rejects, and a string outside the identifier charset rejects. No
 * input is repaired.
 *
 * Read failures are signalled by `undefined` and converted to reason codes by
 * the codec layer, so nothing here throws on hostile input.
 */

const decoder = new TextDecoder('utf-8', { fatal: true });

export class ByteReader {
  #offset = 0;
  readonly #bytes: Uint8Array;

  // Written out rather than as a parameter property: Node's type-stripping
  // loader runs these sources directly and does not support that syntax.
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  get exhausted(): boolean {
    return this.#offset === this.#bytes.length;
  }

  raw(length: number): Uint8Array | undefined {
    if (length < 0 || this.remaining < length) return undefined;
    const out = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return out;
  }

  /** Reads and requires the exact ASCII tag. A different tag is a different object type and never decodes. */
  tag(expected: string): boolean {
    const bytes = this.raw(expected.length);
    if (bytes === undefined) return false;
    for (let i = 0; i < expected.length; i += 1) {
      if (bytes[i] !== expected.charCodeAt(i)) return false;
    }
    return true;
  }

  uint(byteLength: number): bigint | undefined {
    const bytes = this.raw(byteLength);
    if (bytes === undefined) return undefined;
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    return v;
  }

  u8(): bigint | undefined {
    return this.uint(1);
  }
  u16(): bigint | undefined {
    return this.uint(2);
  }
  u32(): bigint | undefined {
    return this.uint(4);
  }
  u64(): bigint | undefined {
    return this.uint(8);
  }
  u256(): bigint | undefined {
    return this.uint(32);
  }

  i64(): bigint | undefined {
    const raw = this.uint(8);
    if (raw === undefined) return undefined;
    return raw >= 1n << 63n ? raw - (1n << 64n) : raw;
  }

  str(): string | undefined {
    const length = this.u16();
    if (length === undefined) return undefined;
    const bytes = this.raw(Number(length));
    if (bytes === undefined) return undefined;
    try {
      return decoder.decode(bytes);
    } catch {
      // Invalid UTF-8. Fails closed rather than substituting replacement
      // characters, which would silently turn two byte strings into one value.
      return undefined;
    }
  }

  bytes32(): Uint8Array | undefined {
    const b = this.raw(32);
    return b === undefined ? undefined : new Uint8Array(b);
  }
}
