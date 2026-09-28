/**
 * The issuance boundary for Lighter (Phase 7E.1; attempt-lifecycle.md §3).
 *
 * ```text
 * authorization + reservation (committed by Control)
 *   │ 1 resolve   the exact authorization, module, adapter, account; payload decodes to the op requested
 *   │ 2 evidence  CREDENTIAL_SCOPE over the venue's key listing; NONCE_SLOT over the venue's next nonce
 *   │ 3 construct the exact unsigned transaction; allowlist; field-by-field binding re-derivation
 *   │ 4 hash      the venue's own transaction hash — custody computes it without the key
 *   │ 5 admit     Control.admitAttempt: revalidation, module/adapter trust, pre-execution results,
 *   │             ADMIT_ATTEMPT naming that hash and nonce slot, durably committed
 *   │ 6 sign      ONLY NOW: custody signs exactly the committed hash
 *   │ 7 journal   ARTIFACT_ISSUED, the signed bytes kept inside the signer
 *   │ 8 submit    SUBMISSION_SENT → ACKNOWLEDGED | REJECTED | OUTCOME_UNKNOWN
 *   ▼
 * the agent gets: attempt id, venue transaction hash, issuance state — never the signed transaction
 * ```
 *
 * Nothing before step 5 can produce an artifact, so a refusal or crash there
 * leaves `NEVER_ISSUED` available. From step 5 on, every failure — a crash, a
 * custody error, a timeout, an API error — leaves the attempt admitted and the
 * reservation held; there is no automatic resubmission and no fresh attempt
 * (the adapter descriptor's `resubmission:none`), because Lighter's nonce and
 * retry semantics are not yet evidenced (testnet-evidence.md). A second
 * request for the same generation gets the existing attempt (`EXISTING`).
 *
 * The stages are separate functions so the mutation suite can recompose them
 * and show every safety probe fails for every reordering or omission. They
 * are not exported from the package: `VenueSigner` is the only composition.
 */

import { actionPayloadDigest, moduleRefsEqual, adapterRefsEqual, type AdapterRef, type ModuleRef, type PrincipalId, type ReservationId } from '@mandate/core';
import type { AttemptId, AttemptRecord, RetryPolicy } from '@mandate/ledger';
import type { AttemptOutcome, AuthorizationRecord, ControlEngine, EvaluationContextInput, PreExecutionResult, SuppliedState } from '@mandate/control';
import type { IssuanceJournal, IssuanceState, SqliteLedgerStore } from '@mandate/ledger-sqlite';
import { ALLOWED_TX_TYPES, TX_TYPE_CODE, type AllowedTxType } from './adapter.ts';
import type { CustodyTx, KeyCustody, SignedTx } from './custody.ts';
import { credentialScope, credentialSubject, highestAdmittedSlot, nonceSlot } from './evidence.ts';
import { ARTIFACT_KIND, clientOrderIndexFor, slotScope, txHashBytes } from './identity.ts';
import { buildCancelTx, buildOrderTx, checkAllowed, checkBinding, type SignerIdentity } from './tx.ts';
import { ACTION_CANCEL_ORDER, ACTION_CREATE_ORDER, accountIndexOf, decodeAction, type DecodedCancel, type DecodedOrder } from './vocabulary.ts';
import type { VenueClient } from './venue.ts';

export interface SignerConfig extends SignerIdentity {
  readonly principal: PrincipalId;
  readonly adapter: AdapterRef;
  readonly policy: ModuleRef;
  /** Lighter `ExpiredAt` window from issue time, in ms; always bounded by the authorization. */
  readonly txTtlMs: bigint;
  readonly retry: RetryPolicy;
}

export interface SignerDeps {
  readonly engine: ControlEngine;
  readonly store: SqliteLedgerStore;
  readonly journal: IssuanceJournal;
  readonly custody: KeyCustody;
  readonly venue: VenueClient;
  /** Milliseconds since the epoch. The signer's own clock sets the issue time; the caller's context cannot. */
  readonly clock: () => bigint;
  readonly config: SignerConfig;
}

export interface IssueRequest {
  /** The payload the authorization's action commits to. */
  readonly payload: Uint8Array;
  /** Fresh state for issue-time revalidation. */
  readonly states: readonly SuppliedState[];
  /** Sources, block heads and watermarks; `evaluationTime` is replaced by the signer's clock. */
  readonly context: EvaluationContextInput;
}

export type IssueStage = 'RESOLVE' | 'EVIDENCE' | 'CONSTRUCT' | 'HASH' | 'ADMIT' | 'SIGN' | 'JOURNAL';

