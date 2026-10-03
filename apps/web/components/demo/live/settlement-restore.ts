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
import type { SettlementView } from "./live-model.ts";

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
}

const text = (v: Json | undefined): string | null | undefined => (v === null ? null : typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);

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
  if (attemptState === undefined || quarantine === undefined || reservationState === undefined || txHash === undefined || heldUntil === undefined || transactions === undefined || pending === undefined || asOfEvents === undefined) return null;
  if (typeof value.held !== "boolean" || typeof value.executable !== "boolean") return null;
  return { status: status as RestoredStatus, attemptState, quarantine, reservationState, held: value.held, heldUntil, txHash, transactions, pending, executable: value.executable, asOfEvents };
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
      return { ...view, gateSign: null, consumed: view.consumed || restored.attemptState === "CONSUMED" };
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
