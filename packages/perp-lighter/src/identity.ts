/**
 * Identities the Lighter adapter derives, never the agent (Phase 7E.1).
 *
 * - **Client order index.** Derived from the reservation id, so the policy can
 *   recognize the orders its own pending reservations placed (and treat any
 *   other open order as foreign), and a cancel can name its target by
 *   reservation rather than by a venue index the agent chose. It is a lookup
 *   key only: Lighter's uniqueness scope for it is undocumented (L-ORD-9), so
 *   nothing depends on the venue rejecting a duplicate.
 * - **Artifact identity.** The venue's own transaction hash — Poseidon2 over
 *   every signed field, computable before any signature exists (L-TX-3; its
 *   reproduction from real testnet transactions is recorded in
 *   testnet-evidence.md). 40 bytes.
 * - **Venue slot.** One nonce of one API key on one account (L-TX-4): the
 *   replay domain in which at most one transaction ever executes.
 */

import { keccakDigest, writeDigest, type ReservationId } from '@mandate/core';
import { ByteWriter } from '@mandate/kernel';

/** Lighter's client order index range: 1 … 2^48 − 1 (lighter-go `MaxClientOrderIndex`). */
const CLIENT_ORDER_SPACE = (1n << 47n) - 1n;

export function clientOrderIndexFor(reservation: ReservationId): bigint {
  const w = new ByteWriter().str('mandate/perp-lighter/client-order-index').u16(1);
  writeDigest(w, reservation);
  const h = BigInt(keccakDigest(w.finish()));
  return 1n + (h % CLIENT_ORDER_SPACE);
}

export const ARTIFACT_KIND = 'lighter.l2-tx-hash';

/** The ledger's venue-slot scope for one signer key: `lighter:<chain>:account:<index>:key:<apiKeyIndex>`. */
export function slotScope(chainId: number, accountIndex: bigint, apiKeyIndex: number): string {
  return `lighter:${chainId}:account:${accountIndex}:key:${apiKeyIndex}`;
}

/** A 40-byte Lighter transaction hash, from its 80-character hex form. */
export function txHashBytes(hex: string): Uint8Array | null {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-f]{80}$/.test(h)) return null;
  const out = new Uint8Array(40);
  for (let i = 0; i < 40; i += 1) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
