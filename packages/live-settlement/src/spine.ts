/**
 * Settlement-time re-verification of a Mandate authority V2 signature
 * (docs/demo/authority-spine-v2.md).
 *
 * Pure. The room already checked this signature when the version was
 * authorized. Settlement checks it again, from the stored mandate and
 * signature, and refuses every other authorization method. There is no
 * fallback onto the demonstration principal key.
 *
 * A passing check means the wallet is the protocol principal. It does not
 * make the portfolio signature into a gate signature, and it does not
 * require the wallet to equal the gitignored manifest principal. The frozen
 * gate still needs its own per-execution EIP-712, signed by this same
 * address (gate-authority.ts). A wallet that is the manifest principal may
 * still be signed by that key, because the key is that address.
 */

import { mandateSignedByPrincipalV2, type PortfolioMandate } from '@mandate/portfolio';
import { sessionDigest, type PrincipalAuthorization } from '@mandate/live-agents';

/** Robinhood Chain testnet. A V2 settlement on any other chain is refused. */
export const SPINE_CHAIN_ID = 46_630n;

export type SpineCheck = { readonly ok: true; readonly principal: string } | { readonly ok: false; readonly reason: string };

export interface SpineFacts {
  readonly mandate: PortfolioMandate;
  readonly signature: string;
  readonly authorization: PrincipalAuthorization;
  readonly sessionId: string;
  readonly chainId: bigint;
  /** Protocol time. The mandate's `expiresAt`, not the challenge window. */
  readonly now: bigint;
}

const fail = (reason: string): SpineCheck => ({ ok: false, reason });

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether this version may be settled as V2. Total: every mismatch is a
 * reason, and a passing result is the only one that names a principal.
 */
export function reverifySpine(f: SpineFacts): SpineCheck {
  const a = f.authorization;
  if (a.method !== 'WALLET_PRINCIPAL_V2') return fail('SPINE_METHOD_REQUIRED');
  if (f.chainId !== SPINE_CHAIN_ID) return fail('SPINE_CHAIN_MISMATCH');
  if (!sameAddress(a.protocolSigner, a.principal)) return fail('SPINE_SIGNER_SPLIT');
  if (a.domainDelegation !== 'SAME_PRINCIPAL') return fail('SPINE_DELEGATION_MISSTATED');
  if (f.mandate.principal.kind !== 'eip155-address' || !sameAddress(f.mandate.principal.value, a.principal)) return fail('SPINE_MANDATE_PRINCIPAL_MISMATCH');
  const bound = sessionDigest(f.sessionId);
  const wallet = a.wallet;
  if (wallet === null || wallet.chainId !== SPINE_CHAIN_ID.toString() || wallet.sessionDigest !== bound) return fail('SPINE_SIGNATURE_INVALID');
  if (!mandateSignedByPrincipalV2(f.mandate, f.signature, { chainId: SPINE_CHAIN_ID, sessionDigest: bound })) return fail('SPINE_SIGNATURE_INVALID');
  if (f.now >= f.mandate.expiresAt) return fail('SPINE_EXPIRED');
  return { ok: true, principal: a.principal };
}
