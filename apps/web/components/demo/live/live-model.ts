/**
 * Presentation derived from MANDATE_LIVE_AI.V1 events and the session view.
 *
 * This module does not decide authority. It reads fields the runtime already
 * emitted. Typed-resource conflicts stay one line each; reductions are never
 * added together.
 */

import { amount, arr, code, rec, str, type Json, type JsonRecord, type LiveEvent } from "./live-client.ts";

export const ROLES = ["stock", "swap", "nft", "yield", "perps"] as const;
export type RoleName = (typeof ROLES)[number];

export const ROLE_TITLES: Record<RoleName, string> = {
  stock: "Stock",
  swap: "Swap",
  nft: "NFT",
  yield: "Yield",
  perps: "Perps",
};

/** High-level activity while a provider call is open. Not model reasoning. */
export const ACTIVITY: Record<RoleName, string> = {
  stock: "Comparing approved representations…",
  swap: "Evaluating available routes…",
  nft: "Evaluating listings…",
  yield: "Comparing supplied opportunities…",
  perps: "Evaluating bounded exposure…",
};

const HARD_BLOCK = new Set([
  "VENUE_NOT_ALLOWED",
  "RECIPIENT_NOT_ALLOWED",
  "ASSET_NOT_ALLOWED",
  "REPRESENTATION_NOT_ALLOWED",
  "ISSUER_NOT_ALLOWED",
  "INSTRUMENT_UNKNOWN",
  "SYNTHETIC_NOT_ALLOWED",
]);

export interface AgentCard {
  readonly role: RoleName;
  readonly title: string;
  readonly activity: string;
  readonly phase: string;
  readonly candidate: string;
  readonly requested: string;
  readonly rationale: string;
  readonly providerMs: number | null;
  readonly firstResponseMs: number | null;
  readonly validationMs: number | null;
  readonly signingMs: number | null;
  readonly mandateMs: number | null;
  readonly mandateLabel: string;
  readonly reasons: readonly string[];
  readonly hardBlock: boolean;
  readonly portfolioConflict: boolean;
  readonly inRoom: boolean;
  readonly roomNote: string;
  readonly ignored: "LATE" | "STALE" | null;
  readonly timedOut: boolean;
  readonly finalOutcome: string;
  readonly finalAmount: string;
  readonly startedAt: string | null;
}

export interface ResourceLine {
  readonly resource: string;
  readonly demand: string;
  readonly authority: string;
  readonly reduction: string;
  readonly demandAfter: string | null;
  readonly status: "CONFLICT" | "OK" | "SATISFIED" | "UNRESOLVED";
}

export interface RoomView {
  readonly open: boolean;
  readonly roomId: string | null;
  readonly generation: number | null;
  readonly proposal: boolean;
  readonly reverify: boolean;
  readonly authorized: boolean;
  readonly refused: boolean;
  readonly noFeasible: boolean;
  readonly lines: readonly ResourceLine[];
  readonly notes: readonly { readonly sequence: number; readonly agent: string | null; readonly text: string }[];
}

export interface StressAttempt {
  readonly attempt: string;
  readonly caseId: string;
  readonly rationale: string;
  readonly outcome: string;
  readonly reasons: readonly string[];
  readonly screening: string;
  readonly identity: JsonRecord;
  readonly note: string;
  readonly sameSigner: boolean;
}

export interface SettlementView {
  readonly present: boolean;
  readonly stage: "NONE" | "PREFLIGHT" | "PREFLIGHT_FAILED" | "READY" | "SIMULATION" | "SIMULATION_FAILED" | "SEND_REQUIRED" | "SUBMITTED" | "FAILED" | "SETTLED";
  readonly settled: boolean;
  readonly evidence: string | null;
  readonly network: string;
  readonly chainId: string;
  readonly gate: string;
  readonly txHash: string | null;
  readonly explorerUrl: string | null;
  readonly block: string | null;
  readonly gasUsed: string | null;
  readonly receiptStatus: string | null;
  readonly decisionNotional: string | null;
  readonly fixtureIn: string | null;
  readonly fixtureOut: string | null;
  readonly qualification: string;
  readonly detail: string;
}

