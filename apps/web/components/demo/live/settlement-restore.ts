/**
 * The settlement state a reloaded page restores (C1.5,
 * docs/demo/c1-browser-complete-settlement.md §9).
 *
 * Events alone cannot say whether an attempt is held. The local server
 * reads that from its settlement journal and portfolio ledger and returns
 * it with the session as `settlement`. This module only parses that object
 * and maps it onto the event-derived view. It never decides that an
 * attempt is held, never reads a clock, and keeps nothing in storage: a
 * missing or malformed object offers no Execute.
 */

import type { Json, LiveEvent } from "./live-client.ts";
import type { SettlementView, V3TechnicalProofView } from "./live-model.ts";

export const RESTORED_STATUSES = ["NO_ATTEMPT", "PREPARED", "SIGNATURE_REQUIRED", "IN_PROGRESS", "HELD", "SUBMITTED", "REVERTED", "NEEDS_REVIEW", "SETTLED", "RELEASED", "PREPARATION_FAILED", "UNREADABLE"] as const;
export type RestoredStatus = (typeof RESTORED_STATUSES)[number];

export interface RestoredSettlement {
  readonly status: RestoredStatus;
  readonly attemptState: string | null;
  readonly quarantine: string | null;
  readonly reservationState: string | null;
  readonly held: boolean;
  /** Chain unix seconds, as the server read them from the journal. */
  readonly heldUntil: string | null;
  readonly txHash: string | null;
  readonly transactions: number | null;
  readonly pending: "AWAITING_SIGNATURE" | "RUNNING" | null;
  readonly executable: boolean;
  readonly asOfEvents: number;
  readonly technicalProof: V3TechnicalProofView | null;
}

const text = (v: Json | undefined): string | null | undefined => (v === null ? null : typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);

function record(value: Json | undefined): { readonly [key: string]: Json } | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function requiredText(value: Json | undefined): string | null {
  const parsed = text(value);
  return parsed === undefined || parsed === null ? null : parsed;
}

function nullableText(value: Json | undefined): string | null | undefined {
  return value === null ? null : requiredText(value) ?? undefined;
}

/** Strict V3 wire normalization. It never fills absent evidence with defaults. */
export function parseV3TechnicalProof(value: Json | undefined): V3TechnicalProofView | null {
  const proof = record(value);
  if (proof === null || proof.version !== "V3" || proof.evidence !== "LIVE_TESTNET" || proof.broadcast !== true) return null;
  const required = {
    sessionId: requiredText(proof.sessionId), candidateId: requiredText(proof.candidateId), walletPrincipal: requiredText(proof.walletPrincipal),
    gate: requiredText(proof.gate), delegate: requiredText(proof.delegate), agent: requiredText(proof.agent),
    delegationDigest: requiredText(proof.delegationDigest), executionNonce: requiredText(proof.executionNonce),
    reservation: requiredText(proof.reservation), initialAllocationDigest: requiredText(proof.initialAllocationDigest),
    initialCapacity: requiredText(proof.initialCapacity), cumulativeDebit: requiredText(proof.cumulativeDebit),
    remainingCapacity: requiredText(proof.remainingCapacity), capacityUnit: requiredText(proof.capacityUnit),
    transactionHash: requiredText(proof.transactionHash), blockNumber: requiredText(proof.blockNumber), gasUsed: requiredText(proof.gasUsed),
    transactionStatus: requiredText(proof.transactionStatus), transactionTo: requiredText(proof.transactionTo), chainId: requiredText(proof.chainId),
    receiptDigest: requiredText(proof.receiptDigest),
  };
  if (Object.values(required).some((item) => item === null) || required.transactionStatus !== "SUCCESS") return null;
  const capacityDecimals = proof.capacityDecimals;
  if (typeof capacityDecimals !== "number" || !Number.isInteger(capacityDecimals) || capacityDecimals < 0 || capacityDecimals > 38) return null;
  const gateMandateDigest = nullableText(proof.gateMandateDigest);
  const gateCandidateDigest = nullableText(proof.gateCandidateDigest);
  const executionApprovalDigest = nullableText(proof.executionApprovalDigest);
  const executionCommitment = nullableText(proof.executionCommitment);
  const gasEstimate = nullableText(proof.gasEstimate);
  const explorerUrl = nullableText(proof.explorerUrl);
  if ([gateMandateDigest, gateCandidateDigest, executionApprovalDigest, executionCommitment, gasEstimate, explorerUrl].some((item) => item === undefined)) return null;
  return {
    version: "V3",
    sessionId: required.sessionId!, candidateId: required.candidateId!, walletPrincipal: required.walletPrincipal!, gate: required.gate!,
    delegate: required.delegate!, agent: required.agent!, delegationDigest: required.delegationDigest!,
    gateMandateDigest: gateMandateDigest!, gateCandidateDigest: gateCandidateDigest!, executionApprovalDigest: executionApprovalDigest!,
    executionCommitment: executionCommitment!, executionNonce: required.executionNonce!, reservation: required.reservation!,
    initialAllocationDigest: required.initialAllocationDigest!, initialCapacity: required.initialCapacity!, cumulativeDebit: required.cumulativeDebit!,
    remainingCapacity: required.remainingCapacity!, capacityUnit: required.capacityUnit!, capacityDecimals, gasEstimate: gasEstimate!,
    transactionHash: required.transactionHash!, blockNumber: required.blockNumber!, gasUsed: required.gasUsed!,
    transactionStatus: required.transactionStatus!, transactionTo: required.transactionTo!, chainId: required.chainId!,
    receiptDigest: required.receiptDigest!, explorerUrl: explorerUrl!, evidence: "LIVE_TESTNET", broadcast: true,
  };
}

