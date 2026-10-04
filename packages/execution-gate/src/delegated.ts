/**
 * TypeScript reference model for C2.3 `MandateDelegatedExecutionGate`.
 *
 * Digests and the EIP-712 domain must match Solidity byte-for-byte. Cumulative
 * debit / nonce / revoke / expiry accounting mirrors the onchain state machine
 * without re-interpreting portfolio business policy.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, type Bytes32 } from '@mandate/kernel';
import type { Address } from './wire.ts';

const utf8 = new TextEncoder();

export const DELEGATED_GATE_NAME = 'Mandate';
export const DELEGATED_GATE_VERSION = '3';

export const DELEGATED_PORTFOLIO_AUTHORIZATION_V3_TYPE =
  'DelegatedPortfolioAuthorizationV3(bytes32 portfolioMandateDigest,bytes32 initialAllocationDigest,bytes32 sessionDigest,address principal,address delegate,address agent,bytes32 representationIdHash,address fundingToken,uint256 cumulativeDebitLimit,uint64 validAfter,uint64 validUntil,uint64 generation)';

export const DELEGATED_EXECUTION_APPROVAL_TYPE =
  'DelegatedExecutionApproval(bytes32 delegationDigest,bytes32 mandateDigest,bytes32 candidateDigest,address recipient,uint256 fundingLimit,uint64 deadline,bytes32 executionDataHash,uint64 executionNonce)';

export const EXECUTION_AUTHORIZATION_TYPE =
  'ExecutionAuthorization(bytes32 mandateDigest,bytes32 candidateDigest,address recipient,uint256 fundingLimit,uint64 deadline,bytes executionData)';

const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

export interface DelegationFields {
  readonly portfolioMandateDigest: Bytes32;
  readonly initialAllocationDigest: Bytes32;
  readonly sessionDigest: Bytes32;
  readonly principal: Address;
  readonly delegate: Address;
  readonly agent: Address;
  readonly representationIdHash: Bytes32;
  readonly fundingToken: Address;
  readonly cumulativeDebitLimit: bigint;
  readonly validAfter: bigint;
  readonly validUntil: bigint;
  readonly generation: bigint;
}

export interface DelegatedExecutionApprovalFields {
  readonly delegationDigest: Bytes32;
  readonly mandateDigest: Bytes32;
  readonly candidateDigest: Bytes32;
  readonly recipient: Address;
  readonly fundingLimit: bigint;
  readonly deadline: bigint;
  readonly executionDataHash: Bytes32;
  readonly executionNonce: bigint;
}

export interface DelegatedGateState {
  readonly usedDebit: ReadonlyMap<string, bigint>;
  readonly usedNonce: ReadonlyMap<string, ReadonlySet<bigint>>;
  readonly revoked: ReadonlySet<string>;
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

function addressWord(a: Address): Uint8Array {
  return word(BigInt(a));
}

export function delegatedDomainSeparator(chainId: bigint, gate: Address): Bytes32 {
  return bytesToHex(
    keccak_256(
      concat([
        keccak_256(utf8.encode(DOMAIN_TYPE)),
        keccak_256(utf8.encode(DELEGATED_GATE_NAME)),
        keccak_256(utf8.encode(DELEGATED_GATE_VERSION)),
        word(chainId),
        addressWord(gate),
      ]),
    ),
  ) as Bytes32;
}

export function delegationStructHash(d: DelegationFields): Bytes32 {
  return bytesToHex(
    keccak_256(
      concat([
        keccak_256(utf8.encode(DELEGATED_PORTFOLIO_AUTHORIZATION_V3_TYPE)),
        bytes(d.portfolioMandateDigest),
        bytes(d.initialAllocationDigest),
        bytes(d.sessionDigest),
        addressWord(d.principal),
        addressWord(d.delegate),
        addressWord(d.agent),
        bytes(d.representationIdHash),
        addressWord(d.fundingToken),
        word(d.cumulativeDebitLimit),
        word(d.validAfter),
        word(d.validUntil),
        word(d.generation),
      ]),
    ),
  ) as Bytes32;
}

/** EIP-712 digest the principal signs (eth_signTypedData_v4). */
export function delegatedPortfolioAuthorizationHash(chainId: bigint, gate: Address, d: DelegationFields): Uint8Array {
  return keccak_256(concat([new Uint8Array([0x19, 0x01]), bytes(delegatedDomainSeparator(chainId, gate)), bytes(delegationStructHash(d))]));
}

export function delegatedExecutionApprovalStructHash(f: DelegatedExecutionApprovalFields): Bytes32 {
  return bytesToHex(
    keccak_256(
      concat([
        keccak_256(utf8.encode(DELEGATED_EXECUTION_APPROVAL_TYPE)),
        bytes(f.delegationDigest),
        bytes(f.mandateDigest),
        bytes(f.candidateDigest),
        addressWord(f.recipient),
        word(f.fundingLimit),
        word(f.deadline),
        bytes(f.executionDataHash),
        word(f.executionNonce),
      ]),
    ),
  ) as Bytes32;
}

