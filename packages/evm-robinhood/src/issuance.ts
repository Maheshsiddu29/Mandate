/**
 * The issuance boundary for the Robinhood gate (Phase 7E.3), the EVM
 * counterpart of the Lighter signer's (attempt-lifecycle.md §3).
 *
 * ```text
 * authorization + reservation (committed by Control)
 *   │ 1 resolve    the exact authorization, module, adapter, principal; the payload decodes to a gate BUY
 *   │ 2 evidence   chain time; the gate's code hash and domain; the principal's allowance and balance
 *   │ 3 construct  the exact gate mandate, candidate and terms (gate.ts); nonce = the next gate slot
 *   │ 4 slot       the gate has never consumed this mandate digest
 *   │ 5 admit      Control.admitAttempt: revalidation on fresh chain state, module/adapter trust,
 *   │              CREDENTIAL_SCOPE + NONCE_SLOT, ADMIT_ATTEMPT naming the execution commitment, durable
 *   │ 6 sign       ONLY NOW: custody verifies the committed attempt and signs the mandate; the agent signs
 *   │              the commitment; both are recovered under the gate's own rule
 *   │ 7 journal    ARTIFACT_ISSUED, the calldata kept inside the signer
 *   │ 8 preflight  eth_call of exactly that calldata
 *   │ 9 submit     SUBMISSION_SENT → mined SUCCESS | mined REVERTED | OUTCOME_UNKNOWN
 *   ▼
 * the agent gets: attempt id, mandate digest, commitment, transaction hash, issuance state — never the signatures
 * ```
 *
 * Nothing before step 5 can produce a signature, so a refusal there leaves
 * `NEVER_ISSUED` available. From step 5 on nothing is released: the attempt
 * stays admitted and the reservation held until reconciliation (7F), because
 * a signed artifact may still land. There is no resubmission and no fresh
 * attempt for the generation (`EXISTING`).
 *
 * The stages are separate functions so the mutation suite can recompose
 * them; `GateSigner` is the only composition the package exports.
 */

import { ByteWriter } from '@mandate/kernel';
import { actionPayloadDigest, adapterRefsEqual, keccakDigest, moduleRefsEqual, type AdapterRef, type Digest32, type ModuleRef, type PrincipalId } from '@mandate/core';
import type { AttemptId, AttemptRecord, LedgerState, RetryPolicy } from '@mandate/ledger';
import type { AttemptOutcome, AuthorizationRecord, ControlEngine, EvaluationContextInput, PreExecutionResult, SuppliedState } from '@mandate/control';
import type { IssuanceJournal, IssuanceState, SqliteLedgerStore } from '@mandate/ledger-sqlite';
import { recoverSigner, type GateAttempt } from '@mandate/execution-gate';
import { executeCalldata, hexBytes } from './abi.ts';
import { ARTIFACT_KIND } from './adapter.ts';
import type { BlockRef, Read, Receipt, Simulation, Submission } from './chain.ts';
import type { AgentSigner, GateKeyCustody } from './custody.ts';
import { agentSigningHash, buildGateArtifact, checkGateArtifact, principalSigningHash, slotScope, type ArtifactSource, type ArtifactTerms, type GateArtifact } from './gate.ts';
import { buyCost, reviewedMarketFor, type ReviewedGate } from './market.ts';
import { ACTION_GATE_BUY, accountAddressOf, accountResource, decodeGateBuy, marketTokenOf, type Address, type DecodedBuy } from './vocabulary.ts';

/** The chain as the signer needs it. `LiveGateChain` (live.ts) implements it over JSON-RPC; tests fake it over the reference model. */
export interface GateChain {
  latest(): Promise<Read<BlockRef>>;
  gateIdentity(): Promise<Read<{ readonly codehash: string; readonly domainSeparator: string }>>;
  funding(token: Address, owner: Address, spender: Address): Promise<Read<{ readonly balance: bigint; readonly allowance: bigint }>>;
  executionCommitmentOf(mandateDigest: string): Promise<Read<string>>;
  simulate(call: GateCall): Promise<Simulation>;
  submit(call: GateCall): Promise<Submission>;
  receipt(txHash: string): Promise<Read<Receipt>>;
}

/** One `execute` call: its exact calldata and the structured attempt it encodes. */
export interface GateCall {
  readonly calldata: string;
  readonly attempt: GateAttempt;
}