export interface LivePresentation {
  readonly agents: readonly AgentCard[];
  readonly room: RoomView;
  readonly stress: { readonly started: boolean; readonly attempts: readonly StressAttempt[]; readonly ended: string };
  readonly settlement: SettlementView;
  readonly blocked: number;
  readonly admissible: number;
  readonly roomGenerations: number;
  readonly paused: boolean;
  readonly amendmentRefused: string | null;
  readonly reverifySeen: boolean;
}

function blank(role: RoleName): AgentCard {
  return {
    role,
    title: ROLE_TITLES[role],
    activity: ACTIVITY[role],
    phase: "WAITING",
    candidate: "—",
    requested: "—",
    rationale: "",
    providerMs: null,
    firstResponseMs: null,
    validationMs: null,
    signingMs: null,
    mandateMs: null,
    mandateLabel: "WAITING",
    reasons: [],
    hardBlock: false,
    portfolioConflict: false,
    inRoom: false,
    roomNote: "",
    ignored: null,
    timedOut: false,
    finalOutcome: "",
    finalAmount: "",
    startedAt: null,
  };
}

function num(v: Json | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function reasonsOf(v: Json | undefined): string[] {
  return arr(v).map((item) => code(item));
}

function hard(reasons: readonly string[]): boolean {
  return reasons.some((reason) => HARD_BLOCK.has(reason));
}

/** Display a millisecond reading on its own scale. Seconds and milliseconds are not one bar. */
export function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) {
    const whole = Math.floor(value / 1000);
    const frac = Math.floor(value % 1000);
    return `${whole}.${String(frac).padStart(3, "0").slice(0, 2)}s`;
  }
  return `${value} ms`;
}

function shownAmount(v: Json | undefined): string {
  return typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? `${v} USDC` : amount(v);
}

function amountText(v: Json | undefined): string {
  const text = amount(v);
  return text === "—" ? "—" : text.replace(/ USDC$/, "");
}

function lineFromConflict(raw: Json): ResourceLine | null {
  const c = rec(raw);
  const resource = str(c.resource);
  if (resource === "—") return null;
  const after = c.demandAfter === undefined ? null : amountText(c.demandAfter);
  const status = c.status === "SATISFIED" ? "SATISFIED" : c.status === "UNRESOLVED" ? "UNRESOLVED" : "CONFLICT";
  const reduction = c.remainingReduction === undefined ? c.requiredReduction : c.remainingReduction;
  return {
    resource,
    demand: amountText(c.demand),
    authority: amountText(c.authority),
    reduction: amountText(reduction),
    demandAfter: after,
    status,
  };
}

/** Display an integer atom string the runtime already computed. Not a new limit and not a sum across resources. */
export function formatAtoms(atoms: string): string {
  if (!/^-?\d+$/.test(atoms)) return atoms;
  const value = BigInt(atoms);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const text = frac === "" ? whole.toString() : `${whole}.${frac}`;
  return negative ? `-${text}` : text;
}

function lineFromConstraint(raw: Json): ResourceLine | null {
  const row = rec(raw);
  const resource = str(row.resource);
  if (resource === "—") return null;
  const reduction = str(row.requiredReductionAtoms);
  const open = reduction !== "0" && reduction !== "—";
  return {
    resource,
    demand: formatAtoms(str(row.demandAtoms)),
    authority: formatAtoms(str(row.authorityAtoms)),
    reduction: open ? formatAtoms(reduction) : "0",
    demandAfter: null,
    status: open ? "CONFLICT" : "OK",
  };
}

/** One line per resource. Never a sum of reductions. */
export function resourceLines(events: readonly LiveEvent[]): ResourceLine[] {
  let lines: ResourceLine[] = [];
  for (const event of events) {
    if (event.kind !== "PORTFOLIO_CONFLICT" && event.kind !== "ROOM_GENERATION_STARTED" && event.kind !== "ROOM_PROPOSAL_CREATED" && event.kind !== "ROOM_NO_FEASIBLE_PORTFOLIO") continue;
    const constraints = arr(event.data.constraints).map(lineFromConstraint).filter((line): line is ResourceLine => line !== null);
    const conflicts = arr(event.data.conflicts).map(lineFromConflict).filter((line): line is ResourceLine => line !== null);
    if (constraints.length === 0 && conflicts.length === 0) continue;
    if (constraints.length === 0) {
      lines = conflicts;
      continue;
    }
    const byResource = new Map(conflicts.map((line) => [line.resource, line]));
    lines = constraints.map((line) => byResource.get(line.resource) ?? line);
    for (const line of conflicts) if (!lines.some((item) => item.resource === line.resource)) lines.push(line);
  }
  return lines;
}

