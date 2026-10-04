/**
 * Thin Mandate client facade.
 *
 * Every method delegates to an existing package. No second verifier, no
 * private principal key, no surprise broadcast.
 */

import {
  compileLocalPrompt,
  FixedProposalStrategy,
  sessionBindings,
  type LiveSession,
  type MandateDraft,
} from '@mandate/live-agents';
import {
  proposalDigest,
  runPortfolio,
  screenProposal,
  type DomainBinding,
  type PortfolioMandate,
  type Reason,
  type SignedProposal,
} from '@mandate/portfolio';
import { reviewMandateDraft } from './review.ts';
import type {
  AcceptAuthorizationResult,
  AuthorityContext,
  AuthorizationDecision,
  AuthorizedDecision,
  CompileRequest,
  MandateClientConfig,
  MandateDraftBundle,
  MandateReview,
  PrepareAuthorizationResult,
  PreparedDelegatedAuthorization,
  PrepareExecutionResult,
  ReconciliationResult,
  ReservationResult,
  SettlementBackend,
} from './types.ts';

function asChainId(chainId: number | bigint): number {
  return typeof chainId === 'bigint' ? Number(chainId) : chainId;
}

function typedMessage(typedData: { readonly [k: string]: unknown }): { readonly [k: string]: unknown } {
  const message = typedData['message'];
  return message !== null && typeof message === 'object' ? (message as { readonly [k: string]: unknown }) : {};
}

function typedDomain(typedData: { readonly [k: string]: unknown }): { readonly [k: string]: unknown } {
  const domain = typedData['domain'];
  return domain !== null && typeof domain === 'object' ? (domain as { readonly [k: string]: unknown }) : {};
}

function strField(message: { readonly [k: string]: unknown }, key: string): string | null {
  const v = message[key];
  return typeof v === 'string' ? v : v === undefined || v === null ? null : String(v);
}

function refuseScreen(
  proposal: SignedProposal,
  mandate: PortfolioMandate,
  code: string,
  subject = '',
): AuthorizationDecision {
  const reasons = [{ code, subject }] as readonly Reason[];
  return {
    authorized: false,
    kind: 'REFUSED',
    reasons,
    screening: {
      reasons,
      quantityOnly: false,
      action: null,
      demand: [],
      child: null,
      registry: null,
    },
    proposal,
    mandate,
    child: null,
  };
}

export interface MandateClient {
  readonly principal: string;
  readonly chainId: number;
  compile(request: CompileRequest): Promise<MandateDraftBundle>;
  review(draft: MandateDraft | MandateDraftBundle): MandateReview;
  prepareDelegatedAuthorization(review: MandateReview): Promise<PrepareAuthorizationResult>;
  acceptAuthorization(input: {
    readonly prepared: PreparedDelegatedAuthorization;
    readonly signature: string;
    readonly draft?: MandateDraft;
  }): Promise<AcceptAuthorizationResult>;
  /** Attach an already-authorized portfolio context for screen / reserve. */
  attachAuthority(ctx: AuthorityContext): void;
  screen(request: {
    readonly mandate?: PortfolioMandate;
    readonly proposal: SignedProposal;
    readonly now?: bigint;
  }): Promise<AuthorizationDecision>;
  reserve(decision: AuthorizationDecision): Promise<ReservationResult>;
  prepareExecution(reservation: ReservationResult): Promise<PrepareExecutionResult>;
  reconcile(input?: {
    readonly execution?: PrepareExecutionResult;
    readonly reservationId?: string;
  }): Promise<ReconciliationResult>;
}

class MandateClientImpl implements MandateClient {
  readonly principal: string;
  readonly chainId: number;
  readonly #now: () => bigint;
  readonly #bindings: readonly DomainBinding[] | null;
  readonly #session: LiveSession | null;
  readonly #settlement: SettlementBackend | null;
  #authority: AuthorityContext | null = null;
  #lastReview: MandateReview | null = null;

  constructor(config: MandateClientConfig) {
    if (typeof config.principal !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(config.principal)) {
      throw new Error('createMandateClient: principal must be a 0x-prefixed 20-byte address');
    }
    this.principal = config.principal.toLowerCase();
    this.chainId = asChainId(config.chainId);
    this.#now =
      config.now ??
      (() => {
        throw new Error('createMandateClient: config.now is required for review/screen/reserve/authorization');
      });
    this.#bindings = config.bindings ?? null;
    this.#session = config.session ?? null;
    this.#settlement = config.settlement ?? null;
  }