export interface GateSignerConfig {
  readonly gate: ReviewedGate;
  readonly gateCodehash: string;
  readonly domainSeparator: string;
  readonly principal: PrincipalId;
  readonly principalAddress: Address;
  readonly agentAddress: Address;
  readonly adapter: AdapterRef;
  readonly policy: ModuleRef;
  /** An attempt's chain-time deadline from issue; always strictly before the authorization's ceiling. */
  readonly deadlineSeconds: bigint;
  readonly retry: RetryPolicy;
}

export interface GateSignerDeps {
  readonly engine: ControlEngine;
  readonly store: SqliteLedgerStore;
  readonly journal: IssuanceJournal;
  readonly custody: GateKeyCustody;
  readonly agent: AgentSigner;
  readonly chain: GateChain;
  readonly config: GateSignerConfig;
}

export interface IssueRequest {
  /** The payload the authorization's action commits to. */
  readonly payload: Uint8Array;
  /** Fresh gate-market state for issue-time revalidation. */
  readonly states: readonly SuppliedState[];
  /** Sources and watermarks; `evaluationTime` is replaced by chain time. */
  readonly context: EvaluationContextInput;
}

export type IssueStage = 'RESOLVE' | 'EVIDENCE' | 'CONSTRUCT' | 'SLOT' | 'ADMIT' | 'SIGN' | 'JOURNAL' | 'PREFLIGHT';

/** What the agent receives. There is deliberately no field for a signature or the calldata. */
export type IssueOutcome =
  | {
      readonly status: 'ISSUED';
      readonly attempt: AttemptId;
      readonly mandateDigest: string;
      readonly commitment: string;
      readonly txHash: string;
      readonly issuance: IssuanceState;
      readonly detail: string;
      readonly blockNumber: bigint | null;
      readonly gasUsed: bigint | null;
    }
  | { readonly status: 'EXISTING'; readonly attempt: AttemptId; readonly issuance: IssuanceState | null }
  | { readonly status: 'REFUSED'; readonly stage: IssueStage; readonly reason: string; readonly attemptAdmitted: boolean };

export type Step<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly stage: IssueStage; readonly reason: string };

const stop = (stage: IssueStage, reason: string): Step<never> => ({ ok: false, stage, reason });

export interface Intent {
  readonly record: AuthorizationRecord;
  readonly action: DecodedBuy;
  readonly source: ArtifactSource;
  readonly market: ReturnType<typeof reviewedMarketFor> & object;
}

// --- 1. resolve --------------------------------------------------------------------------------

export function resolveIntent(deps: GateSignerDeps, record: AuthorizationRecord, payload: Uint8Array): Step<Intent> {
  const c = deps.config;
  if (!moduleRefsEqual(record.module, c.policy)) return stop('RESOLVE', 'MODULE_NOT_THIS_POLICY');
  if (!adapterRefsEqual(record.adapter, c.adapter)) return stop('RESOLVE', 'ADAPTER_NOT_THIS_SIGNER');
  if (record.principal.kind !== c.principal.kind || record.principal.value !== c.principal.value) return stop('RESOLVE', 'PRINCIPAL_NOT_THIS_SIGNER');
  // Nothing about the action is taken from the request: the payload must be exactly the one the authorization committed to.
  const digest = actionPayloadDigest(record.module, payload);
  if (!digest.ok || digest.value !== record.action.payloadDigest) return stop('RESOLVE', 'PAYLOAD_NOT_AUTHORIZED');
  if (record.action.actionType !== ACTION_GATE_BUY) return stop('RESOLVE', 'ACTION_TYPE_NOT_GATE_BUY');
  const action = decodeGateBuy(payload);
  if (action === null) return stop('RESOLVE', 'PAYLOAD_MALFORMED');
  if (accountAddressOf(action.account, c.gate.chainId) !== c.principalAddress) return stop('RESOLVE', 'ACCOUNT_NOT_THIS_PRINCIPAL');
  const token = marketTokenOf(action.market, c.gate.chainId);
  const market = token === null ? null : reviewedMarketFor(c.gate, token);
  if (market === null) return stop('RESOLVE', 'MARKET_NOT_ON_THIS_GATE');
  const source: ArtifactSource = {
    executionId: record.executionId,
    authorizationId: record.id,
    reservation: record.reservation,
    generation: record.generation,
    adapter: record.adapter,
    evaluatedAt: record.evaluatedAt,
    validUntil: record.validUntil,
  };
  return { ok: true, value: { record, action, source, market } };
}