function participants(events: readonly LiveEvent[]): Set<string> {
  const names = new Set<string>();
  for (const event of events) {
    if (event.kind !== "ROOM_OPENED" && event.kind !== "ROOM_GENERATION_STARTED") continue;
    for (const item of arr(event.data.participants)) if (typeof item === "string") names.add(item);
  }
  return names;
}

function applyTiming(card: AgentCard, row: JsonRecord | undefined): AgentCard {
  if (row === undefined) return card;
  return {
    ...card,
    providerMs: card.providerMs ?? num(row.providerLatencyMs),
    firstResponseMs: card.firstResponseMs ?? num(row.timeToFirstResponseMs),
    validationMs: num(row.validationLatencyMs),
    signingMs: num(row.signingLatencyMs),
    mandateMs: num(row.mandateLatencyMs),
  };
}

export function deriveAgents(events: readonly LiveEvent[], timing: readonly JsonRecord[] = []): AgentCard[] {
  const cards = new Map<RoleName, AgentCard>(ROLES.map((role) => [role, blank(role)]));
  const room = participants(events);
  for (const event of events) {
    if (event.kind.startsWith("POLICY_STRESS")) continue;
    const data = event.data;
    if (event.kind === "PORTFOLIO_AUTHORIZED" || event.kind === "PORTFOLIO_REFUSED") {
      for (const item of arr(data.proposals)) {
        const row = rec(item);
        const role = str(row.role);
        const card = cards.get(role as RoleName);
        if (card === undefined) continue;
        const outcome = str(row.outcome);
        cards.set(role as RoleName, { ...card, finalOutcome: outcome, finalAmount: shownAmount(row.requested), phase: outcome === "RESERVED" ? "RESERVED" : card.phase });
      }
      continue;
    }
    if (event.agent === null || !ROLES.includes(event.agent as RoleName)) continue;
    const role = event.agent as RoleName;
    const card = cards.get(role) ?? blank(role);
    switch (event.kind) {
      case "AGENT_REQUEST_STARTED":
        cards.set(role, { ...blank(role), phase: "PENDING", startedAt: event.at });
        break;
      case "AGENT_FIRST_RESPONSE":
        cards.set(role, { ...card, phase: "RESPONDING", firstResponseMs: num(data.timeToFirstResponseMs) ?? card.firstResponseMs });
        break;
      case "AGENT_DECISION_COMPLETED":
        cards.set(role, {
          ...card,
          phase: "RESPONDED",
          candidate: str(data.candidateId),
          requested: amount(data.requested),
          rationale: str(data.rationale) === "—" ? "" : str(data.rationale),
          providerMs: num(data.providerLatencyMs),
          firstResponseMs: num(data.timeToFirstResponseMs) ?? card.firstResponseMs,
          mandateLabel: "CHECKING",
        });
        break;
      case "AGENT_ABSTAINED":
        cards.set(role, { ...card, phase: "ABSTAINED", mandateLabel: "ABSTAINED", rationale: str(data.rationale) === "—" ? "" : str(data.rationale), providerMs: num(data.providerLatencyMs) });
        break;
      case "AGENT_TIMED_OUT":
        cards.set(role, { ...card, phase: "TIMED OUT", timedOut: true, mandateLabel: "NO ALLOCATION CHANGE" });
        break;
      case "AGENT_FAILED":
        cards.set(role, { ...card, phase: "FAILED", mandateLabel: "PROVIDER" });
        break;
      case "AGENT_INVALID_RESPONSE":
        cards.set(role, { ...card, phase: "INVALID RESPONSE", mandateLabel: "INVALID RESPONSE" });
        break;
      case "PROPOSAL_SIGNED":
        if (data.phase === undefined) cards.set(role, { ...card, phase: card.phase === "RESPONDED" ? "SIGNED" : card.phase });
        break;
      case "PROPOSAL_BLOCKED": {
        const list = reasonsOf(data.reasons);
        cards.set(role, { ...card, phase: "BLOCKED", mandateLabel: "BLOCKED", reasons: list, hardBlock: hard(list), portfolioConflict: false, inRoom: false });
        break;
      }
      case "PROPOSAL_ADMISSIBLE": {
        const list = reasonsOf(data.reasons);
        const conflict = data.portfolioValid === false;
        cards.set(role, {
          ...card,
          phase: conflict ? "ADMISSIBLE" : "ADMISSIBLE",
          mandateLabel: conflict ? "PORTFOLIO CONFLICT" : "ADMISSIBLE",
          reasons: list,
          hardBlock: false,
          portfolioConflict: conflict,
        });
        break;
      }
      case "PROPOSAL_STALE":
        cards.set(role, { ...card, phase: "STALE", mandateLabel: `STALE → ${str(data.next)}` });
        break;
      case "ROOM_AGENT_RESPONSE":
        cards.set(role, {
          ...card,
          roomNote: data.status === undefined ? `${str(data.action)} ${amount(data.from)} → ${amount(data.to)}` : `${str(data.status)} unchanged`,
        });
        break;
      case "ROOM_KEEP":
      case "ROOM_REDUCTION":
      case "ROOM_RELEASE":
        cards.set(role, { ...card, roomNote: `${event.kind.replace("ROOM_", "")} ${amount(data.from)} → ${amount(data.to)}` });
        break;
      case "ROOM_AGENT_TIMEOUT":
        cards.set(role, { ...card, timedOut: true, roomNote: "TIMED OUT · no allocation change recorded" });
        break;
      case "ROOM_AGENT_STALE_RESPONSE":
        cards.set(role, { ...card, ignored: data.reason === "ANSWERED_AFTER_TIMEOUT" ? "LATE" : "STALE", roomNote: str(data.action) });
        break;
      default:
        break;
    }
  }
  return ROLES.map((role) => {
    const card = cards.get(role) ?? blank(role);
    const row = timing.find((item) => str(item.role) === role);
    const next = applyTiming(card, row);
    return { ...next, inRoom: room.has(role) && !next.hardBlock };
  });
}

