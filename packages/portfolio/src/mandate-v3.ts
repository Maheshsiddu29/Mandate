/**
 * Portfolio mandate authority V3: one EIP-712 signature that binds portfolio
 * authority and reusable delegated execution (docs/demo/c2-3-delegated-execution.md).
 *
 * V1 and V2 are unchanged. V3 is accepted only when the caller names
 * `{ scheme: 'V3_DELEGATED_EIP712', ... }`.
 *
 * ```text
 * EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
 *   name "Mandate", version "3", chainId, verifyingContract = MandateDelegatedExecutionGate
 *
 * DelegatedPortfolioAuthorizationV3(...)
 * ```
 *
 * This module verifies. It does not sign and holds no key.
 */

import {
  DELEGATED_PORTFOLIO_AUTHORIZATION_V3_TYPE,
  delegatedPortfolioAuthorizationHash,
  type DelegationFields,
} from '@mandate/execution-gate';
import { recoverSigner } from '@mandate/execution-gate';
import { portfolioMandateDigest, type PortfolioMandate } from './mandate.ts';

export const PORTFOLIO_AUTHORITY_V3 = 'V3_DELEGATED_EIP712' as const;

export interface PortfolioAuthorityV3 {
  readonly scheme: typeof PORTFOLIO_AUTHORITY_V3;
  readonly chainId: bigint;
  readonly verifyingContract: string;
  readonly sessionDigest: string;
  readonly initialAllocationDigest: string;
  readonly delegate: string;
  readonly agent: string;
  readonly representationIdHash: string;
  readonly fundingToken: string;
  readonly cumulativeDebitLimit: bigint;
  readonly validAfter: bigint;
  readonly validUntil: bigint;
  readonly generation: bigint;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

function normalizeSignature(signature: string): string | null {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  const lower = signature.toLowerCase();
  const v = Number.parseInt(lower.slice(130), 16);
  if (v === 0 || v === 1) return `${lower.slice(0, 130)}${(v + 27).toString(16)}`;
  if (v === 27 || v === 28) return lower;
  return null;
}

export function delegatedPortfolioFields(m: PortfolioMandate, a: PortfolioAuthorityV3): DelegationFields | null {
  if (m.principal.kind !== 'eip155-address' || !ADDRESS.test(m.principal.value)) return null;
  if (!ADDRESS.test(a.verifyingContract) || !ADDRESS.test(a.delegate) || !ADDRESS.test(a.agent) || !ADDRESS.test(a.fundingToken)) {
    return null;
  }
  if (!BYTES32.test(a.sessionDigest) || !BYTES32.test(a.initialAllocationDigest) || !BYTES32.test(a.representationIdHash)) {
    return null;
  }
  if (a.delegate === a.agent || a.delegate === m.principal.value || a.agent === m.principal.value) return null;
  if (a.cumulativeDebitLimit <= 0n || a.validUntil === 0n || a.validAfter >= a.validUntil) return null;
  return {
    portfolioMandateDigest: portfolioMandateDigest(m),
    initialAllocationDigest: a.initialAllocationDigest,
    sessionDigest: a.sessionDigest,
    principal: m.principal.value,
    delegate: a.delegate,
    agent: a.agent,
    representationIdHash: a.representationIdHash,
    fundingToken: a.fundingToken,
    cumulativeDebitLimit: a.cumulativeDebitLimit,
    validAfter: a.validAfter,
    validUntil: a.validUntil,
    generation: a.generation,
  };
}

/** EIP-712 digest the wallet signs for a V3 delegated portfolio authorization. */
export function portfolioMandateAuthorizationV3Hash(m: PortfolioMandate, a: PortfolioAuthorityV3): Uint8Array {
  const fields = delegatedPortfolioFields(m, a);
  if (fields === null) throw new Error('V3 authority fields malformed');
  return delegatedPortfolioAuthorizationHash(a.chainId, a.verifyingContract, fields);
}

/** Whether `signature` is the principal's V3 delegated authorization for this mandate and scope. */
export function mandateSignedByPrincipalV3(m: PortfolioMandate, signature: string, a: PortfolioAuthorityV3): boolean {
  if (m.principal.kind !== 'eip155-address') return false;
  const sig = normalizeSignature(signature);
  if (sig === null) return false;
  let hash: Uint8Array;
  try {
    hash = portfolioMandateAuthorizationV3Hash(m, a);
  } catch {
    return false;
  }
  return recoverSigner(hash, sig) === m.principal.value;
}

export type { DelegationFields };
