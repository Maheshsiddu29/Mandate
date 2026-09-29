/**
 * Test-only signing. Keys are derived from public labels
 * (`keccak("mandate-portfolio/test-key/" ‖ label)`), so they are published by
 * construction and secure nothing. The package itself exports no signing
 * operation; agents and principals sign outside it.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@mandate/core';

const utf8 = new TextEncoder();

export function testKey(label: string): string {
  return bytesToHex(keccak_256(utf8.encode(`mandate-portfolio/test-key/${label}`)));
}

export function addressOfKey(key: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(key), false);
  return bytesToHex(keccak_256(pub.subarray(1)).subarray(12));
}

/** 65-byte `r ‖ s ‖ v`, `v ∈ {27, 28}`, low `s`: the kernel's acceptance rule. */
export function signHash(hash: Uint8Array, key: string): string {
  const sig = secp256k1.sign(hash, hexToBytes(key), { prehash: false, format: 'recovered', lowS: true });
  const out = new Uint8Array(65);
  out.set(sig.subarray(1), 0);
  out[64] = (sig[0] as number) + 27;
  return bytesToHex(out);
}

export function party(key: string): { kind: string; value: string } {
  return { kind: 'eip155-address', value: addressOfKey(key) };
}