// --- 2. evidence ------------------------------------------------------------------------------

export interface Evidence {
  readonly now: BlockRef;
  readonly credential: PreExecutionResult;
  readonly scope: string;
  readonly nonce: bigint;
}

const digestOf = (w: ByteWriter): Digest32 => keccakDigest<Digest32>(w.finish());

/** The next gate slot for this principal: one past the highest the ledger ever admitted. */
export function nextSlot(state: LedgerState, scope: string): bigint {
  let high = 0n;
  for (const a of state.attempts.values() as Iterable<AttemptRecord>) if (a.slot !== null && a.slot.scope === scope && a.slot.sequence > high) high = a.slot.sequence;
  return high + 1n;
}

export async function readEvidence(deps: GateSignerDeps, intent: Intent): Promise<Step<Evidence>> {
  const c = deps.config;
  const [now, identity, funding] = await Promise.all([deps.chain.latest(), deps.chain.gateIdentity(), deps.chain.funding(intent.market.fundingToken, c.principalAddress, c.gate.gate)]);
  if (!now.ok) return stop('EVIDENCE', `CHAIN_TIME_UNREADABLE.${now.error}`);
  if (!identity.ok) return stop('EVIDENCE', `GATE_UNREADABLE.${identity.error}`);
  if (!funding.ok) return stop('EVIDENCE', `FUNDING_UNREADABLE.${funding.error}`);
  const cost = buyCost(intent.market, intent.action.quantity);
  const subject = accountResource(c.gate.chainId, c.principalAddress).localId;
  const evidence = digestOf(new ByteWriter().str('robinhood-evm/v1/credential-evidence').u64(now.value.number).str(identity.value.codehash).str(identity.value.domainSeparator).str(deps.custody.principal()).u256(funding.value.allowance).u256(funding.value.balance).u256(cost));
  // Failing results still go to Control, which refuses with them: the refusal names what failed.
  const reason =
    identity.value.codehash !== c.gateCodehash ? 'GATE_CODE_NOT_REVIEWED'
    : identity.value.domainSeparator !== c.domainSeparator ? 'GATE_DOMAIN_NOT_REVIEWED'
    : deps.custody.principal() !== c.principalAddress ? 'CUSTODY_NOT_PRINCIPAL'
    : funding.value.allowance < cost ? 'ALLOWANCE_INSUFFICIENT'
    : funding.value.balance < cost ? 'FUNDING_INSUFFICIENT'
    : null;
  const credential: PreExecutionResult = { kind: 'CREDENTIAL_SCOPE', subject, outcome: reason === null ? 'PASS' : 'FAIL', reason: reason ?? 'GATE_REVIEWED_AND_FUNDED', evidence };
  const scope = slotScope(c.gate.chainId, c.gate.gate, c.principalAddress);
  return { ok: true, value: { now: now.value, credential, scope, nonce: nextSlot(deps.store.readCommitted(c.principal).state, scope) } };
}

// --- 3. construct -------------------------------------------------------------------------------

export function termsFor(deps: GateSignerDeps, intent: Intent, now: bigint, nonce: bigint): Step<ArtifactTerms> {
  const c = deps.config;
  const ceiling = intent.record.validUntil - 1n;
  const deadline = now + c.deadlineSeconds < ceiling ? now + c.deadlineSeconds : ceiling;
  if (deadline < now) return stop('CONSTRUCT', 'AUTHORIZATION_LIFETIME_ENDED');
  return { ok: true, value: { gate: c.gate, market: intent.market, principal: c.principalAddress, agent: c.agentAddress, quantity: intent.action.quantity, nonce, deadline } };
}

export function construct(intent: Intent, terms: ArtifactTerms): Step<GateArtifact> {
  const artifact = buildGateArtifact(intent.source, terms);
  return guard(intent, terms, artifact);
}

/** Exact binding, applied to whatever artifact is about to be admitted. */
export function guard(intent: Intent, terms: ArtifactTerms, artifact: GateArtifact): Step<GateArtifact> {
  const bad = checkGateArtifact(artifact, intent.source, terms);
  return bad === null ? { ok: true, value: artifact } : stop('CONSTRUCT', bad);
}

// --- 4. slot ------------------------------------------------------------------------------------

const ZERO32 = `0x${'0'.repeat(64)}`;

