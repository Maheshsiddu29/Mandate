/**
 * Portfolio mandate authority V2: an EIP-712 signature by the mandate's own
 * principal (mandate-v2, docs/demo/authority-spine-v2.md).
 *
 * V1 (`mandateSignedByPrincipal`) is unchanged. It checks a raw prehash over
 * `PORTFOLIO_MANDATE_SIGNATURE.V1`, which a wallet cannot produce. V2 is a
 * different message, accepted only when the caller passes
 * `{ scheme: 'V2_EIP712', chainId, sessionDigest }`. A V2 signature does not
 * satisfy V1, and a V1 signature does not satisfy V2.
 *
 * ```text
 * EIP712Domain(string name,string version,uint256 chainId)
 *   name "Mandate", version "2", chainId supplied by the caller
 *   — no verifyingContract. The frozen gate's domain includes one, so this
 *     signature cannot be replayed as a gate MandateAuthorization.
 *
 * PortfolioMandateV2(string statement,bytes32 mandateDigest,address principal,bytes32 sessionDigest)
 * ```
 *
 * `mandateDigest` is `portfolioMandateDigest` — the canonical mandate, not a
 * second serialization. `principal` must be the mandate's own principal.
 * `sessionDigest` binds the signature to the live session that asked for it.
 * The statement is rebuilt from the mandate, so it cannot describe a
 * different authority than the digest commits to.
 *
 * This module verifies. It does not sign.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { recoverSigner } from '@mandate/execution-gate';
import { portfolioMandateDigest, type PortfolioMandate } from './mandate.ts';

export const PORTFOLIO_MANDATE_V2_NAME = 'Mandate';
export const PORTFOLIO_MANDATE_V2_VERSION = '2';
export const PORTFOLIO_MANDATE_V2_TYPE = 'PortfolioMandateV2(string statement,bytes32 mandateDigest,address principal,bytes32 sessionDigest)';
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId)';

export const PORTFOLIO_AUTHORITY_V1 = 'V1_PREHASH' as const;
export const PORTFOLIO_AUTHORITY_V2 = 'V2_EIP712' as const;

/** Named by a caller that still wants the V1 prehash check. Omitting authority means the same thing. */
export interface PortfolioAuthorityV1 {
  readonly scheme: typeof PORTFOLIO_AUTHORITY_V1;
}

/**
 * The V2 check. `chainId` is the EIP-712 domain's chain (the live path uses
 * Robinhood Chain testnet, 46630). `sessionDigest` is 32 lowercase bytes
 * bound into the signed struct.
 */
export interface PortfolioAuthorityV2 {
  readonly scheme: typeof PORTFOLIO_AUTHORITY_V2;
  readonly chainId: bigint;
  readonly sessionDigest: string;
}

export type PortfolioAuthority = PortfolioAuthorityV1 | PortfolioAuthorityV2;

export interface PortfolioMandateV2Message {
  readonly statement: string;
  readonly mandateDigest: string;
  readonly principal: string;
  readonly sessionDigest: string;
}

const utf8 = new TextEncoder();
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const MAX_CHAIN = 2n ** 256n - 1n;

function word(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesOf(h: string): Uint8Array {
  const body = h.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A fixed-form reading of the mandate. Rebuilt at every check; not a second authority. */
export function portfolioMandateV2Statement(m: PortfolioMandate): string {
  const limits = m.limits.map((l) => `${l.resource} ${l.atoms}`).join(', ');
  const agents = m.agents.map((a) => a.label).join(', ');
  return [
    `Authorize Mandate policy ${m.policyVersion} as protocol principal ${m.principal.value}.`,
    `Portfolio limits (atoms): ${limits === '' ? 'none' : limits}.`,
    `Agents: ${agents === '' ? 'none' : agents}.`,
    `Expires at protocol time ${m.expiresAt}.`,
    'This EIP-712 signature is the protocol principal signature of this portfolio mandate.',
    'It is not a blockchain transaction.',
    'Domain execution may proceed only when the signer is this same address.',
  ].join(' ');
}

/** The struct a wallet signs, rebuilt from the mandate and the session digest. */
export function portfolioMandateV2Message(m: PortfolioMandate, sessionDigest: string): PortfolioMandateV2Message {
  return {
    statement: portfolioMandateV2Statement(m),
    mandateDigest: portfolioMandateDigest(m),
    principal: m.principal.value,
    sessionDigest,
  };
}

function domainSeparator(chainId: bigint): Uint8Array {
  return keccak_256(concat([keccak_256(utf8.encode(DOMAIN_TYPE)), keccak_256(utf8.encode(PORTFOLIO_MANDATE_V2_NAME)), keccak_256(utf8.encode(PORTFOLIO_MANDATE_V2_VERSION)), word(chainId)]));
}

function structHash(message: PortfolioMandateV2Message): Uint8Array {
  return keccak_256(
    concat([
      keccak_256(utf8.encode(PORTFOLIO_MANDATE_V2_TYPE)),
      keccak_256(utf8.encode(message.statement)),
      bytesOf(message.mandateDigest),
      word(BigInt(message.principal)),
      bytesOf(message.sessionDigest),
    ]),
  );
}

/**
 * The 32 bytes `eth_signTypedData_v4` signs for this mandate, chain and
 * session. Throws when a field cannot be encoded: callers build it from a
 * validated mandate, never from an unchecked request.
 */
export function portfolioMandateV2Hash(m: PortfolioMandate, o: { readonly chainId: bigint; readonly sessionDigest: string }): Uint8Array {
  if (m.principal.kind !== 'eip155-address' || !ADDRESS.test(m.principal.value)) throw new Error('V2 principal must be a lowercase eip155 address');
  if (typeof o.chainId !== 'bigint' || o.chainId < 0n || o.chainId > MAX_CHAIN) throw new Error('V2 chain id out of range');
  if (!BYTES32.test(o.sessionDigest)) throw new Error('V2 session digest must be 32 lowercase bytes');
  const digest = portfolioMandateDigest(m);
  if (!BYTES32.test(digest)) throw new Error('mandate digest is not 32 lowercase bytes');
  const message = portfolioMandateV2Message(m, o.sessionDigest);
  return keccak_256(concat([new Uint8Array([0x19, 0x01]), domainSeparator(o.chainId), structHash(message)]));
}

/** `v` of 0 or 1 (some wallets) becomes 27 or 28. Anything else is refused. */
function normalizeSignature(signature: string): string | null {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  const lower = signature.toLowerCase();
  const v = Number.parseInt(lower.slice(130), 16);
  if (v === 0 || v === 1) return `${lower.slice(0, 130)}${(v + 27).toString(16)}`;
  if (v === 27 || v === 28) return lower;
  return null;
}

/**
 * Whether `signature` is the mandate principal's EIP-712 V2 signature for
 * exactly this mandate, chain and session. Total: a malformed signature,
 * a high-`s` encoding, a different chain or a different session is `false`.
 * It never accepts a V1 prehash signature.
 */
export function mandateSignedByPrincipalV2(m: PortfolioMandate, signature: string, o: { readonly chainId: bigint; readonly sessionDigest: string }): boolean {
  if (m.principal.kind !== 'eip155-address') return false;
  const sig = normalizeSignature(signature);
  if (sig === null) return false;
  let hash: Uint8Array;
  try {
    hash = portfolioMandateV2Hash(m, o);
  } catch {
    return false;
  }
  return recoverSigner(hash, sig) === m.principal.value;
}
