/**
 * The policy-stress run: VALID AGENT != VALID ACTION, with a real model
 * choosing which case is tested (docs/demo/live-ai-lab.md §7).
 *
 * ```text
 * model: { caseId } ─▶ exact lookup (cases.ts) ─▶ trusted construction at protocol time now
 *   ─▶ the SAME local swap signer ─▶ screenProposal ─▶ runPortfolio (Room → verifier → ledger)
 *   ─▶ AUTHORIZED only if the ledger reserved it; otherwise REFUSED, with Mandate's reasons
 * ```
 *
 * The model's only output is an identifier from a list this module
 * supplies. It sees reason codes, never an address, key or ledger. Each
 * case may be selected once; the run ends on ABSTAIN, on a runtime failure
 * (timeout, provider failure, invalid answer — never a Mandate refusal), or
 * after `maxAttempts`. Nothing here decides a verdict.
 */

import { agentPolicyOf, candidateDigest, headroom, proposalDigest, proposalSignedByAgent, validateActionCandidate, type SignedProposal } from '@mandate/portfolio';
import type { ActiveMandate } from '../authoring/mandate-versioning.ts';
import { amountViews, authorityView } from '../context.ts';
import { availabilityAt } from '../mandate/portfolio-adapter.ts';
import { buildProposal, type SequenceBook } from '../mandate/proposal-builder.ts';
import type { LocalAgentSigner } from '../mandate/signer.ts';
import { reasonCodes, screen } from '../mandate/verifier-adapter.ts';
import { callModel } from '../runtime/agent-runtime.ts';
import type { Clock } from '../runtime/clock.ts';
import type { AgentModelProvider, PolicyAttemptView, PolicyStressRequest } from '../runtime/provider.ts';
import { parsePolicyStress } from '../runtime/schemas.ts';
import type { EventLog } from '../telemetry/events.ts';
import { usdcText } from '../types.ts';
import { buildCase, caseViews, POLICY_CASE_IDS, type PolicyCaseId } from './cases.ts';

/** Every non-ABSTAIN case once, at most. */
export const MAX_POLICY_STRESS_ATTEMPTS = POLICY_CASE_IDS.length - 1;
export const DEFAULT_POLICY_STRESS_ATTEMPTS = MAX_POLICY_STRESS_ATTEMPTS;

export const POLICY_STRESS_TASK = 'Policy test: select one of the supplied proposal variants to test whether the active authorization policy correctly accepts or refuses it.';

/** What the full Mandate path did with one submitted proposal. */
export interface Submission {
  readonly submitted: boolean;
  readonly reserved: boolean;
  /** Room decision, verifier and reservation reasons, as codes. */
  readonly reasons: readonly string[];
  readonly verification: string;
  readonly receiptDigest: string | null;
  readonly ledgerVersionBefore: string;
  readonly ledgerVersionAfter: string;
  readonly reservationsBefore: number;
  readonly reservationsAfter: number;
  /** Why it could not be submitted (a held reservation elsewhere); never a Mandate reason. */
  readonly runtime: string | null;
}

export interface PolicyStressDeps {
  readonly provider: AgentModelProvider;
  readonly clock: Clock;
  readonly events: EventLog;
  /** The swap agent's own signer — the same instance the swap agent uses. */
  readonly signer: LocalAgentSigner;
  /** True when `signer` is the instance the normal swap agent signs with. */
  readonly sameSignerAsSwapAgent: boolean;
  readonly sequences: SequenceBook;
  readonly protocolNow: () => bigint;
  readonly timeoutMs: number;
  readonly current: () => ActiveMandate | null;
  /** Hand one signed proposal to the real Mandate path. */
  readonly submit: (active: ActiveMandate, signed: SignedProposal) => Promise<Submission>;
}

export type PolicyStressEnd = 'ABSTAINED' | 'MAX_ATTEMPTS' | 'NO_CASES_LEFT' | 'NO_ACTIVE_MANDATE' | 'TIMED_OUT' | 'FAILED' | 'INVALID_RESPONSE';

export interface PolicyStressAttempt {
  readonly attempt: number;
  readonly caseId: PolicyCaseId;
  readonly rationale: string;
  readonly outcome: 'AUTHORIZED' | 'REFUSED' | 'NOT_SUBMITTED';
  readonly screening: { readonly verdict: string; readonly reasons: readonly string[] } | null;
  readonly reasons: readonly string[];
  readonly proposal: string | null;
  readonly providerLatencyMs: number | null;
}

export interface PolicyStressResult {
  readonly endedBy: PolicyStressEnd;
  readonly attempts: readonly PolicyStressAttempt[];
}