export async function checkSlot(deps: GateSignerDeps, artifact: GateArtifact, evidence: Evidence): Promise<Step<PreExecutionResult>> {
  const consumed = await deps.chain.executionCommitmentOf(artifact.mandateDigest);
  if (!consumed.ok) return stop('SLOT', `REPLAY_KEY_UNREADABLE.${consumed.error}`);
  const unused = consumed.value === ZERO32;
  const digest = digestOf(new ByteWriter().str('robinhood-evm/v1/slot-evidence').str(evidence.scope).u64(artifact.mandate.nonce).str(artifact.mandateDigest).str(consumed.value));
  return { ok: true, value: { kind: 'NONCE_SLOT', subject: evidence.scope, outcome: unused ? 'PASS' : 'FAIL', reason: unused ? 'GATE_REPLAY_KEY_UNUSED' : 'MANDATE_ALREADY_CONSUMED', evidence: digest } };
}

// --- 5. admit -----------------------------------------------------------------------------------

export function admit(deps: GateSignerDeps, intent: Intent, request: IssueRequest, artifact: GateArtifact, evidence: Evidence, slot: PreExecutionResult): Promise<AttemptOutcome> {
  const c = deps.config;
  return deps.engine.admitAttempt(
    intent.record,
    {
      revalidation: { payload: request.payload, states: request.states, context: { ...request.context, evaluationTime: evidence.now.timestamp } },
      adapter: c.adapter,
      venueAccount: intent.action.account,
      artifact: { kind: ARTIFACT_KIND as never, id: hexBytes(artifact.commitment) },
      slot: { scope: evidence.scope as never, sequence: artifact.mandate.nonce },
      // The gate refuses after the deadline (inclusive): nothing under this attempt can land from deadline + 1 on.
      validUntil: artifact.terms.deadline + 1n,
      requirements: [
        { kind: 'CREDENTIAL_SCOPE', subject: evidence.credential.subject },
        { kind: 'NONCE_SLOT', subject: evidence.scope },
      ],
      results: [evidence.credential, slot],
    },
    c.retry,
  );
}

// --- 6. sign ------------------------------------------------------------------------------------

export function signAdmitted(deps: GateSignerDeps, artifact: GateArtifact, terms: ArtifactTerms, attempt: AttemptRecord): Step<{ principal: string; agent: string }> {
  // Custody is given the attempt and the artifact, never a hash: it verifies the durable ADMIT_ATTEMPT itself.
  const p = deps.custody.signMandate(artifact, terms, { attempt: attempt.attempt, reservation: attempt.reservation, generation: attempt.generation, action: attempt.action });
  if (!p.ok) return stop('SIGN', `CUSTODY.${p.error}`);
  if (recoverSigner(principalSigningHash(artifact), p.value) !== deps.config.principalAddress) return stop('SIGN', 'PRINCIPAL_SIGNATURE_NOT_PRINCIPAL');
  const a = deps.agent.signExecution(artifact);
  if (!a.ok) return stop('SIGN', `AGENT.${a.error}`);
  if (recoverSigner(agentSigningHash(artifact), a.value) !== deps.config.agentAddress) return stop('SIGN', 'AGENT_SIGNATURE_NOT_AGENT');
  return { ok: true, value: { principal: p.value, agent: a.value } };
}

// --- 7–9. journal, preflight, submit ------------------------------------------------------------