/** The server's `settlement` object, or null when it is absent or not exactly that shape. */
export function parseRestored(value: Json | undefined): RestoredSettlement | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const status = value.settlementStatus;
  if (typeof status !== "string" || !(RESTORED_STATUSES as readonly string[]).includes(status)) return null;
  const attemptState = text(value.attemptState);
  const quarantine = text(value.quarantine);
  const reservationState = text(value.reservationState);
  const txHash = text(value.txHash);
  const heldUntil = value.heldUntil === null ? null : typeof value.heldUntil === "string" && /^\d{1,20}$/.test(value.heldUntil) ? value.heldUntil : undefined;
  const transactions = value.transactions === null ? null : typeof value.transactions === "number" && Number.isSafeInteger(value.transactions) && value.transactions >= 0 ? value.transactions : undefined;
  const pending = value.pending === null ? null : value.pending === "AWAITING_SIGNATURE" || value.pending === "RUNNING" ? value.pending : undefined;
  const asOfEvents = typeof value.asOfEvents === "number" && Number.isSafeInteger(value.asOfEvents) && value.asOfEvents >= 0 ? value.asOfEvents : undefined;
  const technicalProof = value.technicalProof === undefined || value.technicalProof === null ? null : parseV3TechnicalProof(value.technicalProof);
  if (attemptState === undefined || quarantine === undefined || reservationState === undefined || txHash === undefined || heldUntil === undefined || transactions === undefined || pending === undefined || asOfEvents === undefined) return null;
  if (typeof value.held !== "boolean" || typeof value.executable !== "boolean" || (value.technicalProof !== undefined && value.technicalProof !== null && technicalProof === null)) return null;
  return { status: status as RestoredStatus, attemptState, quarantine, reservationState, held: value.held, heldUntil, txHash, transactions, pending, executable: value.executable, asOfEvents, technicalProof };
}

const SETTLEMENT_EVENT = /^(TESTNET_|DOMAIN_EXECUTION_|SETTLEMENT_|GATE_EXECUTION_|SPINE_|RESERVATION_(CONSUMED|RELEASED)$)/;

/** A settlement event the server had not seen when it read this state: the events are the later evidence. */
export function staleRestore(restored: RestoredSettlement, events: readonly LiveEvent[]): boolean {
  return events.some((event) => event.sequence >= restored.asOfEvents && SETTLEMENT_EVENT.test(event.kind));
}

/** The refusal that held the attempt; later reconciliation events do not replace it. */
function heldReason(events: readonly LiveEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind === "DOMAIN_EXECUTION_INELIGIBLE" && typeof event.data.reason === "string") return event.data.reason;
  }
  return "";
}

/** Stages only a settle call that is still open can be in. */
const UNDERWAY = new Set<SettlementView["stage"]>(["PREFLIGHT", "READY", "SIGN_GATE", "SIMULATION", "SEND_REQUIRED"]);

