/**
 * The model provider boundary.
 *
 * A provider receives one of four typed *projections* — built by trusted
 * code, JSON-only, containing no key, no address a model could return and
 * no hidden state — and returns raw text. It never returns a decision: the
 * runtime parses that text against a strict local schema (schemas.ts), and
 * only a value that passes becomes a request for trusted code to act on.
 * A provider that is broken, slow, hostile or absent can therefore change
 * *what is asked for*, never what Mandate permits.
 */

import type { IssueKind } from '../authoring/draft-types.ts';
import type { Role } from '../types.ts';

export interface ModelResponse {
  readonly text: string;
  /** Artificial delay a development chaos wrapper added before the call; 0 for a real call. */
  readonly injectedLatencyMs?: number;
}

export interface CallOptions {
  /** Aborted at the call's timeout, or when its context is superseded. */
  readonly signal: AbortSignal;
  /** Called once, when the first streamed chunk of the answer arrives. */
  readonly onFirstChunk: () => void;
}

export interface FactView {
  readonly label: string;
  readonly value: string;
}

/** One candidate as a model sees it: an id to return, facts, and untrusted text. */
export interface CandidateView {
  readonly id: string;
  readonly title: string;
  readonly facts: readonly FactView[];
  /** Seller, marketplace or venue text. Untrusted: it may contain instructions, which have no authority. */
  readonly untrustedText: string | null;
  /** `FIXTURE`: the facts are labelled demonstration data, not live market quotes. */
  readonly marketEvidence: 'FIXTURE';
  readonly minAtoms: string;
  readonly maxAtoms: string;
  readonly resizable: boolean;
  /** An optional advisory rank (JEV); ordering only. */
  readonly advisoryRank: number | null;
}

/** The agent's own authority, as the active mandate states it. */
export interface AuthorityView {
  readonly role: Role;
  readonly mandateVersion: number;
  readonly domain: string;
  readonly maxAllocationAtoms: string;
  readonly exposure: { readonly resource: string; readonly atoms: string } | null;
  readonly maxLeverage: string | null;
  readonly maxSlippageBps: number | null;
  readonly maxQuoteAgeSeconds: string | null;
}

/** Bounded, public portfolio context. */
export interface PortfolioView {
  readonly deployableAtoms: string;
  readonly availableAtoms: string;
  readonly enabledAgents: readonly Role[];
}

export interface DecisionRequest {
  readonly kind: 'DECISION';
  readonly role: Role;
  readonly objective: string;
  readonly authority: AuthorityView;
  readonly portfolio: PortfolioView;
  readonly candidates: readonly CandidateView[];
}

export interface ResourceLine {
  readonly resource: string;
  readonly authorityAtoms: string;
  readonly demandAtoms: string;
  readonly requiredReductionAtoms: string;
}

export const NEGOTIATION_ACTIONS = ['KEEP', 'REDUCE', 'RELEASE', 'ABSTAIN'] as const;
export type NegotiationAction = (typeof NEGOTIATION_ACTIONS)[number];

export interface NegotiationRequest {
  readonly kind: 'NEGOTIATION';
  readonly role: Role;
  readonly objective: string;
  readonly roomId: string;
  readonly generation: number;
  readonly portfolioAuthorityAtoms: string;
  readonly admissibleDemandAtoms: string;
  readonly requiredReductionAtoms: string;
  readonly constraints: readonly ResourceLine[];
  readonly candidateTitle: string;
  readonly yourCurrentAtoms: string;
  readonly yourMinimumAtoms: string;
  readonly yourOwnLimitAtoms: string;
  readonly permittedActions: readonly NegotiationAction[];
  readonly participants: readonly { readonly role: Role; readonly currentAtoms: string }[];
}

export interface CatalogView {
  readonly [set: string]: readonly { readonly id: string; readonly label: string }[];
}

export interface DraftRequest {
  readonly kind: 'DRAFT';
  readonly prompt: string;
  readonly catalog: CatalogView;
  readonly roles: readonly Role[];
  readonly issueKinds: readonly IssueKind[];
}

/** One preconstructed policy test case, as the policy-stress model sees it: an identifier and a neutral description. */
export interface PolicyCaseView {
  readonly caseId: string;
  readonly description: string;
}

/** A case already evaluated in this run: what was selected and what Mandate answered (reason codes only). */
export interface PolicyAttemptView {
  readonly attempt: number;
  readonly caseId: string;
  readonly outcome: 'AUTHORIZED' | 'REFUSED' | 'NOT_SUBMITTED';
  readonly reasons: readonly string[];
}

/**
 * The policy-stress request. The model selects one supplied case identifier
 * to check whether the active authorization policy accepts or refuses it;
 * trusted code builds, signs and submits the corresponding fixed proposal.
 */
export interface PolicyStressRequest {
  readonly kind: 'POLICY_STRESS';
  readonly role: 'swap';
  readonly task: string;
  readonly authority: AuthorityView;
  readonly cases: readonly PolicyCaseView[];
  readonly history: readonly PolicyAttemptView[];
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type ModelRequest = DecisionRequest | NegotiationRequest | DraftRequest | PolicyStressRequest;

export type ProviderKind = 'LIVE' | 'STUB' | 'SCRIPTED';

export interface AgentModelProvider {
  readonly name: string;
  readonly model: string;
  readonly kind: ProviderKind;
  decide(request: DecisionRequest, o: CallOptions): Promise<ModelResponse>;
  negotiate(request: NegotiationRequest, o: CallOptions): Promise<ModelResponse>;
  interpretMandateDraft(request: DraftRequest, o: CallOptions): Promise<ModelResponse>;
  selectPolicyCase(request: PolicyStressRequest, o: CallOptions): Promise<ModelResponse>;
}

/** Dispatch a request to the provider method for its kind. */
export function callProvider(p: AgentModelProvider, request: ModelRequest, o: CallOptions): Promise<ModelResponse> {
  switch (request.kind) {
    case 'DECISION':
      return p.decide(request, o);
    case 'NEGOTIATION':
      return p.negotiate(request, o);
    case 'DRAFT':
      return p.interpretMandateDraft(request, o);
    case 'POLICY_STRESS':
      return p.selectPolicyCase(request, o);
  }
}