  #bindingsOrThrow(): readonly DomainBinding[] {
    if (this.#authority !== null) return this.#authority.bindings;
    if (this.#bindings !== null) return this.#bindings;
    throw new Error('MandateClient: supply config.bindings or attachAuthority(...) before review/screen/reserve');
  }

  async compile(request: CompileRequest): Promise<MandateDraftBundle> {
    const compile = compileLocalPrompt(request.instruction, request.form ?? null);
    return { draft: compile.draft, allocation: compile.allocationIntent, compile };
  }

  review(draft: MandateDraft | MandateDraftBundle): MandateReview {
    const d = 'compile' in draft ? draft.draft : draft;
    const review = reviewMandateDraft({
      draft: d,
      now: this.#now(),
      bindings: this.#bindingsOrThrow(),
    });
    this.#lastReview = review;
    return review;
  }

  async prepareDelegatedAuthorization(review: MandateReview): Promise<PrepareAuthorizationResult> {
    if (!review.signable) {
      return {
        ok: false,
        code: 'NOT_SIGNABLE',
        message: review.blockerSummary || 'Resolve review blockers before preparing delegated authorization.',
      };
    }
    if (this.#session === null) {
      return {
        ok: false,
        code: 'SESSION_REQUIRED',
        message: 'prepareDelegatedAuthorization requires a LiveSession with a V3 challenge host.',
      };
    }
    const challenge = this.#session.spineChallengeV3(review.draft, this.principal);
    if (!challenge.ok) return { ok: false, code: challenge.code, message: challenge.message };
    const message = typedMessage(challenge.typedData);
    const domain = typedDomain(challenge.typedData);
    const prepared: PreparedDelegatedAuthorization = {
      spine: 'V3',
      challengeId: challenge.challenge,
      principal: challenge.principal,
      chainId: this.chainId,
      version: challenge.version,
      digest: challenge.digest,
      initialAllocationDigest: challenge.initialAllocationDigest,
      validUntil: challenge.validUntil,
      typedData: challenge.typedData,
      verifyingContract: strField(domain, 'verifyingContract'),
      delegate: strField(message, 'delegate'),
      agent: strField(message, 'agent'),
      cumulativeDebitLimit: strField(message, 'cumulativeDebitLimit'),
      generation: strField(message, 'generation'),
      validAfter: strField(message, 'validAfter'),
      fundingToken: strField(message, 'fundingToken'),
    };
    this.#lastReview = review;
    return { ok: true, prepared };
  }

  async acceptAuthorization(input: {
    readonly prepared: PreparedDelegatedAuthorization;
    readonly signature: string;
    readonly draft?: MandateDraft;
  }): Promise<AcceptAuthorizationResult> {
    if (this.#session === null) {
      return {
        ok: false,
        code: 'SESSION_RESTORED',
        message: 'acceptAuthorization requires a LiveSession.',
        issues: [],
      };
    }
    const draft = input.draft ?? this.#lastReview?.draft;
    if (draft === undefined) {
      return {
        ok: false,
        code: 'DRAFT_INVALID',
        message: 'acceptAuthorization needs the reviewed draft (pass draft or call review first).',
        issues: [],
      };
    }
    return this.#session.authorizeWithWallet(draft, input.prepared.challengeId, input.signature);
  }

  attachAuthority(ctx: AuthorityContext): void {
    if (ctx.mandate.principal.value.toLowerCase() !== this.principal) {
      throw new Error('attachAuthority: mandate principal does not match client principal');
    }
    this.#authority = ctx;
  }

  async screen(request: {
    readonly mandate?: PortfolioMandate;
    readonly proposal: SignedProposal;
    readonly now?: bigint;
  }): Promise<AuthorizationDecision> {
    const mandate = request.mandate ?? this.#authority?.mandate;
    if (mandate === undefined) {
      const placeholder = {
        principal: { kind: 'eip155-address' as const, value: this.principal },
      } as PortfolioMandate;
      return refuseScreen(request.proposal, placeholder, 'LEDGER:SDK/NO_AUTHORITY', 'attachAuthority or pass mandate');
    }
    if (mandate.principal.value.toLowerCase() !== this.principal) {
      return refuseScreen(request.proposal, mandate, 'LEDGER:SDK/PRINCIPAL_MISMATCH', mandate.principal.value);
    }
    const bindings = this.#authority?.bindings ?? this.#bindingsOrThrow();
    const screening = screenProposal(mandate, bindings, request.proposal, request.now ?? this.#now());
    if (screening.child === null || screening.reasons.length > 0) {
      return {
        authorized: false,
        kind: 'REFUSED',
        reasons: screening.reasons,
        screening,
        proposal: request.proposal,
        mandate,
        child: null,
      };
    }
    return {
      authorized: true,
      kind: 'AUTHORIZED',
      reasons: [],
      screening,
      proposal: request.proposal,
      mandate,
      child: screening.child,
    };
  }

  async reserve(decision: AuthorizationDecision): Promise<ReservationResult> {
    if (!decision.authorized) {
      return {
        ok: false,
        code: 'SDK:REFUSED_DECISION',
        reasons: decision.reasons.map((r) => r.code),
        broadcasts: 0,
      };
    }
    if (this.#authority === null) {
      return {
        ok: false,
        code: 'SDK:NO_AUTHORITY',
        reasons: ['attachAuthority required before reserve'],
        broadcasts: 0,
      };
    }
    const authorized = decision as AuthorizedDecision;
    const run = await runPortfolio({
      core: this.#authority.core,
      signature: this.#authority.signature,
      ...(this.#authority.authority === undefined ? {} : { authority: this.#authority.authority }),
      now: this.#now(),
      agents: [new FixedProposalStrategy(authorized.proposal)],
      execute: null,
      executeAfter: 0n,
    });
    const d = proposalDigest(authorized.proposal.proposal);
    const child =
      run.verification.status === 'VERIFIED' ? run.verification.children.find((c) => c.proposal === d) : undefined;
    const reservation = child === undefined ? undefined : run.reservations.find((x) => x.child === child.digest);
    if (reservation?.status !== 'RESERVED' || child === undefined || reservation.reservation === null) {
      const reasons = [
        ...(run.verification.status === 'REFUSED' ? run.verification.reasons.map((r) => r.code) : []),
        ...(reservation?.reasons ?? []).map((r) => r.code),
      ];
      return {
        ok: false,
        code: reasons[0] ?? 'SDK:RESERVE_REFUSED',
        reasons: reasons.length > 0 ? reasons : ['SDK:RESERVE_REFUSED'],
        broadcasts: 0,
      };
    }
    const after = await this.#authority.core.engine.read(this.#authority.mandate.principal);
    return {
      ok: true,
      reservationId: reservation.reservation,
      childDigest: child.digest,
      proposalDigest: d,
      ledgerVersion: after.version.toString(),
      broadcasts: 0,
    };
  }

  async prepareExecution(reservation: ReservationResult): Promise<PrepareExecutionResult> {
    if (!reservation.ok) {
      return {
        ok: false,
        code: 'SDK:NO_RESERVATION',
        message: 'Cannot prepare execution for a refused reservation.',
        broadcasts: 0,
      };
    }
    if (this.#settlement === null) {
      return {
        ok: false,
        code: 'SDK:SETTLEMENT_REQUIRED',
        message: 'prepareExecution requires an injected SettlementBackend (e.g. createV3SettlementBackend).',
        broadcasts: 0,
      };
    }
    const result = await this.#settlement.prepareExecution({
      reservationId: reservation.reservationId,
      reservation,
    });
    if (result.ok && result.execution.broadcasts !== 0) {
      return {
        ok: false,
        code: 'UNEXPECTED_BROADCAST',
        message: 'Settlement backend reported broadcasts during preparation; SDK refuses the result.',
        broadcasts: 0,
      };
    }
    return result;
  }

  async reconcile(
    input: { readonly execution?: PrepareExecutionResult; readonly reservationId?: string } = {},
  ): Promise<ReconciliationResult> {
    if (this.#settlement === null) {
      return {
        ok: false,
        code: 'SDK:SETTLEMENT_REQUIRED',
        message: 'reconcile requires an injected SettlementBackend.',
        reports: [],
        resent: false,
        broadcasts: 0,
      };
    }
    const execution = input.execution?.ok === true ? input.execution.execution : undefined;
    const result = await this.#settlement.reconcile({
      ...(execution === undefined ? {} : { execution }),
      ...(input.reservationId === undefined ? {} : { reservationId: input.reservationId }),
    });
    if (result.broadcasts !== 0 || result.resent) {
      return {
        ok: false,
        code: 'UNEXPECTED_RESEND',
        message: 'Settlement backend attempted a resend; SDK refuses the result.',
        reports: result.reports,
        resent: false,
        broadcasts: 0,
      };
    }
    return result;
  }
}

/** Create a thin Mandate client over existing packages. */
export function createMandateClient(config: MandateClientConfig): MandateClient {
  return new MandateClientImpl(config);
}

/** Convenience: Live Lab domain bindings when the integrator explicitly opts in. */
export function liveLabDomainBindings(): readonly DomainBinding[] {
  return sessionBindings();
}