export async function submit(deps: GateSignerDeps, attempt: AttemptRecord, artifact: GateArtifact, call: GateCall): Promise<IssueOutcome> {
  const j = deps.journal;
  const id = attempt.attempt;
  const opened = j.open(deps.config.principal, id, 'ARTIFACT_ISSUED', hexBytes(call.calldata), 'SIGNED');
  if (!opened.ok) return { status: 'REFUSED', stage: 'JOURNAL', reason: opened.reason, attemptAdmitted: true };
  const pre = await deps.chain.simulate(call);
  if (!pre.ok) {
    // Signed but never broadcast. The artifact exists inside the signer, so nothing is released.
    j.transition(id, 'OUTCOME_UNKNOWN', `PREFLIGHT_REVERTED.${pre.revert.slice(0, 74)}`);
    return { status: 'REFUSED', stage: 'PREFLIGHT', reason: pre.revert, attemptAdmitted: true };
  }
  j.transition(id, 'SUBMISSION_SENT', 'SENT');
  const sent = await deps.chain.submit(call);
  const base = { status: 'ISSUED' as const, attempt: id, mandateDigest: artifact.mandateDigest, commitment: artifact.commitment };
  if (sent.kind !== 'SENT') {
    j.transition(id, 'OUTCOME_UNKNOWN', `SUBMISSION_${sent.error.slice(0, 80)}`);
    return { ...base, txHash: '', issuance: 'OUTCOME_UNKNOWN', detail: sent.error, blockNumber: null, gasUsed: null };
  }
  const r = await deps.chain.receipt(sent.txHash);
  if (!r.ok) {
    j.transition(id, 'OUTCOME_UNKNOWN', `RECEIPT_${r.error.slice(0, 80)}`, sent.txHash);
    return { ...base, txHash: sent.txHash, issuance: 'OUTCOME_UNKNOWN', detail: r.error, blockNumber: null, gasUsed: null };
  }
  // A mined receipt is soft confirmation only; nothing is consumed or released until reconciliation (7F).
  const state: IssuanceState = r.value.status === 'SUCCESS' ? 'SUBMISSION_ACKNOWLEDGED' : 'SUBMISSION_REJECTED';
  const detail = r.value.status === 'SUCCESS' ? 'MINED_SUCCESS' : 'MINED_REVERTED';
  j.transition(id, state, detail, sent.txHash);
  return { ...base, txHash: sent.txHash, issuance: state, detail, blockNumber: r.value.blockNumber, gasUsed: r.value.gasUsed };
}

// --- The production composition ----------------------------------------------------------------

export async function issue(deps: GateSignerDeps, record: AuthorizationRecord, request: IssueRequest): Promise<IssueOutcome> {
  const intent = resolveIntent(deps, record, request.payload);
  if (!intent.ok) return { status: 'REFUSED', stage: intent.stage, reason: intent.reason, attemptAdmitted: false };
  // Before anything else: a generation with an attempt gets that attempt, never another.
  const existing = deps.store.readCommitted(deps.config.principal).state.reservationAttempts.get(record.reservation);
  if (existing !== undefined && existing.length > 0) {
    const id = existing[existing.length - 1] as AttemptId;
    return { status: 'EXISTING', attempt: id, issuance: deps.journal.get(id)?.state ?? null };
  }
  const evidence = await readEvidence(deps, intent.value);
  if (!evidence.ok) return { status: 'REFUSED', stage: evidence.stage, reason: evidence.reason, attemptAdmitted: false };
  const terms = termsFor(deps, intent.value, evidence.value.now.timestamp, evidence.value.nonce);
  if (!terms.ok) return { status: 'REFUSED', stage: terms.stage, reason: terms.reason, attemptAdmitted: false };
  const artifact = construct(intent.value, terms.value);
  if (!artifact.ok) return { status: 'REFUSED', stage: artifact.stage, reason: artifact.reason, attemptAdmitted: false };
  const slot = await checkSlot(deps, artifact.value, evidence.value);
  if (!slot.ok) return { status: 'REFUSED', stage: slot.stage, reason: slot.reason, attemptAdmitted: false };

  const admitted = await admit(deps, intent.value, request, artifact.value, evidence.value, slot.value);
  if (admitted.status === 'EXISTING') return { status: 'EXISTING', attempt: admitted.attempt.attempt, issuance: deps.journal.get(admitted.attempt.attempt)?.state ?? null };
  if (admitted.status !== 'ADMITTED') return { status: 'REFUSED', stage: 'ADMIT', reason: `${admitted.refusal.code}.${admitted.refusal.reason}`, attemptAdmitted: false };

  // ADMIT_ATTEMPT is durable. Only now may a key be used.
  const sigs = signAdmitted(deps, artifact.value, terms.value, admitted.attempt);
  if (!sigs.ok) {
    deps.journal.open(deps.config.principal, admitted.attempt.attempt, 'OUTCOME_UNKNOWN', null, `SIGN_FAILED.${sigs.reason.slice(0, 80)}`);
    return { status: 'REFUSED', stage: 'SIGN', reason: sigs.reason, attemptAdmitted: true };
  }
  const a = artifact.value;
  const attempt: GateAttempt = { mandate: a.mandate, principalSignature: sigs.value.principal, candidate: a.candidate, terms: a.terms, agentSignature: sigs.value.agent };
  return submit(deps, admitted.attempt, a, { calldata: executeCalldata(a.mandate, attempt.principalSignature, a.candidate, a.terms, attempt.agentSignature), attempt });
}
