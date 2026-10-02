/**
 * Settlement eligibility: whether an authorized execution may reach a key.
 *
 * Every condition is re-derived from the frozen protocol and the committed
 * ledger at the moment of asking — nothing is taken from an earlier answer.
 * It runs before the domain leg is built and again inside custody, just
 * before the principal key signs (custody-guard.ts). Any reason at all means
 * no signature and no transaction.
 *
 * | # | condition | how |
 * | --- | --- | --- |
 * | 1 | the model's answer passed local schema validation | the candidate id is in the Stock agent's closed set (discovery builds nothing from an answer that failed `parseDecision`) |
 * | 2 | trusted local code built the proposal | its candidate names exactly the representation and account that candidate's trusted `build` does |
 * | 3 | the Stock agent's identity signed it | agent = the Stock party; the signature recovers under the portfolio's own rule |
 * | 4 | screening accepts the exact candidate | `screenProposal` now derives the same child, byte for byte |
 * | 5 | the Portfolio Verifier accepts it | `verifyTranscript` re-derives the run and lists this child for this proposal |
 * | 6 | a valid current reservation | the ledger's reservation is ACTIVE, is this action's, generation 1, and has no attempt — or only this settlement's own (B.5.3: the portfolio `ADMIT_ATTEMPT` naming the settlement binding, admitted before any domain key) |
 * | 7 | the version is active, not superseded, revoked or paused | the session's active version is this one; no node of the reservation's lineage is revoked |
 * | 8 | exactly the reserved proposal | proposal, candidate and action digests all equal the reserved ones |
 * | 9 | freshness | the proposal and the Core authorization are unexpired now; screening (4) re-checks quote age |
 */

import { actionId, authorityId } from '@mandate/core';
import type { LedgerState } from '@mandate/ledger';
import {
  PORTFOLIO_GENERATION,
  candidateDigest,
  childAuthorizationDigest,
  compileAction,
  portfolioMandateDigest,
  proposalDigest,
  proposalSignedByAgent,
  reservationPhase,
  screenProposal,
  validateActionCandidate,
  verifyTranscript,
} from '@mandate/portfolio';
import { demoParty } from '@mandate/portfolio/demo';
import { DOMAIN_AGENTS, type ActiveMandate } from '@mandate/live-agents';
import type { AuthorizedExecution } from './authorized-execution.ts';
import { admittedFor } from './portfolio-ledger.ts';

/** What eligibility reads: the session's version in force, its committed ledger, protocol time. */
export interface LiveAuthorityView {
  readonly active: ActiveMandate | null;
  readonly paused: boolean;
  readonly ledger: LedgerState;
  readonly now: bigint;
  /** This settlement's binding digest: the one portfolio attempt that may already exist for the reservation. */
  readonly continuing?: string;
}

export type Eligibility = { readonly eligible: true } | { readonly eligible: false; readonly condition: number; readonly reason: string };

const no = (condition: number, reason: string): Eligibility => ({ eligible: false, condition, reason });