export function deriveRoom(events: readonly LiveEvent[]): RoomView {
  let roomId: string | null = null;
  let generation: number | null = null;
  let proposal = false;
  let reverify = false;
  let authorized = false;
  let refused = false;
  let noFeasible = false;
  let open = false;
  const notes: { sequence: number; agent: string | null; text: string }[] = [];
  for (const event of events) {
    if (event.kind === "ROOM_OPENED") {
      open = true;
      roomId = event.roomId;
      generation = event.generation;
    }
    if (event.kind === "ROOM_GENERATION_STARTED") generation = event.generation;
    if (event.kind === "ROOM_PROPOSAL_CREATED") {
      proposal = true;
      authorized = false;
      refused = false;
    }
    if (event.kind === "MANDATE_REVERIFY_STARTED") reverify = true;
    if (event.kind === "PORTFOLIO_AUTHORIZED") authorized = true;
    if (event.kind === "PORTFOLIO_REFUSED") refused = true;
    if (event.kind === "ROOM_NO_FEASIBLE_PORTFOLIO") noFeasible = true;
    if (event.kind === "ROOM_AGENT_STALE_RESPONSE" || event.kind === "ROOM_AGENT_TIMEOUT" || event.kind === "ROOM_NO_FEASIBLE_PORTFOLIO") {
      const label = event.kind === "ROOM_AGENT_STALE_RESPONSE" ? (event.data.reason === "ANSWERED_AFTER_TIMEOUT" ? "LATE — IGNORED" : "STALE — IGNORED") : event.kind === "ROOM_AGENT_TIMEOUT" ? "TIMED OUT · no allocation change" : "NO FEASIBLE PORTFOLIO";
      notes.push({ sequence: event.sequence, agent: event.agent, text: label });
    }
  }
  return { open, roomId, generation, proposal, reverify, authorized, refused, noFeasible, lines: resourceLines(events), notes };
}

