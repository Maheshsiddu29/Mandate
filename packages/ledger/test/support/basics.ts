/**
 * Deterministic basics for ledger tests: digests of readable labels, fixed
 * parties and times, and a seeded PRNG. Nothing here is random at run time or
 * a claim about any real venue, token or module.
 */

import { keccakDigest, validatePrincipalId, type CoreResult, type PartyIdInput, type PrincipalId } from '@mandate/core';
import type { LedgerResult } from '../../src/errors.ts';

const utf8 = new TextEncoder();

export function digestOf(label: string): string {
  return keccakDigest(utf8.encode(label));
}

export function must<T>(r: CoreResult<T> | LedgerResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error, (_, v: bigint | string) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r.value;
}

// --- Parties ---------------------------------------------------------------------

export function address(byte: string): PartyIdInput {
  return { kind: 'eip155-address', value: `0x${byte.repeat(20)}` };
}

export const P = address('11');
export const P2 = address('12');
export const TRADING = address('21');
export const SPOT_AGENT = address('23');
export const PERP_AGENT = address('22');
export const AGENT_A = address('31');
export const AGENT_B = address('32');
export const AGENT_C = address('33');
export const OUTSIDER = address('99');

export const PRINCIPAL: PrincipalId = must(validatePrincipalId(P, 'p'));
export const PRINCIPAL_2: PrincipalId = must(validatePrincipalId(P2, 'p'));

// --- Time ------------------------------------------------------------------------

export const T0 = 1_790_812_800n; // 2026-10-01T00:00:00Z
export const T_END = 1_798_761_600n; // 2027-01-01T00:00:00Z
export const DAY = 86_400n;

// --- Seeded randomness -----------------------------------------------------------

/** mulberry32: small, fast, and reproducible from a 32-bit seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

export function int(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** Resolve after `n` turns of the event loop, so concurrent tasks interleave. */
export async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