/** What the agent receives. There is deliberately no field for the signed transaction. */
export type IssueOutcome =
  | { readonly status: 'ISSUED'; readonly attempt: AttemptId; readonly txHash: string; readonly issuance: IssuanceState; readonly detail: string }
  | { readonly status: 'EXISTING'; readonly attempt: AttemptId; readonly issuance: IssuanceState | null }
  | { readonly status: 'REFUSED'; readonly stage: IssueStage; readonly reason: string; readonly attemptAdmitted: boolean };

export type Op = 'ORDER' | 'CANCEL';

export interface Intent {
  readonly op: Op;
  readonly action: DecodedOrder | DecodedCancel;
  readonly record: AuthorizationRecord;
  readonly nowMs: bigint;
  readonly expiredAt: bigint;
  /** The artifact's own validity end, in seconds: its `ExpiredAt`, or a GTT order's expiry if later. */
  readonly validUntil: bigint;
}

export type Step<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly stage: IssueStage; readonly reason: string };

const stop = (stage: IssueStage, reason: string): Step<never> => ({ ok: false, stage, reason });
const MS = 1_000n;
/** Lighter refuses an order expiry under 5 minutes (L-ORD-4); the margin absorbs clock skew to the sequencer. */
const MIN_ORDER_LIFE_MS = 5n * 60n * MS + 30n * MS;

// --- 1. resolve --------------------------------------------------------------------------

export function resolveIntent(deps: SignerDeps, op: Op, record: AuthorizationRecord, payload: Uint8Array): Step<Intent> {
  const c = deps.config;
  if (!moduleRefsEqual(record.module, c.policy)) return stop('RESOLVE', 'MODULE_NOT_THIS_POLICY');
  if (!adapterRefsEqual(record.adapter, c.adapter)) return stop('RESOLVE', 'ADAPTER_NOT_THIS_SIGNER');
  if (record.principal.kind !== c.principal.kind || record.principal.value !== c.principal.value) return stop('RESOLVE', 'PRINCIPAL_NOT_THIS_SIGNER');
  // The payload must be exactly the one the authorization's action committed to: nothing about the order is taken from the request.
  const digest = actionPayloadDigest(record.module, payload);
  if (!digest.ok || digest.value !== record.action.payloadDigest) return stop('RESOLVE', 'PAYLOAD_NOT_AUTHORIZED');
  const expectedType = op === 'ORDER' ? ACTION_CREATE_ORDER : ACTION_CANCEL_ORDER;
  if (record.action.actionType !== expectedType) return stop('RESOLVE', 'ACTION_TYPE_NOT_THIS_OPERATION');
  const action = decodeAction(payload);
  if (action === null || (op === 'ORDER') !== (action.kind === 'ORDER')) return stop('RESOLVE', 'PAYLOAD_NOT_THIS_OPERATION');
  if (accountIndexOf(action.account, c.chainId) !== c.accountIndex) return stop('RESOLVE', 'ACCOUNT_NOT_THIS_SIGNER');
  const nowMs = deps.clock();
  const ceilingMs = record.validUntil * MS;
  const expiredAt = nowMs + c.txTtlMs < ceilingMs ? nowMs + c.txTtlMs : ceilingMs;
  if (expiredAt <= nowMs) return stop('RESOLVE', 'AUTHORIZATION_LIFETIME_ENDED');
  let endMs = expiredAt;
  if (action.kind === 'ORDER' && action.orderExpiryMs > 0n) {
    // A resting order must die by the attempt ceiling (EXEC-3) and live the venue's minimum.
    if (action.orderExpiryMs > ceilingMs) return stop('RESOLVE', 'ORDER_OUTLIVES_AUTHORIZATION');
    if (action.orderExpiryMs < nowMs + MIN_ORDER_LIFE_MS) return stop('RESOLVE', 'ORDER_EXPIRY_TOO_SOON');
    if (action.orderExpiryMs > endMs) endMs = action.orderExpiryMs;
  }
  return { ok: true, value: { op, action, record, nowMs, expiredAt, validUntil: (endMs + MS - 1n) / MS } };
}

// --- 2. evidence --------------------------------------------------------------------------

