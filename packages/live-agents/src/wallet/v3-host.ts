/**
 * Injectable V3 delegation host.
 *
 * The Live Lab package must not import `@mandate/live-settlement` or
 * `@mandate/execution-gate` (structure tests). The settlement composition
 * root implements this host, generates the ephemeral Mandate delegate, and
 * supplies Gate / fixture scope from trusted deployment state. Without a
 * host, `spine: "V3"` is refused.
 */

import type { MandateDraft } from '../authoring/draft-types.ts';
import type { PortfolioMandate } from '@mandate/portfolio';

/** Public V3 scope fields the wallet signs. No private key material. */
export interface V3PublicScope {
  readonly verifyingContract: string;
  readonly delegate: string;
  readonly agent: string;
  readonly representationIdHash: string;
  readonly fundingToken: string;
  /** Fixture MDUSD atoms — derived by the host, never model-supplied. */
  readonly cumulativeDebitLimit: string;
  readonly validAfter: string;
  readonly validUntil: string;
  readonly generation: string;
}

export interface V3IssueInput {
  readonly sessionId: string;
  readonly principal: string;
  readonly draft: MandateDraft;
  readonly mandate: PortfolioMandate;
  readonly generation: bigint;
  readonly now: bigint;
  readonly initialAllocationDigest: string;
}

export type V3IssueResult =
  | { readonly ok: true; readonly scope: V3PublicScope }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Creates (or returns) the session's in-memory V3 public scope for a fresh
 * challenge. Private keys stay in the host implementation.
 */
export interface V3ChallengeHost {
  issueScope(input: V3IssueInput): V3IssueResult;
}
