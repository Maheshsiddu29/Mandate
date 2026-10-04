/**
 * Mandate authority V3 typed data for the browser wallet.
 *
 * Builds display/signing payloads only. Digest verification lives in
 * `@mandate/portfolio` (`mandate-v3.ts`). The ephemeral delegate key and
 * fixture-cap derivation live in `@mandate/live-settlement` — this package
 * must not import those.
 */

import { portfolioMandateDigest, type PortfolioMandate } from '@mandate/portfolio';
import { APPROVAL_CHAIN_ID, sessionDigest } from './approval.ts';

export { APPROVAL_CHAIN_ID as SPINE_V3_CHAIN_ID };

export interface V3DelegationScope {
  readonly verifyingContract: string;
  readonly delegate: string;
  readonly agent: string;
  readonly representationIdHash: string;
  readonly fundingToken: string;
  /** Fixture MDUSD atoms — derived outside this package; never model-supplied. */
  readonly cumulativeDebitLimit: string;
  readonly validAfter: string;
  readonly validUntil: string;
  readonly generation: string;
}

/** Typed data for `eth_signTypedData_v4` — exactly one Mandate signature for V3. */
export function spineTypedDataV3(
  m: PortfolioMandate,
  sessionId: string,
  initialAllocationDigest: string,
  scope: V3DelegationScope,
): { readonly [k: string]: unknown } {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      DelegatedPortfolioAuthorizationV3: [
        { name: 'portfolioMandateDigest', type: 'bytes32' },
        { name: 'initialAllocationDigest', type: 'bytes32' },
        { name: 'sessionDigest', type: 'bytes32' },
        { name: 'principal', type: 'address' },
        { name: 'delegate', type: 'address' },
        { name: 'agent', type: 'address' },
        { name: 'representationIdHash', type: 'bytes32' },
        { name: 'fundingToken', type: 'address' },
        { name: 'cumulativeDebitLimit', type: 'uint256' },
        { name: 'validAfter', type: 'uint64' },
        { name: 'validUntil', type: 'uint64' },
        { name: 'generation', type: 'uint64' },
      ],
    },
    primaryType: 'DelegatedPortfolioAuthorizationV3',
    domain: {
      name: 'Mandate',
      version: '3',
      chainId: Number(APPROVAL_CHAIN_ID),
      verifyingContract: scope.verifyingContract,
    },
    message: {
      portfolioMandateDigest: portfolioMandateDigest(m),
      initialAllocationDigest,
      sessionDigest: sessionDigest(sessionId),
      principal: m.principal.value,
      delegate: scope.delegate,
      agent: scope.agent,
      representationIdHash: scope.representationIdHash,
      fundingToken: scope.fundingToken,
      cumulativeDebitLimit: scope.cumulativeDebitLimit,
      validAfter: scope.validAfter,
      validUntil: scope.validUntil,
      generation: scope.generation,
    },
  };
}
