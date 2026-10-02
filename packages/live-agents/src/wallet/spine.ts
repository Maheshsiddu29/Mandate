/**
 * Mandate authority V2 (docs/demo/authority-spine-v2.md).
 *
 * The wallet signs `PortfolioMandateV2` — EIP-712, chain 46630, no
 * verifying contract — and that signature is the protocol signature. The
 * mandate's `principal` is the wallet. The B.5.3 approval, which the
 * demonstration key countersigns, is a different message and stays available.
 *
 * The hash is the portfolio package's. This module only builds the typed
 * data a wallet displays and the authority object the room is given.
 */

import { portfolioMandateAuthorizationV2Message, PORTFOLIO_AUTHORITY_V2_PLAN, type PortfolioAuthorityV2Plan, type PortfolioMandate } from '@mandate/portfolio';
import { APPROVAL_CHAIN_ID, sessionDigest } from './approval.ts';

export { APPROVAL_CHAIN_ID as SPINE_CHAIN_ID };

/** What the room and the verifier must be told for a V2 version. Absent means V1. */
export function spineAuthority(sessionId: string, initialAllocationDigest: string): PortfolioAuthorityV2Plan {
  return { scheme: PORTFOLIO_AUTHORITY_V2_PLAN, chainId: APPROVAL_CHAIN_ID, sessionDigest: sessionDigest(sessionId), initialAllocationDigest };
}

/** What the browser hands the wallet for `eth_signTypedData_v4`. */
export function spineTypedData(m: PortfolioMandate, sessionId: string, initialAllocationDigest: string): { readonly [k: string]: unknown } {
  const message = portfolioMandateAuthorizationV2Message(m, sessionDigest(sessionId), initialAllocationDigest);
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      PortfolioMandateAuthorizationV2: [
        { name: 'statement', type: 'string' },
        { name: 'mandateDigest', type: 'bytes32' },
        { name: 'principal', type: 'address' },
        { name: 'sessionDigest', type: 'bytes32' },
        { name: 'initialAllocationDigest', type: 'bytes32' },
      ],
    },
    primaryType: 'PortfolioMandateAuthorizationV2',
    domain: { name: 'Mandate', version: '2', chainId: Number(APPROVAL_CHAIN_ID) },
    message,
  };
}
