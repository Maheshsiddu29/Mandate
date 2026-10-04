/**
 * Developer-facing types for `@mandate/sdk`.
 *
 * Prefer canonical types from `@mandate/live-agents`, `@mandate/portfolio`,
 * and `@mandate/live-settlement`. New types here are only the thin facade
 * shapes (client config, review gate, decision discrimination).
 */

import type {
  AllocationView,
  AuthorizeResult,
  CompileResult,
  DraftIssue,
  DraftValidation,
  LiveSession,
  MandateDraft,
  V3ChallengeHost,
  WalletChallengeResult,
} from '@mandate/live-agents';
import type {
  DomainBinding,
  PortfolioAuthority,
  PortfolioCore,
  PortfolioMandate,
  Reason,
  Screening,
  SignedProposal,
  VerificationTranscript,
  VerifiedChild,
} from '@mandate/portfolio';
import type {
  ReconcileReport,
  SettlementEvidence,
  V3PreparedExecution,
} from '@mandate/live-settlement';

export type {
  MandateDraft,
  CompileResult,
  DraftIssue,
  DraftValidation,
  AllocationView,
  AuthorizeResult,
  WalletChallengeResult,
  SignedProposal,
  Screening,
  Reason,
  PortfolioMandate,
  PortfolioCore,
  DomainBinding,
  VerificationTranscript,
  VerifiedChild,
  V3PreparedExecution,
  ReconcileReport,
  SettlementEvidence,
};

/** Evidence class labels used by settlement / reconciliation surfaces. */
export type EvidenceClass = SettlementEvidence;

export interface MandateClientConfig {
  /** Principal address the mandate will bind to (0x-prefixed). */
  readonly principal: string;
  /** Chain id for chain-aware preparation (e.g. Robinhood Chain testnet 46630). */
  readonly chainId: number | bigint;
  /** Protocol time. Required for screen / reserve / authorization acceptance. */
  readonly now?: () => bigint;
  /**
   * Domain bindings for screening and reservation.
   * Not defaulted to demo fixtures — supply explicitly or via `attachAuthority`.
   */
  readonly bindings?: readonly DomainBinding[];
  /**
   * Live session used for V3 challenge issue / wallet acceptance / restore.
   * When omitted, compile/review still work; authorization and session restore refuse.
   */
  readonly session?: LiveSession;
  /**
   * Optional V3 challenge host. Prefer injecting via `LiveSession` options;
   * accepted here only when the session was created with the same host.
   */
  readonly v3Host?: V3ChallengeHost;
  /** Injected settlement backend — never invented by the SDK. */
  readonly settlement?: SettlementBackend;
}

/** Active portfolio authority the client screens and reserves against. */
export interface AuthorityContext {
  readonly mandate: PortfolioMandate;
  readonly signature: string;
  readonly core: PortfolioCore;
  readonly bindings: readonly DomainBinding[];
  readonly authority?: PortfolioAuthority;
}

export interface CompileRequest {
  readonly instruction: string;
  /** Existing form/draft values the principal already set. */
  readonly form?: MandateDraft | null;
}

export interface MandateDraftBundle {
  readonly draft: MandateDraft;
  readonly allocation: AllocationView;
  readonly compile: CompileResult;
}

export interface ReviewIssue {
  readonly index: number;
  readonly kind: DraftIssue['kind'];
  readonly field: string | null;
  readonly text: string;
  readonly dangerous: boolean;
  readonly softUnsupported: boolean;
}

export interface ReviewBlocker {
  readonly id: string;
  readonly text: string;
}

/**
 * Structured authority review gate (C2.1 semantics).
 * `signable` is false until every fail-closed condition clears.
 */
export interface MandateReview {
  readonly draft: MandateDraft;
  readonly allocation: AllocationView;
  readonly validation: DraftValidation;
  readonly issues: readonly ReviewIssue[];
  readonly blockers: readonly ReviewBlocker[];
  /** True only when validation passes and no draft issues / planning blockers remain. */
  readonly signable: boolean;
  readonly blockerSummary: string;
}

export interface PreparedDelegatedAuthorization {
  readonly spine: 'V3';
  readonly challengeId: string;
  readonly principal: string;
  readonly chainId: number;
  readonly version: number;
  readonly digest: string;
  readonly initialAllocationDigest: string | null;
  readonly validUntil: string;
  readonly typedData: { readonly [k: string]: unknown };
  readonly verifyingContract: string | null;
  readonly delegate: string | null;
  readonly agent: string | null;
  readonly cumulativeDebitLimit: string | null;
  readonly generation: string | null;
  readonly validAfter: string | null;
  readonly fundingToken: string | null;
}

export type PrepareAuthorizationResult =
  | { readonly ok: true; readonly prepared: PreparedDelegatedAuthorization }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type AcceptAuthorizationResult = AuthorizeResult;

export interface ScreenRequest {
  /** Active portfolio mandate. Defaults to the authority attached on the client. */
  readonly mandate?: PortfolioMandate;
  readonly proposal: SignedProposal;
  readonly now?: bigint;
}

export type AuthorizationDecision =
  | {
      readonly authorized: true;
      readonly kind: 'AUTHORIZED';
      readonly reasons: readonly Reason[];
      readonly screening: Screening;
      readonly proposal: SignedProposal;
      readonly mandate: PortfolioMandate;
      readonly child: NonNullable<Screening['child']>;
    }
  | {
      readonly authorized: false;
      readonly kind: 'REFUSED';
      readonly reasons: readonly Reason[];
      readonly screening: Screening;
      readonly proposal: SignedProposal;
      readonly mandate: PortfolioMandate;
      readonly child: null;
    };

export type AuthorizedDecision = Extract<AuthorizationDecision, { readonly authorized: true }>;
export type RefusedDecision = Extract<AuthorizationDecision, { readonly authorized: false }>;

export type ReservationResult =
  | {
      readonly ok: true;
      readonly reservationId: string;
      readonly childDigest: string;
      readonly proposalDigest: string;
      readonly ledgerVersion: string;
      readonly broadcasts: 0;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly reasons: readonly string[];
      readonly broadcasts: 0;
    };

export interface PreparedExecution {
  readonly broadcasts: 0;
  readonly prepared: V3PreparedExecution | { readonly [k: string]: unknown };
  readonly debit?: string;
  readonly wouldSend?: { readonly gate: string; readonly debit: string };
  readonly reports?: readonly ReconcileReport[];
}

export type PrepareExecutionResult =
  | { readonly ok: true; readonly execution: PreparedExecution }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly broadcasts: 0 };

export type ReconciliationResult =
  | {
      readonly ok: true;
      readonly reports: readonly ReconcileReport[];
      readonly resent: false;
      readonly broadcasts: 0;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly reports: readonly ReconcileReport[];
      readonly resent: false;
      readonly broadcasts: 0;
    };

export interface SettlementBackend {
  /**
   * Prepare exact execution material. Must not broadcast.
   * Implementations should force dry-run / prepare-only semantics.
   */
  prepareExecution(input: {
    readonly reservationId?: string;
    readonly reservation?: ReservationResult;
  }): Promise<PrepareExecutionResult>;
  /**
   * Reconcile durable settlement evidence. Must not resend a confirmed tx.
   */
  reconcile(input: {
    readonly execution?: PreparedExecution;
    readonly reservationId?: string;
  }): Promise<ReconciliationResult>;
}
