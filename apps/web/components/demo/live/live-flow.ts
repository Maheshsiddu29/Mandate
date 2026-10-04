/**
 * The Live Demo's presentation state machine.
 *
 * One adaptive workspace moves through these phases. The phase is UI state
 * only: it is derived from local interaction (typing, reviewing) until a
 * mandate is active, and from the run's real MANDATE_LIVE_AI.V1 events
 * after that. It never decides authority, never advances on a timer, and
 * never shows a protocol outcome before the event that carries it.
 */

import type { LiveEvent } from "./live-client.ts";
import { deriveAgents, deriveSettlement, type AgentCard, type SettlementView } from "./live-model.ts";

export const PHASES = [
  "PROMPT",
  "DRAFTING",
  "CONFIGURE",
  "PLANNING",
  "APPROVE",
  "AGENTS_WORKING",
  "MANDATE_REVIEW",
  "ROOM",
  "VERIFYING",
  "AUTHORIZED",
  "SETTLING",
  "COMPLETE",
  "FAILED",
] as const;
export type Phase = (typeof PHASES)[number];

export type Failure = "NO_FEASIBLE" | "REFUSED" | "NOTHING_TO_AUTHORIZE" | "RUN_ERROR" | "PAUSED";

export interface FlowInput {
  /** A prompt is being turned into a draft right now (a real request is open). */
  readonly drafting: boolean;
  /** The server holds a draft for this session. */
  readonly draftPresent: boolean;
  /** The principal asked the agents for a split and is in the Planning Room (before signing). */
  readonly planning?: boolean;
  /** The principal pressed Trade and is reviewing what they are about to sign. */
  readonly reviewing: boolean;
  /** The active signed mandate version, if any. */
  readonly activeVersion: number | null;
  /** The principal is amending an active mandate (a new draft version). */
  readonly amending: boolean;
  /** This page started a run under the active mandate. */
  readonly runStarted: boolean;
  /** The server's task in progress ("RUN", "POLICY_STRESS") or null. */
  readonly task: string | null;
  /** The finished run's status from the session summary, when the server reports one. */
  readonly lastRunStatus: string | null;
  readonly lastError: string | null;
  /** Events of the current run only (sequence after the run began). */
  readonly runEvents: readonly LiveEvent[];
  /** The mandate was paused (revoked) in this session. */
  readonly paused: boolean;
  /** The settlement view corrected by the server's durable state (settlement-restore.ts); events alone otherwise. */
  readonly settlement?: SettlementView;
}

export interface Flow {
  readonly phase: Phase;
  readonly failure: Failure | null;
  /** A short status line for the workspace bar. */
  readonly status: string;
}

const STATUS: Record<Phase, string> = {
  PROMPT: "Define",
  DRAFTING: "Interpreting",
  CONFIGURE: "Review",
  PLANNING: "Planning",
  APPROVE: "Authorize",
  AGENTS_WORKING: "Live",
  MANDATE_REVIEW: "Live",
  ROOM: "Live",
  VERIFYING: "Live",
  AUTHORIZED: "Live",
  SETTLING: "Settling",
  COMPLETE: "Receipt",
  FAILED: "Stopped",
};

/** Subtle progress cue for the shell — not a rigid wizard. */
export function progressStep(phase: Phase): "Define" | "Review" | "Authorize" | "Live" | "Receipt" {
  switch (phase) {
    case "PROMPT":
    case "DRAFTING":
      return "Define";
    case "CONFIGURE":
    case "PLANNING":
      return "Review";
    case "APPROVE":
      return "Authorize";
    case "COMPLETE":
    case "FAILED":
      return "Receipt";
    default:
      return "Live";
  }
}

const TERMINAL_AGENT = new Set(["BLOCKED", "ADMISSIBLE", "ABSTAINED", "TIMED OUT", "FAILED", "INVALID RESPONSE", "RESERVED", "STALE"]);

/** A started agent whose answer Mandate has screened, or that ended without one. */
export function agentSettled(agent: AgentCard): boolean {
  return TERMINAL_AGENT.has(agent.phase);
}

const has = (events: readonly LiveEvent[], kind: string): boolean => events.some((event) => event.kind === kind);

function flow(phase: Phase, failure: Failure | null = null): Flow {
  return { phase, failure, status: failure === null ? STATUS[phase] : STATUS.FAILED };
}

export function deriveFlow(input: FlowInput): Flow {
  if (input.activeVersion === null || input.amending || !input.runStarted) {
    if (input.drafting) return flow("DRAFTING");
    if (!input.draftPresent) return flow("PROMPT");
    if (input.planning === true && !input.reviewing) return flow("PLANNING");
    return flow(input.reviewing ? "APPROVE" : "CONFIGURE");
  }

  const events = input.runEvents;
  if (has(events, "PORTFOLIO_AUTHORIZED")) {
    const settlement = input.settlement ?? deriveSettlement(events);
    // A click is not progress. Only a server stage that is actually underway moves the page.
    const underway = new Set(["PREFLIGHT", "READY", "SIGN_GATE", "SIMULATION", "SEND_REQUIRED", "SUBMITTED", "RECONCILING"]);
    const settling = underway.has(settlement.stage);
    if (settling) return flow("SETTLING");
    if (!settlement.present && input.task === "RUN") return flow("AUTHORIZED");
    return flow("COMPLETE");
  }
  if (has(events, "PORTFOLIO_REFUSED")) return flow("FAILED", "REFUSED");
  if (has(events, "ROOM_NO_FEASIBLE_PORTFOLIO")) return flow("FAILED", "NO_FEASIBLE");
  if (has(events, "MANDATE_REVERIFY_STARTED")) return flow("VERIFYING");
  if (has(events, "ROOM_OPENED")) return flow("ROOM");

  const finished = input.task !== "RUN";
  if (finished && input.paused) return flow("FAILED", "PAUSED");
  if (finished && input.lastError !== null) return flow("FAILED", "RUN_ERROR");
  if (finished && input.lastRunStatus === "NOTHING_TO_AUTHORIZE") return flow("FAILED", "NOTHING_TO_AUTHORIZE");
  if (finished && (input.lastRunStatus === "REFUSED" || input.lastRunStatus === "NO_FEASIBLE_PORTFOLIO")) {
    return flow("FAILED", input.lastRunStatus === "REFUSED" ? "REFUSED" : "NO_FEASIBLE");
  }

  const started = deriveAgents(events).filter((agent) => agent.startedAt !== null);
  if (started.length > 0 && started.every(agentSettled)) return flow("MANDATE_REVIEW");
  return flow("AGENTS_WORKING");
}

/** The events of the run that began after `from` (the last sequence seen when the run was started). */
export function eventsAfter(events: readonly LiveEvent[], from: number | null): LiveEvent[] {
  if (from === null) return [];
  return events.filter((event) => event.sequence > from && !event.kind.startsWith("POLICY_STRESS"));
}