export async function runPolicyStress(deps: PolicyStressDeps, o: { readonly maxAttempts?: number } = {}): Promise<PolicyStressResult> {
  const { clock, events, signer } = deps;
  const maxAttempts = Math.min(Math.max(1, o.maxAttempts ?? DEFAULT_POLICY_STRESS_ATTEMPTS), MAX_POLICY_STRESS_ATTEMPTS);
  const attempts: PolicyStressAttempt[] = [];
  const history: PolicyAttemptView[] = [];
  const emit = (kind: Parameters<EventLog['emit']>[0], version: number | null, data: { readonly [k: string]: unknown }) => events.emit(kind, { agent: 'swap', mandateVersion: version, data });

  const first = deps.current();
  emit('POLICY_STRESS_STARTED', first?.version ?? null, {
    title: 'POLICY STRESS TEST',
    headline: 'VALID AGENT ≠ VALID ACTION',
    identity: signer.party.value,
    sameSignerAsSwapAgent: deps.sameSignerAsSwapAgent,
    task: POLICY_STRESS_TASK,
    cases: POLICY_CASE_IDS,
    maxAttempts,
    provider: deps.provider.name,
    providerKind: deps.provider.kind,
    model: deps.provider.model,
    modelCapabilities: 'Select one supplied case identifier. No tools, addresses, amounts, calldata, keys, ledger or network.',
  });

  const finish = (endedBy: PolicyStressEnd): PolicyStressResult => {
    emit('POLICY_STRESS_COMPLETED', deps.current()?.version ?? null, {
      endedBy,
      maxAttempts,
      attempts: attempts.map((a) => ({ attempt: a.attempt, caseId: a.caseId, outcome: a.outcome, reasons: a.reasons })),
      authorized: attempts.filter((a) => a.outcome === 'AUTHORIZED').length,
      refused: attempts.filter((a) => a.outcome === 'REFUSED').length,
    });
    return { endedBy, attempts };
  };

  for (let attempt = 1; ; attempt += 1) {
    if (attempt > maxAttempts) return finish('MAX_ATTEMPTS');
    const active = deps.current();
    if (active === null) return finish('NO_ACTIVE_MANDATE');
    const tested = new Set(attempts.map((a) => a.caseId));
    const offered = POLICY_CASE_IDS.filter((id) => id === 'ABSTAIN' || !tested.has(id));
    if (offered.length === 1) return finish('NO_CASES_LEFT');

    const request: PolicyStressRequest = { kind: 'POLICY_STRESS', role: 'swap', task: POLICY_STRESS_TASK, authority: authorityView(active, 'swap'), cases: caseViews(offered), history: [...history], attempt, maxAttempts };
    const call = await callModel({ provider: deps.provider, request, parse: (t) => parsePolicyStress(t, request), timeoutMs: deps.timeoutMs, clock });
    if (call.status !== 'RESPONDED') {
      emit('POLICY_STRESS_COMPLETED', active.version, { endedBy: call.status, attempt, error: call.error, providerLatencyMs: call.timing.providerLatencyMs, effect: 'Nothing was built or signed for this attempt.' });
      return { endedBy: call.status, attempts };
    }
    const caseId = call.value.caseId as PolicyCaseId;
    const latency = { providerLatencyMs: call.timing.providerLatencyMs, timeToFirstResponseMs: call.timing.timeToFirstResponseMs, validationLatencyMs: call.timing.validationLatencyMs, injectedLatencyMs: call.timing.injectedLatencyMs };
    emit('POLICY_STRESS_CASE_SELECTED', active.version, { attempt, caseId, rationale: call.value.rationale, offered, ...latency });
    const record = (a: Omit<PolicyStressAttempt, 'attempt' | 'caseId' | 'rationale' | 'providerLatencyMs'>) => {
      attempts.push({ attempt, caseId, rationale: call.value.rationale, providerLatencyMs: call.timing.providerLatencyMs, ...a });
      history.push({ attempt, caseId, outcome: a.outcome, reasons: a.reasons.map((r) => r.split(':')[0] ?? r) });
    };
    if (caseId === 'ABSTAIN') {
      record({ outcome: 'NOT_SUBMITTED', screening: null, reasons: [], proposal: null });
      return finish('ABSTAINED');
    }

    // Trusted construction, at the protocol time of submission.
    const now = deps.protocolNow();
    const av = await availabilityAt(active.core, now);
    const built = buildCase(caseId, { headroomAtoms: headroom(av, signer.party.value, 'portfolio-notional'), observedAt: now });
    if (built === null) throw new Error(`case ${caseId} has no construction`);
    const proposal = buildProposal({ mandate: active.mandate, bindings: active.compiled.bindings, agent: signer.party, candidate: built.candidate, sizeAtoms: built.sizeAtoms, minimumAtoms: built.sizeAtoms, sequence: deps.sequences.next(signer.party), now });
    if (!proposal.ok) {
      record({ outcome: 'NOT_SUBMITTED', screening: null, reasons: [`LOCAL_BUILD:${proposal.error}`], proposal: null });
      continue;
    }
    const signStart = clock.nowMs();
    const signed = signer.sign(proposal.proposal);
    const signingLatencyMs = Math.round((clock.nowMs() - signStart) * 10) / 10;
    const digest = proposalDigest(signed.proposal);
    const policy = agentPolicyOf(active.mandate, signer.party);
    const delegation = active.compiled.delegations.get(signer.party.value);
    const windowOpen = policy !== null && policy.notBefore <= now && now < policy.expiresAt;
    const c = validateActionCandidate(built.candidate);
    emit('POLICY_STRESS_PROPOSAL_SIGNED', active.version, {
      attempt,
      caseId,
      proposal: digest,
      candidate: c.ok ? candidateDigest(c.value) : null,
      signer: signer.party.value,
      sequence: signed.proposal.sequence,
      requested: amountViews(proposal.demand),
      mutation: built.mutation,
      identity: {
        agentIdentity: signer.party.value === signed.proposal.agent.value ? 'VALID' : 'INVALID',
        membership: policy === null ? 'NONE' : 'VALID',
        delegation: delegation === undefined ? 'NONE' : windowOpen ? 'ACTIVE' : 'OUTSIDE_WINDOW',
        signature: proposalSignedByAgent(signed.proposal, signed.signature) ? 'VALID' : 'INVALID',
        sameSignerAsSwapAgent: deps.sameSignerAsSwapAgent,
      },
      signingLatencyMs,
    });

    // Mandate decides: screening first, then the full path.
    const mandateStart = clock.nowMs();
    const s = screen(active.mandate, active.compiled.bindings, signed, now);
    const submission = await deps.submit(active, signed);
    const mandateLatencyMs = Math.round(clock.nowMs() - mandateStart);
    const screening = { verdict: s.verdict, reasons: reasonCodes(s.reasons) };
    const ledger = { versionBefore: submission.ledgerVersionBefore, versionAfter: submission.ledgerVersionAfter, reservationsBefore: submission.reservationsBefore, reservationsAfter: submission.reservationsAfter };
    if (!submission.submitted) {
      record({ outcome: 'NOT_SUBMITTED', screening, reasons: submission.runtime === null ? [] : [submission.runtime], proposal: digest });
      emit('POLICY_STRESS_COMPLETED', active.version, { endedBy: 'FAILED', attempt, error: submission.runtime, effect: 'The proposal was signed but could not be submitted; it was not authorized.' });
      return { endedBy: 'FAILED', attempts };
    }
    if (submission.reserved) {
      const earlier = attempts.filter((a) => a.outcome === 'REFUSED').map((a) => a.caseId);
      record({ outcome: 'AUTHORIZED', screening, reasons: [], proposal: digest });
      emit('POLICY_STRESS_PROPOSAL_AUTHORIZED', active.version, {
        attempt,
        caseId,
        proposal: digest,
        screening,
        verification: submission.verification,
        reserved: { atoms: built.sizeAtoms, amount: usdcText(built.sizeAtoms) },
        receiptDigest: submission.receiptDigest,
        ledger,
        mandateLatencyMs,
        sameIdentityAsRefusedAttempts: earlier.length > 0 && deps.sameSignerAsSwapAgent,
        refusedEarlier: earlier,
        note: earlier.length > 0 ? 'The same agent identity, evaluated again under the same authorization system: this proposal is inside its authority.' : 'Authorized under the active mandate.',
      });
    } else {
      record({ outcome: 'REFUSED', screening, reasons: submission.reasons, proposal: digest });
      emit('POLICY_STRESS_PROPOSAL_BLOCKED', active.version, {
        attempt,
        caseId,
        proposal: digest,
        screening,
        verification: submission.verification,
        reasons: submission.reasons,
        ledger,
        ledgerUnchanged: ledger.versionBefore === ledger.versionAfter && ledger.reservationsBefore === ledger.reservationsAfter,
        delegationAfter: deps.current()?.compiled.delegations.has(signer.party.value) === true ? 'ACTIVE' : 'NONE',
        mandateLatencyMs,
      });
    }
  }
}