export function delegatedExecutionApprovalHash(
  chainId: bigint,
  gate: Address,
  f: DelegatedExecutionApprovalFields,
): Uint8Array {
  return keccak_256(
    concat([new Uint8Array([0x19, 0x01]), bytes(delegatedDomainSeparator(chainId, gate)), bytes(delegatedExecutionApprovalStructHash(f))]),
  );
}

export type DelegatedCheck =
  | { readonly ok: true; readonly next: DelegatedGateState; readonly usedAfter: bigint }
  | { readonly ok: false; readonly reason: string };

/** Pure accounting check mirroring onchain CEI for one successful measured debit. */
export function applyDelegatedExecution(
  state: DelegatedGateState,
  d: DelegationFields,
  delegationDigest: Bytes32,
  executionNonce: bigint,
  measuredDebit: bigint,
  now: bigint,
): DelegatedCheck {
  if (d.principal === d.delegate || d.delegate === d.agent || d.agent === d.principal) {
    return { ok: false, reason: 'InvalidDelegationParties' };
  }
  if (d.cumulativeDebitLimit === 0n || d.validUntil === 0n || d.validAfter >= d.validUntil) {
    return { ok: false, reason: 'InvalidDelegationParties' };
  }
  if (state.revoked.has(delegationDigest)) return { ok: false, reason: 'DelegationRevoked' };
  if (now < d.validAfter) return { ok: false, reason: 'DelegationNotYetValid' };
  if (now >= d.validUntil) return { ok: false, reason: 'DelegationExpired' };
  const nonces = state.usedNonce.get(delegationDigest);
  if (nonces?.has(executionNonce)) return { ok: false, reason: 'ExecutionNonceAlreadyUsed' };
  const used = state.usedDebit.get(delegationDigest) ?? 0n;
  if (used + measuredDebit > d.cumulativeDebitLimit) {
    return { ok: false, reason: 'CumulativeDebitExceeded' };
  }
  const nextNonces = new Map(state.usedNonce);
  const set = new Set(nonces);
  set.add(executionNonce);
  nextNonces.set(delegationDigest, set);
  const nextUsed = new Map(state.usedDebit);
  nextUsed.set(delegationDigest, used + measuredDebit);
  return {
    ok: true,
    next: { usedDebit: nextUsed, usedNonce: nextNonces, revoked: state.revoked },
    usedAfter: used + measuredDebit,
  };
}

export function revokeDelegationState(state: DelegatedGateState, delegationDigest: Bytes32): DelegatedGateState {
  const revoked = new Set(state.revoked);
  revoked.add(delegationDigest);
  return { usedDebit: state.usedDebit, usedNonce: state.usedNonce, revoked };
}

export const EMPTY_DELEGATED_STATE: DelegatedGateState = {
  usedDebit: new Map(),
  usedNonce: new Map(),
  revoked: new Set(),
};

/** Fixed vectors cross-checked against Solidity typehashes (`cast keccak`). */
export const DELEGATED_VECTORS = {
  typehashes: {
    delegatedPortfolioAuthorizationV3: '0xa54b57fbba9f253cdee6e6c3595165744ff1af29341f40facc1cb5d068b35030',
    delegatedExecutionApproval: '0x0a5f95fb570353a46719f623ab46e6585b777292413f4f7c4e60dceada9d9ee2',
    executionAuthorization: '0x9183b4e31f33f64c62998b961f9c5a14f75251a70d3858db0adedbdf4aaf9431',
  },
  sample: {
    chainId: 46_630n,
    gate: '0xa0cb889707d426a7a386870a03bc70d1b0697598' as Address,
    delegation: {
      portfolioMandateDigest: '0x0000000000000000000000000000000000000000000000000000000000000b01',
      initialAllocationDigest: '0x0000000000000000000000000000000000000000000000000000000000000a11',
      sessionDigest: '0x00000000000000000000000000000000000000000000000000000000000005e5',
      principal: '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23',
      delegate: '0x88f9b82462f6c4bf4a0fb15e5c3971559a316e7f',
      agent: '0x63fac9201494f0bd17b9892b9fae4d52fe3bd377',
      representationIdHash: '0xce0c192a14407b7fe100bc6b7d17452737f621c5113ff0d6ee9c57350d908623',
      fundingToken: '0x2e234dae75c793f67a35089c9d99245e1c58470b',
      cumulativeDebitLimit: 10_000_000_000n,
      validAfter: 1_799_999_940n,
      validUntil: 1_800_003_600n,
      generation: 1n,
    } satisfies DelegationFields,
    /** Struct hash observed from Forge for the sample delegation shape in unit tests. */
    delegationStructHash: '0x5094f1e292418a4e60a29999e163875008398a3ea38bf3e0324a0ebc8b2a692b' as Bytes32,
  },
} as const;
