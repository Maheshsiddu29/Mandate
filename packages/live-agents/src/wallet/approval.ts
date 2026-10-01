/**
 * The principal's wallet approval of one exact portfolio mandate
 * (docs/demo/wallet-settlement-boundaries.md §3).
 *
 * What a wallet signs with `eth_signTypedData_v4`:
 *
 * ```text
 * EIP712Domain(string name,string version,uint256 chainId)
 *   name "Mandate" · version "1" · chainId = the Live AI environment's chain (46630, Robinhood Chain testnet)
 *   — no verifyingContract: no contract verifies this signature, and naming an unrelated one would claim otherwise.
 *
 * PortfolioMandateApproval(
 *   string  statement        a fixed-form summary rebuilt by the server from the mandate itself
 *   string  environment      "robinhood-chain-testnet"
 *   bytes32 mandateDigest    portfolioMandateDigest(m): the canonical PORTFOLIO_MANDATE.V1 digest, the whole commitment
 *   uint64  mandateVersion   V<n> in this session
 *   address principal        the wallet address that must recover from the signature
 *   address protocolSigner   the demonstration key that countersigns the mandate for the frozen verifier
 *   uint64  validAfter       wall-clock unix seconds: the challenge's issue time
 *   uint64  validUntil       wall-clock unix seconds: the challenge's expiry
 *   bytes32 sessionDigest    keccak256("mandate-live-session/v1:" ‖ sessionId)
 *   bytes32 challenge        32 random bytes the server issued for this approval, once
 * )
 * ```
 *
 * The message restates nothing the digest does not already commit to except
 * the statement, which exists so the person signing can read what they
 * approve; the server rebuilds it from the mandate, so it cannot say anything
 * the mandate does not. Every field is rebuilt from server state at
 * verification; the browser supplies only the signature.
 *
 * This is a runtime authorization boundary, verified by this server. It is
 * not the frozen Portfolio Verifier's principal signature (which a wallet
 * cannot produce: it signs a raw prehash), and it is **not** a delegation of
 * domain execution authority: the onchain gate still needs its own
 * principal signature per execution.
 */

import { portfolioMandateDigest, type PortfolioMandate } from '@mandate/portfolio';
import { usdcText } from '../types.ts';
import { keccakText, recoverAddress, typedDataHash, typeString, type FieldValue, type TypedDomain, type TypedField } from './eip712.ts';

/** The chain the Live AI environment's wallet approvals are bound to: Robinhood Chain testnet. Never a mainnet. */
export const APPROVAL_CHAIN_ID = 46_630n;
export const APPROVAL_ENVIRONMENT = 'robinhood-chain-testnet';
export const APPROVAL_DOMAIN: TypedDomain = { name: 'Mandate', version: '1', chainId: APPROVAL_CHAIN_ID };
export const APPROVAL_PRIMARY_TYPE = 'PortfolioMandateApproval';
/** How long a challenge may be signed and submitted, in wall-clock seconds. */
export const CHALLENGE_LIFETIME_SECONDS = 300n;

export const APPROVAL_FIELDS: readonly TypedField[] = [
  { name: 'statement', type: 'string' },
  { name: 'environment', type: 'string' },
  { name: 'mandateDigest', type: 'bytes32' },
  { name: 'mandateVersion', type: 'uint64' },
  { name: 'principal', type: 'address' },
  { name: 'protocolSigner', type: 'address' },
  { name: 'validAfter', type: 'uint64' },
  { name: 'validUntil', type: 'uint64' },
  { name: 'sessionDigest', type: 'bytes32' },
  { name: 'challenge', type: 'bytes32' },
];

export const APPROVAL_TYPE = typeString(APPROVAL_PRIMARY_TYPE, APPROVAL_FIELDS);

export interface ApprovalMessage {
  readonly statement: string;
  readonly environment: string;
  readonly mandateDigest: string;
  readonly mandateVersion: bigint;
  readonly principal: string;
  readonly protocolSigner: string;
  readonly validAfter: bigint;
  readonly validUntil: bigint;
  readonly sessionDigest: string;
  readonly challenge: string;
}

export function sessionDigest(sessionId: string): string {
  return keccakText(`mandate-live-session/v1:${sessionId}`);
}

/** A fixed-form statement of what the mandate allows, from the mandate alone. */
export function approvalStatement(m: PortfolioMandate, version: number): string {
  const limits = m.limits.map((l) => `${l.resource} ${usdcText(l.atoms)}`).join(', ');
  const agents = m.agents.map((a) => a.label).join(', ');
  return [
    `Approve Mandate V${version} for the Mandate Live AI Lab on Robinhood Chain testnet.`,
    `Portfolio limits (USDC): ${limits === '' ? 'none' : limits}.`,
    `Agents: ${agents === '' ? 'none' : agents}.`,
    `Expires at protocol time ${m.expiresAt}.`,
    'This signature is not a blockchain transaction, moves no funds and does not delegate onchain execution authority.',
  ].join(' ');
}

function values(m: ApprovalMessage): { readonly [k: string]: FieldValue } {
  return { ...m };
}

/** The digest the wallet signs. */
export function approvalHash(m: ApprovalMessage): Uint8Array {
  return typedDataHash(APPROVAL_DOMAIN, APPROVAL_PRIMARY_TYPE, APPROVAL_FIELDS, values(m));
}

/** What the browser hands the wallet for `eth_signTypedData_v4`. Integers wider than 53 bits are decimal strings. */
export function approvalTypedData(m: ApprovalMessage): { readonly [k: string]: unknown } {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      [APPROVAL_PRIMARY_TYPE]: APPROVAL_FIELDS,
    },
    primaryType: APPROVAL_PRIMARY_TYPE,
    domain: { name: APPROVAL_DOMAIN.name, version: APPROVAL_DOMAIN.version, chainId: Number(APPROVAL_DOMAIN.chainId) },
    message: { ...m, mandateVersion: m.mandateVersion.toString(), validAfter: m.validAfter.toString(), validUntil: m.validUntil.toString() },
  };
}

/** The approval message for `mandate`, as the server builds it; `mandateDigest` is always recomputed. */
export function approvalMessage(o: { readonly mandate: PortfolioMandate; readonly version: number; readonly principal: string; readonly protocolSigner: string; readonly validAfter: bigint; readonly sessionId: string; readonly challenge: string }): ApprovalMessage {
  return {
    statement: approvalStatement(o.mandate, o.version),
    environment: APPROVAL_ENVIRONMENT,
    mandateDigest: portfolioMandateDigest(o.mandate),
    mandateVersion: BigInt(o.version),
    principal: o.principal,
    protocolSigner: o.protocolSigner,
    validAfter: o.validAfter,
    validUntil: o.validAfter + CHALLENGE_LIFETIME_SECONDS,
    sessionDigest: sessionDigest(o.sessionId),
    challenge: o.challenge,
  };
}

export type ApprovalCheck = { readonly ok: true; readonly signature: string } | { readonly ok: false; readonly code: 'WALLET_SIGNATURE_MALFORMED' | 'WALLET_SIGNER_MISMATCH' };

/** Whether `signature` is `message.principal`'s EIP-712 signature of exactly `message`. */
export function checkApproval(message: ApprovalMessage, signature: string): ApprovalCheck {
  const r = recoverAddress(approvalHash(message), signature);
  if (!r.ok) return { ok: false, code: 'WALLET_SIGNATURE_MALFORMED' };
  if (r.address !== message.principal) return { ok: false, code: 'WALLET_SIGNER_MISMATCH' };
  return { ok: true, signature: r.normalized };
}