export function deriveStress(events: readonly LiveEvent[]): { started: boolean; attempts: StressAttempt[]; ended: string } {
  const attempts: StressAttempt[] = [];
  let started = false;
  let ended = "";
  for (const event of events) {
    const data = event.data;
    if (event.kind === "POLICY_STRESS_STARTED") {
      started = true;
      attempts.length = 0;
      ended = "";
    } else if (event.kind === "POLICY_STRESS_CASE_SELECTED") {
      attempts.push({
        attempt: str(data.attempt),
        caseId: str(data.caseId),
        rationale: str(data.rationale) === "—" ? "" : str(data.rationale),
        outcome: data.caseId === "ABSTAIN" ? "NOT SUBMITTED" : "PENDING",
        reasons: [],
        screening: "",
        identity: {},
        note: "",
        sameSigner: false,
      });
    } else {
      const index = attempts.findIndex((item) => item.attempt === str(data.attempt));
      const attempt = index < 0 ? undefined : attempts[index];
      if (attempt !== undefined && index >= 0) {
        if (event.kind === "POLICY_STRESS_PROPOSAL_SIGNED") {
          const identity = rec(data.identity);
          attempts[index] = { ...attempt, identity, sameSigner: identity.sameSignerAsSwapAgent === true };
        }
        if (event.kind === "POLICY_STRESS_PROPOSAL_BLOCKED") {
          attempts[index] = { ...attempt, outcome: "REFUSED", reasons: reasonsOf(data.reasons), screening: str(rec(data.screening).verdict) };
        }
        if (event.kind === "POLICY_STRESS_PROPOSAL_AUTHORIZED") {
          attempts[index] = {
            ...attempt,
            outcome: "AUTHORIZED",
            note: str(data.note) === "—" ? "" : str(data.note),
            screening: str(rec(data.screening).verdict),
            sameSigner: data.sameIdentityAsRefusedAttempts === true || attempt.sameSigner,
          };
        }
      }
      if (event.kind === "POLICY_STRESS_COMPLETED") ended = str(data.endedBy);
    }
  }
  return { started, attempts, ended };
}

const FIXTURE_QUALIFICATION = "Valueless demo assets. Not an NVDA trade. Not a Robinhood Stock Token.";

function tokenLabel(token: JsonRecord): string | null {
  return typeof token.symbol === "string" && typeof token.amount === "string" ? `${token.amount} ${token.symbol}` : null;
}

