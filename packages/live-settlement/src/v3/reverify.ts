/**
 * Settlement-time re-verification of a V3 delegated principal authorization.
 * Pure. Fail closed. Distinct from V2 `reverifySpine`.
 */

import { mandateSignedByPrincipalV3, type PortfolioMandate } from '@mandate/portfolio';
import { sessionDigest, type PrincipalAuthorization } from '@mandate/live-agents';

export const SPINE_V3_CHAIN_ID = 46_630n;

export type V3SpineCheck =
  | {
      readonly ok: true;
      readonly principal: string;
      readonly delegate: string;
      readonly verifyingContract: string;
      readonly cumulativeDebitLimit: bigint;
      readonly validAfter: bigint;
      readonly validUntil: bigint;
      readonly generation: bigint;
      readonly agent: string;
      readonly representationIdHash: string;
      readonly fundingToken: string;
      readonly initialAllocationDigest: string;
      readonly sessionDigest: string;
    }
  | { readonly ok: false; readonly reason: string };

export interface V3SpineFacts {
  readonly mandate: PortfolioMandate;
  readonly signature: string;
  readonly authorization: PrincipalAuthorization;
  readonly sessionId: string;
  readonly chainId: bigint;
  readonly now: bigint;
}

const fail = (reason: string): V3SpineCheck => ({ ok: false, reason });

export function reverifySpineV3(f: V3SpineFacts): V3SpineCheck {
  const a = f.authorization;
  if (a.method !== 'WALLET_PRINCIPAL_V3_DELEGATED') return fail('V3_SPINE_METHOD_REQUIRED');
  if (f.chainId !== SPINE_V3_CHAIN_ID) return fail('V3_SPINE_CHAIN_MISMATCH');
  if (a.domainDelegation !== 'BOUNDED_DELEGATE') return fail('V3_SPINE_DELEGATION_MISSTATED');
  if (a.protocolSigner.toLowerCase() !== a.principal.toLowerCase()) return fail('V3_SPINE_SIGNER_SPLIT');
  if (f.mandate.principal.kind !== 'eip155-address' || f.mandate.principal.value.toLowerCase() !== a.principal.toLowerCase()) {
    return fail('V3_SPINE_MANDATE_PRINCIPAL_MISMATCH');
  }
  const w = a.wallet;
  if (
    w === null
    || w.chainId !== SPINE_V3_CHAIN_ID.toString()
    || w.domain.verifyingContract === undefined
    || w.delegate === undefined
    || w.agent === undefined
    || w.representationIdHash === undefined
    || w.fundingToken === undefined
    || w.cumulativeDebitLimit === undefined
    || w.generation === undefined
    || w.initialAllocationDigest === undefined
  ) {
    return fail('V3_SPINE_SCOPE_INCOMPLETE');
  }
  const bound = sessionDigest(f.sessionId);
  if (w.sessionDigest !== bound) return fail('V3_SPINE_SESSION_MISMATCH');
  const authority = {
    scheme: 'V3_DELEGATED_EIP712' as const,
    chainId: SPINE_V3_CHAIN_ID,
    verifyingContract: w.domain.verifyingContract,
    sessionDigest: bound,
    initialAllocationDigest: w.initialAllocationDigest,
    delegate: w.delegate,
    agent: w.agent,
    representationIdHash: w.representationIdHash,
    fundingToken: w.fundingToken,
    cumulativeDebitLimit: BigInt(w.cumulativeDebitLimit),
    validAfter: BigInt(w.validAfter),
    validUntil: BigInt(w.validUntil),
    generation: BigInt(w.generation),
  };
  if (!mandateSignedByPrincipalV3(f.mandate, f.signature, authority)) return fail('V3_SPINE_SIGNATURE_INVALID');
  if (f.now >= f.mandate.expiresAt) return fail('V3_SPINE_MANDATE_EXPIRED');
  // Delegation validAfter/validUntil are chain-time bounds, checked at settlement
  // against the block timestamp — not against protocol time.
  return {
    ok: true,
    principal: a.principal,
    delegate: authority.delegate,
    verifyingContract: authority.verifyingContract,
    cumulativeDebitLimit: authority.cumulativeDebitLimit,
    validAfter: authority.validAfter,
    validUntil: authority.validUntil,
    generation: authority.generation,
    agent: authority.agent,
    representationIdHash: authority.representationIdHash,
    fundingToken: authority.fundingToken,
    initialAllocationDigest: authority.initialAllocationDigest,
    sessionDigest: authority.sessionDigest,
  };
}
