/** Fixed-width byte values, carried as lowercase `0x`-prefixed hex. */

import { type Result, ok, err } from './result.ts';
import type { ReasonCodeName } from './reason-codes.ts';

declare const Bytes32Brand: unique symbol;
export type Bytes32 = string & { readonly [Bytes32Brand]: true };

const HEX32 = /^0x[0-9a-f]{64}$/;

/**
 * Lowercase only. An uppercase or mixed-case hex string is rejected rather than
 * normalized, so two spellings of one value can never both be accepted and then
 * disagree about equality (ADR 0002).
 */
export function parseBytes32(raw: unknown, code: ReasonCodeName): Result<Bytes32, ReasonCodeName> {
  if (typeof raw !== 'string' || !HEX32.test(raw)) return err(code);
  return ok(raw as Bytes32);
}

export function bytes32ToBytes(v: Bytes32): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(v.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = '0x';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(raw: string): Uint8Array | undefined {
  if (!/^0x([0-9a-f]{2})*$/.test(raw)) return undefined;
  const n = (raw.length - 2) / 2;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Number.parseInt(raw.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}
