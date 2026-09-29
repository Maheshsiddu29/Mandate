/**
 * Demonstration keys. **Published by construction; they secure nothing.**
 *
 * Every key is `keccak("mandate-portfolio/demo-key/" ‖ role)`: anyone can
 * derive it, which is the point — the demonstration must be reproducible byte
 * for byte, and no key here may ever hold value. Signing lives only in the
 * demonstration: the package itself verifies and never signs.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, type PartyIdInput } from '@mandate/core';

const utf8 = new TextEncoder();

export const DEMO_ROLES = ['principal', 'stock', 'swap', 'nft', 'yield', 'perps', 'outsider'] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];

export function demoKey(role: string): string {
  return bytesToHex(keccak_256(utf8.encode(`mandate-portfolio/demo-key/${role}`)));
}

export function addressOfKey(key: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(key), false);
  return bytesToHex(keccak_256(pub.subarray(1)).subarray(12));
}

export function demoParty(role: string): PartyIdInput {
  return { kind: 'eip155-address', value: addressOfKey(demoKey(role)) };
}

/** 65-byte `r ‖ s ‖ v`, `v ∈ {27, 28}`, low `s` — the kernel's acceptance rule. Deterministic (RFC 6979). */
export function signPrehash(hash: Uint8Array, key: string): string {
  const sig = secp256k1.sign(hash, hexToBytes(key), { prehash: false, format: 'recovered', lowS: true });
  const out = new Uint8Array(65);
  out.set(sig.subarray(1), 0);
  out[64] = (sig[0] as number) + 27;
  return bytesToHex(out);
}
