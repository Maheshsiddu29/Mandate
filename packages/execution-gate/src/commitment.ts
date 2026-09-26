/**
 * The execution commitment: what the agent signs and the gate records.
 *
 * Commitment hierarchy (docs/execution-gate.md §3):
 *
 *     executionCommitment = hashStruct(ExecutionAuthorization{
 *         mandateDigest     MCE v2: principal, agent, asset, side, both economic
 *                           bounds, allowlists, validity window, nonce
 *         candidateDigest   Candidate V3: representationId (and through the gate's
 *                           immutable market table: token, adapter, funding token,
 *                           issuer, venue), side, quantity, agent, state provenance
 *         recipient         the only execution field not otherwise bound
 *         fundingLimit      the agent's spend cap (BUY) or proceeds floor (SELL)
 *         deadline          the agent's chain-time deadline
 *         executionData     venue route data, by hash
 *     })
 *
 * signed under the EIP-712 domain `{Mandate, 1, chainId, gate}` (ADR 0001), so
 * chain and contract are bound by the domain rather than restated.
 *
 * Nothing that is already committed transitively is restated. The token, adapter
 * and funding asset are functions of `candidateDigest` and the gate address; the
 * side and quantity are inside `candidateDigest`; the principal, agent and
 * bounds are inside `mandateDigest`. Restating them would create a second
 * encoding of one fact that could disagree with the first.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, domainSeparator, hexToBytes, type Bytes32, type Eip712Domain } from '@mandate/kernel';
import type { Address, GateTerms } from './wire.ts';

const utf8 = new TextEncoder();

export const EXECUTION_AUTHORIZATION_TYPE =
  'ExecutionAuthorization(bytes32 mandateDigest,bytes32 candidateDigest,address recipient,uint256 fundingLimit,uint64 deadline,bytes executionData)';

/** The ADR 0001 domain as the gate at `gate` on `chainId` computes it. */
export function gateDomain(chainId: bigint, gate: Address): Eip712Domain {
  return { name: 'Mandate', version: '1', chainId, verifyingContract: gate };
}

/** `eip155:<decimal>` — the kernel's chain identifier for an EVM chain. */
export function caip2(chainId: bigint): string {
  return `eip155:${chainId.toString(10)}`;
}

/** `eip155:<decimal>/erc20:<lowercase address>` — the registry's representation identifier. */
export function representationIdFor(chainId: bigint, token: Address): string {
  return `${caip2(chainId)}/erc20:${token}`;
}

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
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function bytes(hex: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b === undefined) throw new Error(`not lowercase hex: ${hex}`);
  return b;
}

export interface ExecutionAuthorizationFields {
  readonly mandateDigest: Bytes32;
  readonly candidateDigest: Bytes32;
  readonly terms: GateTerms;
}

/** `hashStruct(ExecutionAuthorization)` — the value `executionCommitmentOf` returns after settlement. */
export function executionCommitment(fields: ExecutionAuthorizationFields): Bytes32 {
  const { terms } = fields;
  return bytesToHex(
    keccak_256(
      concat([
        keccak_256(utf8.encode(EXECUTION_AUTHORIZATION_TYPE)),
        bytes(fields.mandateDigest),
        bytes(fields.candidateDigest),
        word(BigInt(terms.recipient)),
        word(terms.fundingLimit),
        word(terms.deadline),
        keccak_256(bytes(terms.executionData)),
      ]),
    ),
  ) as Bytes32;
}

/** `keccak256(0x1901 ‖ domainSeparator ‖ structHash)` — the bytes an EIP-712 signer signs. */
export function eip712Hash(domain: Eip712Domain, structHash: Bytes32): Uint8Array {
  return keccak_256(concat([new Uint8Array([0x19, 0x01]), domainSeparator(domain), bytes(structHash)]));
}