function textField(data: JsonRecord, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function deriveSettlement(events: readonly LiveEvent[]): SettlementView {
  const base: SettlementView = {
    present: false,
    stage: "NONE",
    settled: false,
    evidence: null,
    network: "",
    chainId: "",
    gate: "",
    txHash: null,
    explorerUrl: null,
    block: null,
    gasUsed: null,
    receiptStatus: null,
    decisionNotional: null,
    fixtureIn: null,
    fixtureOut: null,
    qualification: FIXTURE_QUALIFICATION,
    detail: "",
  };
  let view = base;
  for (const event of events) {
    const data = event.data;
    const touch = (patch: Partial<SettlementView>): void => {
      view = { ...view, present: true, ...patch };
    };
    if (event.kind === "TESTNET_PREFLIGHT_STARTED" || event.kind === "DOMAIN_EXECUTION_READY" || event.kind === "TESTNET_PREFLIGHT_PASSED") {
      touch({
        stage: event.kind === "TESTNET_PREFLIGHT_PASSED" ? "PREFLIGHT" : view.stage === "NONE" ? "PREFLIGHT" : view.stage,
        network: textField(data, "network") ?? view.network,
        chainId: data.expectedChainId === undefined ? view.chainId : str(data.expectedChainId),
        gate: textField(data, "gate") ?? textField(rec(data.target), "address") ?? view.gate,
        settled: false,
      });
    }
    if (event.kind === "TESTNET_PREFLIGHT_FAILED") touch({ stage: "PREFLIGHT_FAILED", settled: false, detail: str(data.reason) });
    if (event.kind === "TESTNET_SIMULATION_STARTED") touch({ stage: "SIMULATION", settled: false });
    if (event.kind === "TESTNET_SIMULATION_PASSED") touch({ stage: "SIMULATION", settled: false, detail: data.gasEstimate === undefined ? view.detail : `Gas estimate ${str(data.gasEstimate)}` });
    if (event.kind === "TESTNET_SIMULATION_FAILED") touch({ stage: "SIMULATION_FAILED", settled: false, detail: str(data.reason) });
    if (event.kind === "TESTNET_SEND_AUTHORIZATION_REQUIRED") touch({ stage: "SEND_REQUIRED", settled: false });
    if (event.kind === "TESTNET_TX_SUBMITTED") touch({ stage: "SUBMITTED", settled: false, txHash: textField(data, "txHash"), evidence: "SUBMITTED_UNCONFIRMED" });
    if (event.kind === "TESTNET_TX_FAILED" || event.kind === "DOMAIN_EXECUTION_FAILED") {
      touch({
        stage: "FAILED",
        settled: false,
        txHash: textField(data, "txHash") ?? view.txHash,
        evidence: textField(data, "evidence") ?? "FAILED",
        receiptStatus: textField(data, "status") ?? "FAILED",
        explorerUrl: textField(data, "explorerUrl") ?? view.explorerUrl,
        detail: str(data.reason),
      });
    }
    if (event.kind === "TESTNET_TX_CONFIRMED" || event.kind === "DOMAIN_EXECUTION_SETTLED") {
      const evidence = textField(data, "evidence");
      const confirmed = evidence === "LIVE_TESTNET";
      const authorized = rec(data.authorized);
      const tokenIn = rec(data.tokenIn);
      const tokenOut = rec(data.tokenOut);
      touch({
        stage: confirmed ? "SETTLED" : view.stage,
        settled: confirmed,
        evidence,
        txHash: textField(data, "txHash") ?? view.txHash,
        explorerUrl: textField(data, "explorerUrl"),
        block: data.block === undefined ? view.block : str(data.block),
        gasUsed: data.gasUsed === undefined ? view.gasUsed : str(data.gasUsed),
        receiptStatus: textField(data, "status") ?? (confirmed ? "SUCCESS" : view.receiptStatus),
        network: textField(data, "network") ?? view.network,
        chainId: data.chainId === undefined ? view.chainId : str(data.chainId),
        decisionNotional: textField(authorized, "notionalUsdc"),
        fixtureIn: tokenLabel(tokenIn) ?? textField(authorized, "debit"),
        fixtureOut: tokenLabel(tokenOut) ?? textField(authorized, "quantity"),
      });
    }
  }
  if (view.evidence !== "LIVE_TESTNET") view = { ...view, settled: false, stage: view.stage === "SETTLED" ? "SUBMITTED" : view.stage };
  return view;
}

function refusal(events: readonly LiveEvent[]): string | null {
  const event = [...events].reverse().find((item) => item.kind === "MANDATE_AMENDMENT_REFUSED");
  if (event === undefined) return null;
  const message = str(event.data.message);
  return message === "—" ? str(event.data.code) : message;
}

export function derivePresentation(events: readonly LiveEvent[], timing: readonly JsonRecord[] = []): LivePresentation {
  const agents = deriveAgents(events, timing);
  const room = deriveRoom(events);
  return {
    agents,
    room,
    stress: deriveStress(events),
    settlement: deriveSettlement(events),
    blocked: agents.filter((agent) => agent.phase === "BLOCKED").length,
    admissible: agents.filter((agent) => agent.mandateLabel === "ADMISSIBLE" || agent.mandateLabel === "PORTFOLIO CONFLICT").length,
    roomGenerations: events.filter((event) => event.kind === "ROOM_GENERATION_STARTED").length,
    paused: events.some((event) => event.kind === "MANDATE_PAUSED"),
    amendmentRefused: refusal(events),
    reverifySeen: events.some((event) => event.kind === "MANDATE_REVERIFY_STARTED"),
  };
}

/** True when a hard-blocked role is also listed as a Room participant. */
export function blockedInsideRoom(events: readonly LiveEvent[]): boolean {
  const blocked = new Set(deriveAgents(events).filter((agent) => agent.hardBlock).map((agent) => agent.role));
  for (const role of participants(events)) if (blocked.has(role as RoleName)) return true;
  return false;
}
