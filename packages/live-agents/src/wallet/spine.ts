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

import { portfolioMandateV2Message, PORTFOLIO_AUTHORITY_V2, type PortfolioAuthorityV2, type PortfolioMandate } from '@mandate/portfolio';
import { APPROVAL_CHAIN_ID, sessionDigest } from './approval.ts';

export { APPROVAL_CHAIN_ID as SPINE_CHAIN_ID };

/** What the room and the verifier must be told for a V2 version. Absent means V1. */
export function spineAuthority(sessionId: string): PortfolioAuthorityV2 {
  return { scheme: PORTFOLIO_AUTHORITY_V2, chainId: APPROVAL_CHAIN_ID, sessionDigest: sessionDigest(sessionId) };
}

/** What the browser hands the wallet for `eth_signTypedData_v4`. */
export function spineTypedData(m: PortfolioMandate, sessionId: string): { readonly [k: string]: unknown } {
  const message = portfolioMandateV2Message(m, sessionDigest(sessionId));
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      PortfolioMandateV2: [
        { name: 'statement', type: 'string' },
        { name: 'mandateDigest', type: 'bytes32' },
        { name: 'principal', type: 'address' },
        { name: 'sessionDigest', type: 'bytes32' },
      ],
    },
    primaryType: 'PortfolioMandateV2',
    domain: { name: 'Mandate', version: '2', chainId: Number(APPROVAL_CHAIN_ID) },
    message,
  };
}
