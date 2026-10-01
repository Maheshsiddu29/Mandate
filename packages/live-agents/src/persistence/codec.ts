/**
 * Tagged JSON for durable session records.
 *
 * Protocol objects carry `bigint`, `Uint8Array` and `Map` values that plain
 * JSON cannot hold. This codec writes them as single-key tagged objects and
 * reads them back exactly; anything it does not recognise is a corruption,
 * never a guess. It is *evidence* storage: whatever is read back is
 * re-derived and re-checked by the protocol before it can matter (a restored
 * reservation is re-verified against the committed ledger and the frozen
 * verifier before any key is used).
 */

export class RecordCorruption extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordCorruption';
  }
}

type Tagged = { readonly $big: string } | { readonly $bytes: string } | { readonly $map: readonly (readonly [unknown, unknown])[] };

function encodeValue(v: unknown): unknown {
  if (typeof v === 'bigint') return { $big: v.toString() };
  if (v instanceof Uint8Array) return { $bytes: `0x${Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')}` };
  if (v instanceof Map) return { $map: [...v.entries()].map(([k, x]) => [encodeValue(k), encodeValue(x)]) };
  if (Array.isArray(v)) return v.map(encodeValue);
  if (v !== null && typeof v === 'object') {
    const out: { [k: string]: unknown } = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('$')) throw new RecordCorruption(`refusing to encode a reserved key: ${k}`);
      if (x !== undefined) out[k] = encodeValue(x);
    }
    return out;
  }
  if (typeof v === 'function' || typeof v === 'symbol') throw new RecordCorruption(`cannot encode a ${typeof v}`);
  return v;
}

function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeValue);
  if (v === null || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  if (keys.some((k) => k.startsWith('$'))) {
    if (keys.length !== 1) throw new RecordCorruption('a tagged value has other keys');
    const t = v as Tagged;
    if ('$big' in t) {
      if (typeof t.$big !== 'string' || !/^-?\d{1,80}$/.test(t.$big)) throw new RecordCorruption('bad $big');
      return BigInt(t.$big);
    }
    if ('$bytes' in t) {
      if (typeof t.$bytes !== 'string' || !/^0x([0-9a-f]{2})*$/.test(t.$bytes)) throw new RecordCorruption('bad $bytes');
      const body = t.$bytes.slice(2);
      const out = new Uint8Array(body.length / 2);
      for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    if ('$map' in t) {
      if (!Array.isArray(t.$map)) throw new RecordCorruption('bad $map');
      return new Map(t.$map.map((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2) throw new RecordCorruption('bad $map entry');
        return [decodeValue(pair[0]), decodeValue(pair[1])] as const;
      }));
    }
    throw new RecordCorruption(`unknown tag ${keys[0] ?? ''}`);
  }
  const out: { [k: string]: unknown } = {};
  for (const [k, x] of Object.entries(v)) out[k] = decodeValue(x);
  return out;
}

export function encodeRecord(v: unknown): string {
  return JSON.stringify(encodeValue(v));
}

/** The decoded value. Its type is asserted by the caller, which re-checks it against the protocol before use. */
export function decodeRecord<T>(text: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RecordCorruption('not JSON');
  }
  return decodeValue(parsed) as T;
}