export function checkEligibility(view: LiveAuthorityView, x: AuthorizedExecution): Eligibility {
  const r = x.reserved;
  const p = r.signed.proposal;

  // 1–2: a closed-set choice, built by trusted local code.
  const trusted = DOMAIN_AGENTS.stock.candidates.find((c) => c.id === x.candidateId);
  if (trusted === undefined || r.role !== 'stock') return no(1, 'CANDIDATE_ID_NOT_IN_CLOSED_SET');
  // Probed at the candidate's own minimum: identity does not depend on size, and a fee-aware build has no 1-atom quantity.
  const built = validateActionCandidate(trusted.build(trusted.minAtoms, 0n));
  if (!built.ok || built.value.kind !== 'STOCK_BUY' || p.candidate.kind !== 'STOCK_BUY') return no(2, 'CANDIDATE_NOT_A_TRUSTED_STOCK_BUY');
  if (p.candidate.representation !== built.value.representation || p.candidate.account !== built.value.account) return no(2, 'CANDIDATE_NOT_TRUSTED_BUILD');

  // 3: the Stock agent's own signature.
  const stock = demoParty('stock');
  if (p.agent.kind !== stock.kind || p.agent.value !== stock.value) return no(3, 'AGENT_NOT_STOCK_AGENT');
  if (!proposalSignedByAgent(p, r.signed.signature)) return no(3, 'AGENT_SIGNATURE_INVALID');

  // 7: the version in force (checked before anything is re-derived under it).
  const active = view.active;
  if (view.paused || active === null) return no(7, 'MANDATE_PAUSED_OR_INACTIVE');
  if (active.version !== x.version) return no(7, 'MANDATE_SUPERSEDED');
  if (portfolioMandateDigest(active.mandate) !== p.portfolioMandate || x.portfolioMandate !== p.portfolioMandate) return no(7, 'MANDATE_DIGEST_MISMATCH');

  // 8: exactly the reserved proposal, candidate and child.
  if (proposalDigest(p) !== x.proposal || r.verified.proposal !== x.proposal) return no(8, 'PROPOSAL_DIGEST_MISMATCH');
  if (candidateDigest(p.candidate) !== x.candidateDigest || candidateDigest(r.verified.candidate) !== x.candidateDigest || candidateDigest(x.candidate) !== x.candidateDigest) return no(8, 'CANDIDATE_MISMATCH');
  if (childAuthorizationDigest(r.verified.child) !== x.child || r.verified.child.candidate !== x.candidateDigest) return no(8, 'CHILD_MISMATCH');

  // 9: freshness, in protocol time.
  if (view.now >= p.expiresAt) return no(9, 'PROPOSAL_EXPIRED');
  if (view.now >= r.record.validUntil) return no(9, 'AUTHORIZATION_EXPIRED');

  // 4: screening now derives the same child.
  const s = screenProposal(active.mandate, active.compiled.bindings, r.signed, view.now);
  if (s.child === null) return no(4, `SCREENING_REFUSED:${s.reasons.map((q) => q.code).join(',')}`);
  if (childAuthorizationDigest(s.child) !== x.child) return no(4, 'SCREENED_CHILD_MUTATED');

  // 5: the verifier re-derives the run and lists this child.
  const v = verifyTranscript(active.mandate, active.compiled.bindings, r.transcript);
  if (v.status !== 'VERIFIED') return no(5, `VERIFIER_REFUSED:${v.reasons.map((q) => q.code).join(',')}`);
  const child = v.children.find((c) => c.digest === x.child);
  if (child === undefined || child.proposal !== x.proposal || candidateDigest(child.candidate) !== x.candidateDigest) return no(5, 'VERIFIER_CHILD_UNKNOWN');

  // 8 (cont.): the action the ledger reserved is the one this child compiles to.
  const compiled = compileAction(active.compiled, r.verified.child, r.verified.candidate);
  if (!compiled.ok || actionId(compiled.value.envelope) !== x.action || r.record.actionId !== x.action) return no(8, 'ACTION_MISMATCH');

  // 6: the reservation, as the committed ledger holds it.
  const res = view.ledger.reservations.get(x.reservation);
  if (res === undefined || res.status !== 'ACTIVE') return no(6, 'RESERVATION_NOT_ACTIVE');
  if (res.action !== x.action || res.generation !== x.generation || x.generation !== PORTFOLIO_GENERATION) return no(6, 'RESERVATION_NOT_THIS_ACTION');
  const phase = reservationPhase(view.ledger, x.reservation);
  if (phase === 'ADMITTED') {
    if (view.continuing === undefined || admittedFor(view.ledger, x.reservation) !== view.continuing) return no(6, 'RESERVATION_ALREADY_ADMITTED');
  } else if (phase !== 'RESERVED') return no(6, 'RESERVATION_ALREADY_ADMITTED');

  // 7 (cont.): no authority on the reservation's lineage — agent delegation up to the root — is revoked.
  if (!res.lineage.includes(authorityId(active.compiled.root))) return no(7, 'RESERVATION_NOT_UNDER_ACTIVE_ROOT');
  for (const id of res.lineage) {
    const node = view.ledger.nodes.get(id);
    if (node === undefined) return no(7, 'LINEAGE_UNKNOWN');
    if (node.revokedAt !== null) return no(7, 'MANDATE_REVOKED');
  }
  return { eligible: true };
}
