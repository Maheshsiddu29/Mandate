/**
 * EIP-712 typed-data hashing for the `eip712-secp256k1` authorization scheme
 * (ADR 0001).
 *
 * The struct signed is deliberately minimal:
 *
 *     MandateAuthorization(bytes32 mandateDigest)
 *
 * It restates nothing from the mandate, because two encodings of one object can
 * disagree and a safety gate that can disagree with itself is a vulnerability.
 * The mandate digest is the whole commitment.
 *
 * The domain — `name`, `version`, `chainId`, `verifyingContract` — lives here
 * and never enters the mandate digest. It describes where a signature is
 * accepted, not what was financially authorized. Which chain an execution may
 * use is decided by the mandate's `allowedChains` and nothing else.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { type Result, ok, err } from '../result.ts';
import type { ReasonCodeName } from '../reason-codes.ts';
import { bytesToHex, hexToBytes, type Bytes32 } from '../bytes.ts';
import { parseBigInt } from '../time.ts';

const utf8 = new TextEncoder();

export interface Eip712Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId: bigint;
  /** Lowercase `0x`-prefixed 20-byte address. */
  readonly verifyingContract: string;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
export const MANDATE_AUTHORIZATION_TYPE = 'MandateAuthorization(bytes32 mandateDigest)';

export function parseEip712Domain(raw: unknown): Result<Eip712Domain, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_AUTHORIZATION');
  const r = raw as Record<string, unknown>;
  const name = r['name'];
  const version = r['version'];
  const verifyingContract = r['verifyingContract'];
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) return err('MALFORMED_AUTHORIZATION');
  if (typeof version !== 'string' || version.length === 0 || version.length > 32) return err('MALFORMED_AUTHORIZATION');
  if (typeof verifyingContract !== 'string' || !ADDRESS_RE.test(verifyingContract)) return err('MALFORMED_AUTHORIZATION');
  const chainId = parseBigInt(r['chainId']);
  if (chainId === undefined || chainId < 0n || chainId > 2n ** 256n - 1n) return err('MALFORMED_AUTHORIZATION');
  return ok({ name, version, chainId, verifyingContract });
}

export function eip712DomainEquals(a: Eip712Domain, b: Eip712Domain): boolean {
  return (
    a.name === b.name &&
    a.version === b.version &&
    a.chainId === b.chainId &&
    a.verifyingContract === b.verifyingContract
  );
}

/** `abi.encode` word: a 32-byte big-endian left-padded value. */
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
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function domainSeparator(domain: Eip712Domain): Uint8Array {
  return keccak_256(
    concat([
      keccak_256(utf8.encode(EIP712_DOMAIN_TYPE)),
      keccak_256(utf8.encode(domain.name)),
      keccak_256(utf8.encode(domain.version)),
      word(domain.chainId),
      word(BigInt(domain.verifyingContract)),
    ]),
  );
}

export function mandateAuthorizationStructHash(mandateDigest: Bytes32): Uint8Array {
  const digestBytes = hexToBytes(mandateDigest);
  // Unreachable for a parsed Bytes32; kept so a hand-built value cannot hash as zero.
  if (digestBytes === undefined || digestBytes.length !== 32) throw new Error('mandateDigest must be 32 bytes');
  return keccak_256(concat([keccak_256(utf8.encode(MANDATE_AUTHORIZATION_TYPE)), digestBytes]));
}

/** `keccak256(0x19 || 0x01 || domainSeparator || structHash)` — the bytes a wallet actually signs. */
export function eip712SigningHash(domain: Eip712Domain, mandateDigest: Bytes32): Uint8Array {
  return keccak_256(
    concat([new Uint8Array([0x19, 0x01]), domainSeparator(domain), mandateAuthorizationStructHash(mandateDigest)]),
  );
}

export function eip712SigningHashHex(domain: Eip712Domain, mandateDigest: Bytes32): string {
  return bytesToHex(eip712SigningHash(domain, mandateDigest));
}