export async function readPreExecution(deps: SignerDeps): Promise<Step<{ results: readonly PreExecutionResult[]; nonce: bigint; scope: string }>> {
  const c = deps.config;
  const scope = slotScope(c.chainId, c.accountIndex, c.apiKeyIndex);
  const [keys, next, pk] = await Promise.all([deps.venue.apiKeys(c.accountIndex), deps.venue.nextNonce(c.accountIndex, c.apiKeyIndex), deps.custody.publicKey()]);
  if (!keys.ok) return stop('EVIDENCE', `API_KEYS_UNREADABLE.${keys.error}`);
  if (!next.ok) return stop('EVIDENCE', `NONCE_UNREADABLE.${next.error}`);
  if (!pk.ok) return stop('EVIDENCE', `CUSTODY_UNAVAILABLE.${pk.error}`);
  const credential = credentialScope(keys.value, { chainId: c.chainId, accountIndex: c.accountIndex, apiKeyIndex: c.apiKeyIndex, publicKey: pk.value });
  const ledger = deps.store.readCommitted(c.principal);
  const slot = nonceSlot(next.value, highestAdmittedSlot(ledger.state, scope), scope);
  // Failing results are still returned to Control, which refuses with them: the refusal names what failed.
  return { ok: true, value: { results: [credential, slot.result], nonce: slot.nonce ?? next.value, scope } };
}

// --- 3. construct ----------------------------------------------------------------------------

export function construct(deps: SignerDeps, intent: Intent, nonce: bigint): Step<CustodyTx> {
  const id: SignerIdentity = deps.config;
  const reservation: ReservationId = intent.record.reservation;
  const tx = intent.action.kind === 'ORDER' ? buildOrderTx(intent.action, id, reservation, nonce, intent.expiredAt) : buildCancelTx(intent.action, id, nonce, intent.expiredAt);
  if (tx === null) return stop('CONSTRUCT', 'MARKET_NOT_ON_CHAIN');
  return guard(deps, intent, tx, nonce);
}

/** Allowlist and exact binding: applied to whatever transaction is about to be hashed. */
export function guard(deps: SignerDeps, intent: Intent, tx: CustodyTx, nonce: bigint): Step<CustodyTx> {
  const forbidden = checkAllowed(tx);
  if (forbidden !== null) return stop('CONSTRUCT', forbidden);
  const mismatch = checkBinding(tx, intent.action, deps.config, intent.record.reservation, nonce, intent.expiredAt);
  if (mismatch !== null) return stop('CONSTRUCT', mismatch);
  return { ok: true, value: tx };
}

// --- 4. hash ------------------------------------------------------------------------------------

export async function hashTx(deps: SignerDeps, tx: CustodyTx): Promise<Step<{ hash: string; bytes: Uint8Array }>> {
  const h = await deps.custody.hash(tx);
  if (!h.ok) return stop('HASH', h.error);
  if (h.value.txType !== TX_TYPE_CODE[tx.type as AllowedTxType]) return stop('HASH', 'TX_TYPE_CODE_MISMATCH');
  const bytes = txHashBytes(h.value.hash);
  if (bytes === null) return stop('HASH', 'TX_HASH_MALFORMED');
  return { ok: true, value: { hash: h.value.hash, bytes } };
}

// --- 5. admit ------------------------------------------------------------------------------------

export function admit(deps: SignerDeps, intent: Intent, request: IssueRequest, tx: CustodyTx, hashed: { bytes: Uint8Array }, scope: string, results: readonly PreExecutionResult[]): Promise<AttemptOutcome> {
  const c = deps.config;
  const account = intent.action.account;
  return deps.engine.admitAttempt(
    intent.record,
    {
      revalidation: { payload: request.payload, states: request.states, context: { ...request.context, evaluationTime: intent.nowMs / MS } },
      adapter: c.adapter,
      venueAccount: account,
      artifact: { kind: ARTIFACT_KIND as never, id: hashed.bytes },
      slot: { scope: scope as never, sequence: tx.nonce },
      validUntil: intent.validUntil,
      requirements: [
        { kind: 'CREDENTIAL_SCOPE', subject: credentialSubject(c.chainId, c.accountIndex) },
        { kind: 'NONCE_SLOT', subject: scope },
      ],
      results,
    },
    c.retry,
  );
}

// --- 6–8. sign, journal, submit --------------------------------------------------------------

export async function signAdmitted(deps: SignerDeps, tx: CustodyTx, hash: string, attempt: AttemptRecord): Promise<Step<SignedTx>> {
  const signed = await deps.custody.sign(tx, hash, attempt.attempt);
  if (!signed.ok) return stop('SIGN', signed.error);
  if (signed.value.hash !== hash) return stop('SIGN', 'SIGNED_HASH_NOT_COMMITTED');
  return { ok: true, value: signed.value };
}