function withV3Proof(view: SettlementView, proof: V3TechnicalProofView | null): SettlementView {
  if (proof === null) return view;
  return {
    ...view,
    present: true,
    stage: "SETTLED",
    settled: true,
    v3Proof: proof,
    evidence: proof.evidence,
    network: view.network || "Robinhood Chain Testnet",
    chainId: proof.chainId,
    gate: proof.gate,
    txHash: proof.transactionHash,
    explorerUrl: proof.explorerUrl,
    block: proof.blockNumber,
    gasUsed: proof.gasUsed,
    receiptStatus: proof.transactionStatus,
    candidateId: proof.candidateId,
    mandateDigest: proof.gateMandateDigest ?? view.mandateDigest,
    gasEstimate: proof.gasEstimate ?? view.gasEstimate,
    reservationId: proof.reservation,
    initialAllocationDigest: proof.initialAllocationDigest,
    walletPrincipal: proof.walletPrincipal,
    receiptDigest: proof.receiptDigest,
    commitmentRecorded: proof.executionCommitment !== null || view.commitmentRecorded,
  };
}

/**
 * The event view, corrected by the durable state where the events cannot
 * know: a hold, a call that died with the server, a hash the journal kept.
 * An open settle call, or a read older than the events, changes nothing.
 */
export function restoreSettlement(view: SettlementView, events: readonly LiveEvent[], restored: RestoredSettlement | null): SettlementView {
  if (restored === null || restored.pending !== null || staleRestore(restored, events)) return view;
  const closed = { settled: false, gateSign: null } as const;
  switch (restored.status) {
    case "HELD":
      return { ...view, ...closed, present: true, stage: "HELD", txHash: null, detail: heldReason(events) };
    case "SUBMITTED":
      if (view.stage === "SUBMITTED" || view.stage === "RECONCILING") return { ...view, txHash: view.txHash ?? restored.txHash };
      return { ...view, ...closed, present: true, stage: "SUBMITTED", txHash: restored.txHash };
    case "REVERTED":
      return { ...view, ...closed, present: true, stage: "FAILED", txHash: restored.txHash ?? view.txHash };
    case "NEEDS_REVIEW":
      return { ...view, ...closed, present: true, stage: "NEEDS_REVIEW", txHash: restored.txHash ?? view.txHash };
    case "RELEASED":
      return { ...view, ...closed, present: true, stage: "RELEASED", txHash: restored.txHash ?? view.txHash };
    case "SETTLED":
      // Durable SETTLED is evidence-only: hydrate proof, never reopen execute/auto-settle.
      return withV3Proof({
        ...view,
        present: true,
        stage: "SETTLED",
        settled: true,
        gateSign: null,
        consumed: view.consumed || restored.attemptState === "CONSUMED",
        txHash: restored.txHash ?? view.txHash,
      }, restored.technicalProof);
    case "UNREADABLE":
      return view;
    default:
      // No open call and nothing signed: whatever was underway ended with the process that ran it.
      return UNDERWAY.has(view.stage) ? { ...view, ...closed, stage: "FAILED", detail: "SETTLEMENT_INTERRUPTED" } : view;
  }
}

/** Execute is offered only when the server's durable state is current and leaves room for a new attempt. */
export function executeOffered(restored: RestoredSettlement | null, events: readonly LiveEvent[]): boolean {
  return restored !== null && restored.executable && !staleRestore(restored, events);
}

/** A held attempt is resolved by reconciliation only; the page may ask for it while no settle call is open. */
export function reconcileOffered(restored: RestoredSettlement | null): boolean {
  return restored !== null && restored.held && restored.pending === null;
}

const STATE_UNVERIFIED = /^(GATE_STATE_UNKNOWN|CHAIN_TIME_UNREADABLE)\./;

/** The held notice. `format` renders unix milliseconds; the time is the server's chain time. */
export function heldCopy(input: { readonly reason: string; readonly heldUntil: string | null }, format: (ms: number) => string): { readonly title: string; readonly line: string; readonly until: string } {
  const line = STATE_UNVERIFIED.test(input.reason)
    ? "Mandate signed the exact execution, but chain state could not be verified. Nothing was sent."
    : "An execution authorization for this reservation may exist, so the attempt is held for reconciliation. Nothing was sent.";
  const until = input.heldUntil === null ? "This authorization remains quarantined until every artifact it signed has expired. It is never resent." : `Reconciliation hold ends after ${format(Number(input.heldUntil) * 1000)}. It is never resent.`;
  return { title: "Execution held", line, until };
}
