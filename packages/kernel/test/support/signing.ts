/**
 * Test-only signing helper.
 *
 * The kernel verifies signatures; it never produces them, because producing one
 * requires a secret and the kernel must never touch signing material. This
 * helper lives in the test tree for that reason and is not exported from the
 * package.
 *
 * The key below is a fixed, published test key. It secures nothing.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, eip712SigningHash, type Bytes32, type Eip712Domain } from '../../src/index.ts';

export const TEST_PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
export const TEST_PRIVATE_KEY_2 = '0x8da4ef21b864d2cc526dbdb2a120bd2874c36c9d0a1fb7f8c63d7f7a8b41de8f';

export const TEST_DOMAIN: Eip712Domain = {
  name: 'Mandate',
  version: '1',
  chainId: 42161n,
  verifyingContract: '0x0000000000000000000000000000000000000001',
};

export function addressOf(privateKeyHex: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(privateKeyHex) as Uint8Array, false);
  return bytesToHex(keccak_256(pub.subarray(1)).subarray(12));
}

/** Sign an arbitrary 32-byte hash, returning 65-byte `r ‖ s ‖ v` with v in {27, 28}. */
export function signHash(hash: Uint8Array, privateKeyHex: string): string {
  const sig = secp256k1.sign(hash, hexToBytes(privateKeyHex) as Uint8Array, { prehash: false, format: 'recovered' });
  // noble's `recovered` format is v ‖ r ‖ s with v in {0, 1}; Ethereum uses
  // r ‖ s ‖ v with v in {27, 28}.
  const out = new Uint8Array(65);
  out.set(sig.subarray(1), 0);
  out[64] = (sig[0] as number) + 27;
  return bytesToHex(out);
}

export function signMandateDigest(
  mandateDigest: Bytes32,
  privateKeyHex: string,
  domain: Eip712Domain = TEST_DOMAIN,
): string {
  return signHash(eip712SigningHash(domain, mandateDigest), privateKeyHex);
}

export function envelopeFor(
  mandateDigest: Bytes32,
  privateKeyHex: string,
  domain: Eip712Domain = TEST_DOMAIN,
): Record<string, unknown> {
  return {
    scheme: 'eip712-secp256k1',
    signer: { kind: 'eip155-address', value: addressOf(privateKeyHex) },
    signature: signMandateDigest(mandateDigest, privateKeyHex, domain),
    domain: { ...domain },
  };
}