export async function submit(deps: SignerDeps, attempt: AttemptRecord, signed: SignedTx): Promise<IssueOutcome> {
  const j = deps.journal;
  const id = attempt.attempt;
  const opened = j.open(deps.config.principal, id, 'ARTIFACT_ISSUED', new TextEncoder().encode(signed.txInfo), 'SIGNED');
  if (!opened.ok) return { status: 'REFUSED', stage: 'JOURNAL', reason: opened.reason, attemptAdmitted: true };
  j.transition(id, 'SUBMISSION_SENT', 'SENT');
  const sent = await deps.venue.sendTx(signed.txType, signed.txInfo);
  let state: IssuanceState;
  let detail: string;
  if (sent.kind === 'ACK' && sent.txHash.replace(/^0x/, '') === signed.hash) {
    state = 'SUBMISSION_ACKNOWLEDGED';
    detail = 'API_ACCEPTED_SYNTAX';
  } else if (sent.kind === 'ACK') {
    // Accepted, but under another hash than the one committed: the outcome of ours is unknown.
    state = 'OUTCOME_UNKNOWN';
    detail = 'ACK_HASH_MISMATCH';
  } else if (sent.kind === 'REJECTED') {
    state = 'SUBMISSION_REJECTED';
    detail = `API_CODE_${sent.code}`;
  } else {
    state = 'OUTCOME_UNKNOWN';
    detail = `SUBMISSION_${sent.error}`;
  }
  j.transition(id, state, detail, sent.kind === 'ACK' ? sent.txHash : null);
  return { status: 'ISSUED', attempt: id, txHash: signed.hash, issuance: state, detail };
}

// --- The production composition -------------------------------------------------------------

export async function issue(deps: SignerDeps, op: Op, record: AuthorizationRecord, request: IssueRequest): Promise<IssueOutcome> {
  const intent = resolveIntent(deps, op, record, request.payload);
  if (!intent.ok) return { status: 'REFUSED', stage: intent.stage, reason: intent.reason, attemptAdmitted: false };
  // Before anything else: a generation with an attempt gets that attempt, never another.
  const existing = deps.store.readCommitted(deps.config.principal).state.reservationAttempts.get(record.reservation);
  if (existing !== undefined && existing.length > 0) {
    const id = existing[existing.length - 1] as AttemptId;
    return { status: 'EXISTING', attempt: id, issuance: deps.journal.get(id)?.state ?? null };
  }
  const evidence = await readPreExecution(deps);
  if (!evidence.ok) return { status: 'REFUSED', stage: evidence.stage, reason: evidence.reason, attemptAdmitted: false };
  const tx = construct(deps, intent.value, evidence.value.nonce);
  if (!tx.ok) return { status: 'REFUSED', stage: tx.stage, reason: tx.reason, attemptAdmitted: false };
  const hashed = await hashTx(deps, tx.value);
  if (!hashed.ok) return { status: 'REFUSED', stage: hashed.stage, reason: hashed.reason, attemptAdmitted: false };

  const admitted = await admit(deps, intent.value, request, tx.value, hashed.value, evidence.value.scope, evidence.value.results);
  if (admitted.status === 'EXISTING') return { status: 'EXISTING', attempt: admitted.attempt.attempt, issuance: deps.journal.get(admitted.attempt.attempt)?.state ?? null };
  if (admitted.status !== 'ADMITTED') return { status: 'REFUSED', stage: 'ADMIT', reason: `${admitted.refusal.code}.${admitted.refusal.reason}`, attemptAdmitted: false };

  // ADMIT_ATTEMPT is durable. Only now may the key be used.
  const signed = await signAdmitted(deps, tx.value, hashed.value.hash, admitted.attempt);
  if (!signed.ok) {
    // No artifact is recorded, but one may exist: the attempt stays admitted, the reservation held.
    deps.journal.open(deps.config.principal, admitted.attempt.attempt, 'OUTCOME_UNKNOWN', null, `SIGN_FAILED.${signed.reason}`);
    return { status: 'REFUSED', stage: 'SIGN', reason: signed.reason, attemptAdmitted: true };
  }
  return submit(deps, admitted.attempt, signed.value);
}

/** The client order index a create-order under `record` carries: the agent's handle for later lookups. */
export function orderReference(record: AuthorizationRecord): bigint {
  return clientOrderIndexFor(record.reservation);
}

export { ALLOWED_TX_TYPES };
