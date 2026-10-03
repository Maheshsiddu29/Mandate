/**
 * Presentation derived from MANDATE_LIVE_AI.V1 events and the session view.
 *
 * This module does not decide authority. It reads fields the runtime already
 * emitted. Typed-resource conflicts stay one line each; reductions are never
 * added together.
 */

import { amount, arr, code, rec, str, type Json, type JsonRecord, type LiveEvent } from "./live-client.ts";
import { roomCopy } from "./allocation-model.ts";

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

/** Web-only words for protocol reason codes. A `REGISTRY:` or `LEDGER:` code is read through its inner code. */
const REASON_LABELS: Readonly<Record<string, string>> = {
  VENUE_NOT_ALLOWED: "Venue not allowed",
  ROUTE_NOT_ALLOWED: "Route not allowed",
  RECIPIENT_NOT_ALLOWED: "Recipient not allowed",
  ASSET_NOT_ALLOWED: "Asset not approved",
  REPRESENTATION_NOT_ALLOWED: "Representation not approved",
  REPRESENTATION_UNKNOWN: "Unknown representation",
  ISSUER_NOT_ALLOWED: "Issuer not approved",
  INSTRUMENT_UNKNOWN: "Unknown instrument",
  SYNTHETIC_NOT_ALLOWED: "Synthetic representation not approved",
  LEVERAGE_NOT_ALLOWED: "Leverage not allowed",
  PORTFOLIO_LIMIT_EXCEEDED: "Portfolio limit exceeded",
  AGENT_LIMIT_EXCEEDED: "Agent limit exceeded",
  ALLOCATION_INSUFFICIENT: "Insufficient portfolio authority",
};

/** Identity and market-set codes, most specific first: the order a single headline is chosen in. */
const IDENTITY_PRIORITY = [
  "SYNTHETIC_NOT_ALLOWED",
  "REPRESENTATION_UNKNOWN",
  "REPRESENTATION_NOT_ALLOWED",
  "ISSUER_NOT_ALLOWED",
  "ASSET_NOT_ALLOWED",
  "INSTRUMENT_UNKNOWN",
  "VENUE_NOT_ALLOWED",
  "ROUTE_NOT_ALLOWED",
  "RECIPIENT_NOT_ALLOWED",
] as const;

/** The headline when an action fails several independent market-set checks at once. */
export const OUTSIDE_MARKET_SET = "This opportunity is outside the approved market set.";

const innerCode = (reasonCode: string): string => reasonCode.replace(/^(REGISTRY|LEDGER):/, "");

const RESOURCE_LABELS: Readonly<Record<string, string>> = {
  "portfolio-notional": "Portfolio capital",
  "derivative-notional": "Derivative exposure",
  "illiquid-notional": "Illiquid exposure",
  "spot-capital": "Stock spot capital",
  "perp-margin": "Perpetual margin",
};

/** Web-only copy for one reason (raw or code). Protocol reason codes remain unchanged and available in details. */
export function reasonLabel(reason: string): string {
  const exact = code(reason);
  const inner = innerCode(exact);
  if (inner === "REGISTRY" || inner === "") return "Not approved by the asset registry";
  if (inner === "LEDGER") return "Refused by the authority ledger";
  return REASON_LABELS[exact] ?? REASON_LABELS[inner] ?? inner.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

/** Distinct reason codes, in the order first seen: subjects dropped, registry and ledger prefixes kept. */
export function reasonCodes(reasons: readonly Json[]): string[] {
  return [...new Set(reasons.map((reason) => code(reason)).filter((reasonCode) => reasonCode !== ""))];
}

export interface ReasonExplanation {
  /** One line for the verdict: the most specific reason, or the market-set summary when several identity checks fail. */
  readonly headline: string;
  /** Every distinct human reason, in code order. */
  readonly labels: readonly string[];
  /** Every distinct protocol code, for Technical details. */
  readonly codes: readonly string[];
}

/** Words first, codes kept: how a refusal is explained. Never joins codes; never shows a bare subsystem name when a specific code exists. */
export function explainReasons(reasons: readonly string[]): ReasonExplanation {
  const codes = reasonCodes(reasons);
  const labels = [...new Set(codes.map(reasonLabel))];
  const inner = codes.map(innerCode);
  const identity = IDENTITY_PRIORITY.filter((c) => inner.includes(c));
  const allIdentity = inner.length > 0 && inner.every((c) => (IDENTITY_PRIORITY as readonly string[]).includes(c));
  const headline = labels.length >= 3 && allIdentity ? OUTSIDE_MARKET_SET : identity[0] !== undefined ? (REASON_LABELS[identity[0]] as string) : labels[0] ?? "";
  return { headline, labels, codes };
}

/** Web-only label for one typed resource. Typed resources are never combined. */
export function resourceLabel(resource: string): string {
  return RESOURCE_LABELS[resource] ?? resource;
}

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
  /** Discovered → actionable, as the runtime's advisory eligibility reported it; null before it does (or in older runs). */
  readonly eligibility: CandidateEligibility | null;
  /** The id the model chose, exactly as the runtime recorded it. */
  readonly chosenId: string | null;
  /** What kind of inference decided: LIVE_MODEL, STUB or SCRIPTED (older runs: null). */
  readonly modelEvidence: string | null;
}

/** One excluded candidate: discovery only, never offered to the model. */
export interface ExcludedCandidate {
  readonly candidateId: string;
  readonly candidate: string;
  readonly codes: readonly string[];
}

/** Whether the active settlement profile's connector can execute an actionable candidate. Not authorization. */
export interface CandidateCapability {
  readonly candidateId: string;
  /** SETTLEMENT_CAPABLE, SETTLEMENT_UNSUPPORTED (never offered) or OUTSIDE_PROFILE (the profile settles nothing in this domain). */
  readonly status: string;
  readonly connector: string | null;
  readonly reason: string | null;
}

export interface CandidateEligibility {
  readonly discovered: readonly string[];
  /** Policy: allowed by the mandate. */
  readonly actionable: readonly string[];
  /** Policy and capability: what the model was offered. Older runs: the actionable set. */
  readonly executable: readonly string[];
  readonly excluded: readonly ExcludedCandidate[];
  /** Where the candidates' economics come from, e.g. FIXTURE. Empty in older runs. */
  readonly marketEvidence: readonly string[];
  /** The active settlement profile's id; null when none was reported. */
  readonly settlementProfile: string | null;
  readonly capability: readonly CandidateCapability[];
}

function eligibilityOf(data: JsonRecord): CandidateEligibility {
  const ids = (v: Json | undefined) => arr(v).map((item) => str(item));
  const text = (v: Json | undefined) => (typeof v === "string" ? v : null);
  const actionable = ids(data.actionable);
  return {
    discovered: ids(data.discovered),
    actionable,
    executable: data.executable === undefined ? actionable : ids(data.executable),
    excluded: arr(data.excluded).map(rec).map((row) => ({ candidateId: str(row.candidateId), candidate: str(row.candidate), codes: reasonCodes(arr(row.reasons)) })),
    marketEvidence: ids(data.marketEvidence),
    settlementProfile: text(data.settlementProfile),
    capability: arr(data.capability).map(rec).map((row) => ({ candidateId: str(row.candidateId), status: str(row.status), connector: text(row.connector), reason: text(row.reason) })),
  };
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
  readonly activity: readonly RoomActivity[];
  readonly reserved: string | null;
}

export interface RoomActivity {
  readonly sequence: number;
  readonly agent: string | null;
  readonly generation: number | null;
  readonly action: string;
  readonly from: string;
  readonly to: string;
  readonly rationale: string;
  readonly state: "MESSAGE" | "TIMEOUT" | "IGNORED" | "SYSTEM";
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

/** Who authorized what, as settlement events state it: the portfolio principal is never the domain signer by implication. */
export interface PrincipalBinding {
  readonly portfolioMethod: string;
  readonly portfolioAddress: string;
  readonly domainKind: string;
  readonly domainAddress: string;
}

export interface SettlementView {
  readonly present: boolean;
  /**
   * B.5.3 adds: READY_FOR_SEND (the session-bound dry run passed; B.5.3 never broadcasts), RECONCILING (an
   * execution's outcome is still being established: "checking settlement status"), NEEDS_REVIEW (quarantined
   * after reconciliation: no retry was sent) and RELEASED (definitively not executed; the reservation released).
   * C1.5 adds HELD, which no event produces: only the server's durable settlement state sets it
   * (settlement-restore.ts) — a signed attempt with nothing sent, held for reconciliation.
   */
  readonly stage: "NONE" | "PREFLIGHT" | "PREFLIGHT_FAILED" | "READY" | "SIGN_GATE" | "SIMULATION" | "SIMULATION_FAILED" | "SEND_REQUIRED" | "READY_FOR_SEND" | "SPINE_READY" | "SUBMITTED" | "RECONCILING" | "HELD" | "FAILED" | "NEEDS_REVIEW" | "RELEASED" | "SETTLED";
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
  /** The portfolio reservation was consumed in the durable ledger (RESERVATION_CONSUMED). */
  readonly consumed: boolean;
  readonly principals: PrincipalBinding | null;
  /** Which RPC endpoint answered: a provider label from the event, never a URL. */
  readonly rpcProvider: string | null;
  /** The MandateAuthorization typed data the wallet still has to sign, when the spine is waiting. */
  readonly gateSign: { readonly mode: "DRY_RUN" | "SEND"; readonly typedData: Json; readonly note: string } | null;
  /** Dry-run proof. Empty until SPINE_DRY_RUN_READY. A deadline is chain unix seconds. */
  readonly candidateId: string | null;
  readonly mandateDigest: string | null;
  readonly gasEstimate: string | null;
  readonly simulationDeadline: string | null;
  readonly reservationId: string | null;
  readonly initialAllocationDigest: string | null;
  readonly currentPlanDigest: string | null;
  readonly walletPrincipal: string | null;
  readonly receiptDigest: string | null;
  readonly commitmentRecorded: boolean;
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

export interface EventGroup {
  readonly elapsedMs: number;
  readonly at: string;
  readonly events: readonly LiveEvent[];
}

/** Equal authoritative times are grouped, never altered or randomized. */
export function groupEventsByElapsed(events: readonly LiveEvent[]): EventGroup[] {
  const groups: { elapsedMs: number; at: string; events: LiveEvent[] }[] = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last !== undefined && last.elapsedMs === event.elapsedMs) last.events.push(event);
    else groups.push({ elapsedMs: event.elapsedMs, at: event.at, events: [event] });
  }
  return groups;
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
    eligibility: null,
    chosenId: null,
    modelEvidence: null,
  };
}

function num(v: Json | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function reasonsOf(v: Json | undefined): string[] {
  return reasonCodes(arr(v));
}

function hard(reasons: readonly string[]): boolean {
  return reasons.some((reason) => HARD_BLOCK.has(innerCode(reason)));
}

/** Preserve millisecond precision so distinct event times never collapse to one displayed time. */
export function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) {
    const whole = Math.floor(value / 1000);
    const frac = Math.floor(value % 1000);
    return `${whole}.${String(frac).padStart(3, "0")}s`;
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
      case "AGENT_CANDIDATES_EVALUATED":
        cards.set(role, { ...blank(role), phase: "PENDING", startedAt: event.at, eligibility: eligibilityOf(data) });
        break;
      case "AGENT_REQUEST_STARTED":
        // The eligibility just evaluated for this same request is kept; anything older is reset.
        cards.set(role, { ...blank(role), phase: "PENDING", startedAt: event.at, eligibility: card.phase === "PENDING" ? card.eligibility : null, modelEvidence: typeof data.modelEvidence === "string" ? data.modelEvidence : null });
        break;
      case "AGENT_FIRST_RESPONSE":
        cards.set(role, { ...card, phase: "RESPONDING", firstResponseMs: num(data.timeToFirstResponseMs) ?? card.firstResponseMs });
        break;
      case "AGENT_DECISION_COMPLETED":
        cards.set(role, {
          ...card,
          phase: "RESPONDED",
          chosenId: typeof data.candidateId === "string" ? data.candidateId : null,
          candidate: str(data.candidate) === "—" ? str(data.candidateId) : str(data.candidate),
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
  let reserved: string | null = null;
  const notes: { sequence: number; agent: string | null; text: string }[] = [];
  const activity: RoomActivity[] = [];
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
    if (event.kind === "PORTFOLIO_AUTHORIZED") {
      authorized = true;
      reserved = amount(event.data.reserved) === "—" ? null : amount(event.data.reserved);
    }
    if (event.kind === "PORTFOLIO_REFUSED") refused = true;
    if (event.kind === "ROOM_NO_FEASIBLE_PORTFOLIO") noFeasible = true;
    if (event.kind === "ROOM_AGENT_STALE_RESPONSE" || event.kind === "ROOM_AGENT_TIMEOUT" || event.kind === "ROOM_NO_FEASIBLE_PORTFOLIO") {
      const label = event.kind === "ROOM_AGENT_STALE_RESPONSE" ? (event.data.reason === "ANSWERED_AFTER_TIMEOUT" ? "LATE — IGNORED" : "STALE — IGNORED") : event.kind === "ROOM_AGENT_TIMEOUT" ? "TIMED OUT · no allocation change" : "NO FEASIBLE PORTFOLIO";
      notes.push({ sequence: event.sequence, agent: event.agent, text: label });
    }
    if (event.kind === "ROOM_AGENT_RESPONSE") {
      activity.push({
        sequence: event.sequence,
        agent: event.agent,
        generation: event.generation,
        action: str(event.data.action),
        from: amount(event.data.from),
        to: amount(event.data.to),
        rationale: str(event.data.rationale) === "—" ? "" : str(event.data.rationale),
        state: "MESSAGE",
      });
    }
    if (event.kind === "ROOM_AGENT_TIMEOUT") {
      activity.push({ sequence: event.sequence, agent: event.agent, generation: event.generation, action: "TIMED OUT", from: "—", to: "—", rationale: "No allocation change recorded.", state: "TIMEOUT" });
    }
    if (event.kind === "ROOM_AGENT_STALE_RESPONSE") {
      activity.push({ sequence: event.sequence, agent: event.agent, generation: event.generation, action: event.data.reason === "ANSWERED_AFTER_TIMEOUT" ? "LATE — IGNORED" : "STALE — IGNORED", from: "—", to: "—", rationale: "The Room had already moved on. The portfolio did not change.", state: "IGNORED" });
    }
    if (event.kind === "MANDATE_REVERIFY_STARTED") {
      activity.push({ sequence: event.sequence, agent: null, generation: event.generation, action: "RE-VERIFYING", from: "—", to: "—", rationale: "Checking the negotiated portfolio against the principal's authority.", state: "SYSTEM" });
    }
  }
  return { open, roomId, generation, proposal, reverify, authorized, refused, noFeasible, lines: resourceLines(events), notes, activity, reserved };
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
    consumed: false,
    principals: null,
    rpcProvider: null,
    gateSign: null,
    candidateId: null,
    mandateDigest: null,
    gasEstimate: null,
    simulationDeadline: null,
    reservationId: null,
    initialAllocationDigest: null,
    currentPlanDigest: null,
    walletPrincipal: null,
    receiptDigest: null,
    commitmentRecorded: false,
  };
  let view = base;
  for (const event of events) {
    const data = event.data;
    const touch = (patch: Partial<SettlementView>): void => {
      const gateSign = patch.gateSign !== undefined ? patch.gateSign : patch.stage !== undefined && patch.stage !== "SIGN_GATE" ? null : view.gateSign;
      view = { ...view, present: true, ...patch, gateSign };
    };
    const p = rec(data.principals);
    if (typeof p.delegation === "string") {
      view = { ...view, principals: { portfolioMethod: str(rec(p.portfolio).method), portfolioAddress: str(rec(p.portfolio).address), domainKind: str(rec(p.domainSettlement).kind), domainAddress: str(rec(p.domainSettlement).address) } };
    }
    if (typeof data.rpcProvider === "string" && event.kind !== "SESSION_RESTORED") view = { ...view, rpcProvider: data.rpcProvider };
    if (event.kind === "TESTNET_READY_FOR_SEND") touch({ stage: "READY_FOR_SEND", settled: false, evidence: "DRY_RUN", detail: "Ready for testnet send. Broadcast is disabled in this milestone: nothing was sent." });
    if (event.kind === "SETTLEMENT_RECONCILED") {
      const state = str(data.state);
      const quarantine = typeof data.quarantine === "string" ? data.quarantine : null;
      if (quarantine === "POSTCONDITION_ANOMALY" || quarantine === "EXECUTED_OUTSIDE_ATTEMPT") touch({ stage: "NEEDS_REVIEW", settled: false, detail: "Settlement needs review. No retry was sent." });
      else if (state === "SUBMITTED" || state === "SUBMISSION_STARTED" || state === "RECONCILIATION_REQUIRED") touch({ stage: "RECONCILING", settled: false, txHash: textField(data, "txHash") ?? view.txHash, detail: "Checking settlement status…" });
    }
    if (event.kind === "RESERVATION_RELEASED") touch({ stage: "RELEASED", settled: false, detail: "Not executed: every gate artifact passed its deadline with nothing recorded onchain. The reservation was released." });
    if (event.kind === "RESERVATION_CONSUMED") view = { ...view, present: true, consumed: true };
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
    if (event.kind === "GATE_EXECUTION_SIGNATURE_REQUIRED") {
      const typed = data.typedData;
      const mode = data.mode === "SEND" ? "SEND" : "DRY_RUN";
      touch({
        stage: "SIGN_GATE",
        settled: false,
        detail: str(data.note),
        gateSign: typeof typed === "object" && typed !== null ? { mode, typedData: typed, note: str(data.note) } : null,
      });
    }
    if (event.kind === "SPINE_DRY_RUN_READY") {
      touch({
        stage: "SPINE_READY",
        settled: false,
        evidence: "DRY_RUN",
        network: textField(data, "network") ?? view.network,
        chainId: textField(data, "chainId") ?? view.chainId,
        detail: str(data.note),
        fixtureIn: tokenLabel(rec(data.tokenIn)) ?? view.fixtureIn,
        fixtureOut: tokenLabel(rec(data.tokenOut)) ?? view.fixtureOut,
        gate: textField(data, "gate") ?? view.gate,
        candidateId: textField(data, "candidateId") ?? view.candidateId,
        mandateDigest: textField(data, "mandateDigest") ?? view.mandateDigest,
        gasEstimate: textField(data, "gasEstimate") ?? view.gasEstimate,
        simulationDeadline: textField(data, "simulationDeadline") ?? view.simulationDeadline,
        reservationId: textField(data, "reservation") ?? view.reservationId,
        initialAllocationDigest: textField(data, "initialAllocationDigest") ?? view.initialAllocationDigest,
        currentPlanDigest: textField(data, "currentPlanDigest") ?? view.currentPlanDigest,
        walletPrincipal: textField(data, "principal") ?? view.walletPrincipal,
        gateSign: null,
      });
    }
    if (event.kind === "DOMAIN_EXECUTION_INELIGIBLE" && !view.settled) touch({ stage: "FAILED", settled: false, detail: str(data.reason), gateSign: null });
    if (event.kind === "TESTNET_SEND_AUTHORIZATION_REFUSED" && !view.settled) touch({ stage: "FAILED", settled: false, detail: str(data.reason) === "—" ? "SEND_NOT_AUTHORIZED" : str(data.reason) });
    if (event.kind === "TESTNET_SIMULATION_STARTED") touch({ stage: "SIMULATION", settled: false });
    if (event.kind === "TESTNET_SIMULATION_PASSED") touch({ stage: "SIMULATION", settled: false, detail: data.gasEstimate === undefined ? view.detail : `Gas estimate ${str(data.gasEstimate)}` });
    if (event.kind === "TESTNET_SIMULATION_FAILED") touch({ stage: "SIMULATION_FAILED", settled: false, detail: str(data.reason) });
    if (event.kind === "TESTNET_SEND_AUTHORIZATION_REQUIRED") touch({ stage: "SEND_REQUIRED", settled: false });
    if (event.kind === "TESTNET_TX_SUBMITTED") touch({ stage: "SUBMITTED", settled: false, txHash: textField(data, "txHash"), evidence: "SUBMITTED_UNCONFIRMED" });
    if (event.kind === "DOMAIN_EXECUTION_FAILED" && data.reservationStatus === "QUARANTINED") {
      touch({ stage: "NEEDS_REVIEW", settled: false, txHash: textField(data, "txHash") ?? view.txHash, detail: "Settlement needs review. No retry was sent." });
    } else if (event.kind === "TESTNET_TX_FAILED" || event.kind === "DOMAIN_EXECUTION_FAILED") {
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
        candidateId: textField(data, "candidateId") ?? view.candidateId,
        mandateDigest: textField(data, "mandateDigest") ?? view.mandateDigest,
        reservationId: textField(data, "reservation") ?? view.reservationId,
        walletPrincipal: textField(data, "principal") ?? view.walletPrincipal,
        gate: textField(data, "target") ?? view.gate,
        receiptDigest: textField(data, "receiptDigest") ?? view.receiptDigest,
        commitmentRecorded: rec(data.postconditions).commitmentRecordedOnchain === true || view.commitmentRecorded,
      });
    }
  }
  if (view.evidence !== "LIVE_TESTNET") view = { ...view, settled: false, stage: view.stage === "SETTLED" ? "SUBMITTED" : view.stage };
  return view;
}

/** Stages after which nothing further happens without a new action: the flow may show the receipt. */
export const SETTLEMENT_TERMINAL = ["SETTLED", "FAILED", "PREFLIGHT_FAILED", "SIMULATION_FAILED", "READY_FOR_SEND", "SPINE_READY", "HELD", "NEEDS_REVIEW", "RELEASED"] as const;

export function settlementTerminal(s: SettlementView): boolean {
  return (SETTLEMENT_TERMINAL as readonly string[]).includes(s.stage);
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

// --- Conversation and review (B.6.2) ------------------------------------------------------------

/** One short line per domain. Product copy, not a capability claim. */
export const ROLE_DESCRIPTORS: Record<RoleName, string> = {
  stock: "Tokenized equities",
  swap: "Spot token routes",
  nft: "Collection listings",
  yield: "Vault deposits",
  perps: "Bounded perpetuals",
};

/** Display a decimal USDC text as dollars. Display only; never used for a decision. */
export function usd(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const clean = value.replace(/ USDC$/, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(clean)) return "—";
  const [whole = "0", frac = ""] = clean.replace(/^-/, "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = frac.replace(/0+$/, "");
  const shown = cents === "" ? grouped : `${grouped}.${cents.padEnd(2, "0").slice(0, Math.max(2, cents.length))}`;
  return `${clean.startsWith("-") ? "-" : ""}$${shown}`;
}

export type ChatTone = "neutral" | "good" | "warn" | "bad";

/**
 * One Room message. Every message is a translation of one real event; the
 * text uses only fields the event carries. `detail` is the agent's own
 * declared rationale, shown verbatim, or a fixed explanation of a protocol
 * effect. Nothing here is generated, paraphrased by a model, or delayed.
 */
export interface ChatMessage {
  readonly id: number;
  readonly kind: "agent" | "system";
  readonly agent: RoleName | null;
  readonly generation: number | null;
  readonly action: string | null;
  readonly title: string;
  readonly detail: string;
  readonly tone: ChatTone;
  readonly ignored: "LATE" | "STALE" | null;
  readonly note: string;
  readonly working: boolean;
}

const ACTION_VERB: Readonly<Record<string, string>> = { KEEP: "Keep", REDUCE: "Reduce", RELEASE: "Release", ABSTAIN: "Abstain" };

const STALE_NOTE: Readonly<Record<string, string>> = {
  ANSWERED_AFTER_TIMEOUT: "Arrived after the round timed out.",
  ROOM_FINALIZED: "Room already finalized.",
  LATER_GENERATION_STARTED: "A later round had already started.",
  GENERATION_CLOSED: "That round had already closed.",
};

function amountOf(v: Json | undefined): string | null {
  const r = rec(v);
  return typeof r.amount === "string" ? r.amount : null;
}

function asRole(agent: string | null): RoleName | null {
  return agent !== null && (ROLES as readonly string[]).includes(agent) ? (agent as RoleName) : null;
}

function roleList(items: readonly string[]): string {
  const names = items.map((item) => ROLE_TITLES[item as RoleName] ?? item);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** What an agent said, from its structured action and amounts. */
export function actionText(action: string, from: string | null, to: string | null): string {
  const verb = ACTION_VERB[action] ?? action.charAt(0) + action.slice(1).toLowerCase();
  if (action === "REDUCE" && from !== null && to !== null) return `${verb} ${usd(from)} → ${usd(to)}.`;
  if ((action === "KEEP" || action === "RELEASE") && from !== null) return `${verb} ${usd(from)}.`;
  return `${verb}.`;
}

export function deriveRoomChat(events: readonly LiveEvent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const answered = new Set<string>();
  const base = (event: LiveEvent) => ({ id: event.sequence, agent: asRole(event.agent), generation: event.generation, ignored: null, note: "", working: false, action: null });
  for (const event of events) {
    const data = event.data;
    switch (event.kind) {
      case "ROOM_OPENED": {
        const names = arr(data.participants).map((item) => (typeof item === "string" ? item : str(rec(item).role))).filter((item) => item !== "—");
        // The Room says why it exists: a real shared-resource conflict, or released capital being reassigned.
        const purpose = roomCopy(data.roomPurpose);
        out.push({ ...base(event), kind: "system", title: data.roomPurpose === "REALLOCATION" ? "Released capital" : "Mandate opened the Room", detail: names.length === 0 ? purpose : `${purpose} ${roleList(names)} take part.`, tone: "neutral" });
        break;
      }
      case "OPPORTUNITY_CARD_CREATED": {
        const action = str(data.action);
        out.push({ ...base(event), kind: "agent", action, title: action === "PROPOSE" ? `Can use up to ${usd(amountOf(data.maximumUseful))}` : "Keep", detail: typeof data.rationale === "string" ? data.rationale : "", tone: action === "PROPOSE" ? "good" : "neutral" });
        break;
      }
      case "ALLOCATION_PLAN_PROPOSED": {
        const moves = arr(data.budgets).map(rec).filter((row) => amountOf(row.increment) !== null && amountOf(row.increment) !== "0").map((row) => `${ROLE_TITLES[str(row.role) as RoleName] ?? str(row.role)} +${usd(amountOf(row.increment))}`);
        out.push({ ...base(event), kind: "system", title: "Reassignment proposed", detail: `${moves.length === 0 ? "No agent can use it." : moves.join(" · ")}. ${usd(amountOf(data.unallocated))} stays in your wallet. Not authorized yet.`, tone: "neutral" });
        break;
      }
      case "ROOM_GENERATION_STARTED":
        if ((event.generation ?? 1) > 1) out.push({ ...base(event), kind: "system", title: `Round ${event.generation}`, detail: "The conflict is not resolved yet. Agents answer again.", tone: "neutral" });
        break;
      case "ROOM_AGENT_RESPONSE": {
        answered.add(`${event.generation ?? 0}:${event.agent ?? ""}`);
        if (typeof data.action === "string") {
          const rationale = typeof data.rationale === "string" ? data.rationale : "";
          out.push({ ...base(event), kind: "agent", action: data.action, title: actionText(data.action, amountOf(data.from), amountOf(data.to)), detail: rationale, tone: data.action === "KEEP" ? "neutral" : "good" });
        } else {
          out.push({ ...base(event), kind: "agent", action: str(data.status), title: "Couldn't respond.", detail: "No allocation change.", tone: "bad" });
        }
        break;
      }
      case "ROOM_KEEP":
      case "ROOM_REDUCTION":
      case "ROOM_RELEASE":
        // The protocol's record of a response already shown; only shown alone if its response event is missing.
        if (!answered.has(`${event.generation ?? 0}:${event.agent ?? ""}`)) {
          const action = event.kind === "ROOM_KEEP" ? "KEEP" : event.kind === "ROOM_REDUCTION" ? "REDUCE" : "RELEASE";
          out.push({ ...base(event), kind: "agent", action, title: actionText(action, amountOf(data.from), amountOf(data.to)), detail: typeof data.rationale === "string" ? data.rationale : "", tone: action === "KEEP" ? "neutral" : "good" });
        }
        break;
      case "ROOM_AGENT_TIMEOUT":
        answered.add(`${event.generation ?? 0}:${event.agent ?? ""}`);
        out.push({ ...base(event), kind: "agent", action: "TIMEOUT", title: "No reply in time.", detail: "No allocation change. A timeout is not consent and not a release.", tone: "warn" });
        break;
      case "ROOM_AGENT_STALE_RESPONSE": {
        const late = data.reason === "ANSWERED_AFTER_TIMEOUT";
        const action = str(data.action);
        out.push({ ...base(event), kind: "agent", action, title: ACTION_VERB[action] === undefined ? `${action.charAt(0)}${action.slice(1).toLowerCase()}.` : `${ACTION_VERB[action]}.`, detail: STALE_NOTE[str(data.reason)] ?? "The Room had already moved on.", tone: "neutral", ignored: late ? "LATE" : "STALE", note: late ? "Late reply — ignored" : "Stale reply — ignored" });
        break;
      }
      case "ROOM_PROPOSAL_CREATED": {
        const moves = arr(data.requests).map(rec).filter((row) => amountOf(row.from) !== amountOf(row.to)).map((row) => `${ROLE_TITLES[str(row.role) as RoleName] ?? str(row.role)} ${usd(amountOf(row.from))} → ${usd(amountOf(row.to))}`);
        out.push({ ...base(event), kind: "system", title: "Proposal ready", detail: `${moves.length === 0 ? "Requests unchanged." : moves.join(" · ")}. Not authorized yet.`, tone: "neutral" });
        break;
      }
      case "ROOM_NO_FEASIBLE_PORTFOLIO":
        out.push({ ...base(event), kind: "system", title: "No feasible portfolio", detail: "Agents couldn't resolve the conflict within your mandate. Nothing was authorized.", tone: "bad" });
        break;
      case "MANDATE_REVERIFY_STARTED":
        out.push({ ...base(event), kind: "system", title: "Re-verifying the negotiated portfolio", detail: "Room consensus does not create authority.", tone: "neutral", working: true });
        break;
      case "PORTFOLIO_AUTHORIZED": {
        const reserved = amountOf(data.reserved);
        out.push({ ...base(event), kind: "system", title: "Authorized", detail: `${reserved === null ? "" : `${usd(reserved)} reserved. `}Reserved is not settled.`, tone: "good" });
        break;
      }
      case "PORTFOLIO_REFUSED":
        out.push({ ...base(event), kind: "system", title: "Refused", detail: "Mandate refused the negotiated portfolio. Nothing was authorized.", tone: "bad" });
        break;
      default:
        break;
    }
  }
  // Re-verification is only "working" until its verdict arrives.
  const done = events.some((event) => event.kind === "PORTFOLIO_AUTHORIZED" || event.kind === "PORTFOLIO_REFUSED");
  return done ? out.map((message) => (message.working ? { ...message, working: false } : message)) : out;
}

/** Room participants in the current round who have not answered yet: real open requests, not a typing effect. */
export function awaitingReplies(events: readonly LiveEvent[]): RoleName[] {
  let generation: number | null = null;
  let participants: string[] = [];
  let closed = false;
  const answered = new Set<string>();
  for (const event of events) {
    if (event.kind === "ROOM_GENERATION_STARTED") {
      generation = event.generation;
      participants = arr(event.data.participants).filter((item): item is string => typeof item === "string");
      answered.clear();
      closed = false;
    }
    if ((event.kind === "ROOM_AGENT_RESPONSE" || event.kind === "ROOM_AGENT_TIMEOUT") && event.generation === generation && event.agent !== null) answered.add(event.agent);
    if (event.kind === "ROOM_PROPOSAL_CREATED" || event.kind === "ROOM_NO_FEASIBLE_PORTFOLIO" || event.kind === "ROOM_FINALIZED") closed = true;
  }
  if (closed || generation === null) return [];
  return participants.filter((role) => !answered.has(role)).map(asRole).filter((role): role is RoleName => role !== null);
}

export interface ReviewItem {
  readonly role: RoleName;
  readonly amount: string;
  readonly from: string | null;
  readonly reason: string;
  readonly codes: readonly string[];
}

export interface TradeReview {
  readonly evaluated: number;
  readonly blocked: number;
  readonly noProposal: number;
  readonly conflictsResolved: number;
  readonly authorizedCount: number;
  readonly settlementsConfirmed: number;
  readonly authorized: readonly ReviewItem[];
  readonly blockedItems: readonly ReviewItem[];
  readonly negotiated: readonly ReviewItem[];
  readonly quiet: readonly ReviewItem[];
  readonly reserved: string | null;
}

/** Counts and lists for the receipt, from the run's events only. Nothing is assumed or hardcoded. */
export function deriveReview(events: readonly LiveEvent[]): TradeReview {
  const agents = deriveAgents(events);
  const settlement = deriveSettlement(events);
  const authorizedEvent = [...events].reverse().find((event) => event.kind === "PORTFOLIO_AUTHORIZED");
  const proposal = [...events].reverse().find((event) => event.kind === "ROOM_PROPOSAL_CREATED");
  // An agent whose eligibility left nothing to choose from abstains without a model request; it was still evaluated.
  const started = new Set(events.filter((event) => (event.kind === "AGENT_REQUEST_STARTED" || event.kind === "AGENT_CANDIDATES_EVALUATED") && event.agent !== null).map((event) => event.agent));
  const blockedRoles = new Set(events.filter((event) => event.kind === "PROPOSAL_BLOCKED" && event.agent !== null).map((event) => event.agent));
  const negotiated = proposal === undefined
    ? []
    : arr(proposal.data.requests).map(rec).filter((row) => amountOf(row.from) !== amountOf(row.to)).flatMap((row) => {
        const role = asRole(str(row.role));
        return role === null ? [] : [{ role, amount: amountOf(row.to) ?? "—", from: amountOf(row.from), reason: "", codes: [] }];
      });
  const resolvedRooms = authorizedEvent === undefined ? 0 : events.filter((event) => event.kind === "ROOM_FINALIZED" && event.data.result === "PROPOSED").length;
  return {
    evaluated: started.size,
    blocked: blockedRoles.size,
    noProposal: agents.filter((agent) => ["ABSTAINED", "TIMED OUT", "FAILED", "INVALID RESPONSE"].includes(agent.phase)).length,
    conflictsResolved: resolvedRooms,
    authorizedCount: agents.filter((agent) => agent.finalOutcome === "RESERVED").length,
    settlementsConfirmed: settlement.settled ? 1 : 0,
    authorized: agents.filter((agent) => agent.finalOutcome === "RESERVED").map((agent) => ({ role: agent.role, amount: agent.finalAmount.replace(/ USDC$/, ""), from: null, reason: "", codes: [] })),
    blockedItems: agents.filter((agent) => agent.phase === "BLOCKED").map((agent) => ({ role: agent.role, amount: agent.requested.replace(/ USDC$/, ""), from: null, reason: explainReasons(agent.reasons).headline || "Blocked", codes: agent.reasons })),
    negotiated,
    quiet: agents.filter((agent) => ["ABSTAINED", "TIMED OUT", "FAILED", "INVALID RESPONSE"].includes(agent.phase)).map((agent) => ({ role: agent.role, amount: "—", from: null, reason: agent.phase === "ABSTAINED" ? "No proposal" : agent.phase === "TIMED OUT" ? "Timed out" : "Couldn't respond", codes: [] })),
    reserved: authorizedEvent === undefined ? null : amountOf(authorizedEvent.data.reserved),
  };
}

/** The portfolio Mandate is re-verifying: each proposal's portfolio-notional request, as the event carries it. */
export function proposedPortfolio(events: readonly LiveEvent[]): { readonly role: RoleName; readonly amount: string }[] {
  const event = [...events].reverse().find((item) => item.kind === "MANDATE_REVERIFY_STARTED");
  if (event === undefined) return [];
  return arr(event.data.proposals).map(rec).flatMap((row) => {
    const role = asRole(str(row.role));
    const notional = arr(row.requested).map(rec).find((item) => item.resource === "portfolio-notional");
    return role === null || notional === undefined || typeof notional.amount !== "string" ? [] : [{ role, amount: notional.amount }];
  });
}

export interface AllocationSummary {
  /** Sum of enabled agents' ceilings, or null while any enabled ceiling is unset. */
  readonly ceilings: number | null;
  readonly deployable: number | null;
  /** Ceilings exceed deployable capital: Mandate holds the cap and the Room resolves overlap. */
  readonly oversubscribed: boolean;
  /** Deployable capital not assigned to any agent ceiling, when ceilings fit. */
  readonly unassigned: number | null;
  /** Share of deployable capital the ceilings cover, 0..1. */
  readonly fill: number;
}

const decimalText = (text: string | null): number | null => (text !== null && /^\d+(\.\d+)?$/.test(text.trim()) ? Number(text.trim()) : null);

/**
 * Capital allocation for display: agent ceilings against deployable capital.
 * Only the capital dimension; derivative, illiquid and other typed limits
 * are separate and never folded into this figure.
 */
export function allocationSummary(input: { readonly capital: string | null; readonly maxDeployed: string | null; readonly ceilings: readonly (string | null)[] }): AllocationSummary {
  const deployable = decimalText(input.maxDeployed) ?? decimalText(input.capital);
  const values = input.ceilings.map(decimalText);
  const ceilings = values.every((value) => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;
  const oversubscribed = deployable !== null && ceilings !== null && ceilings > deployable;
  return {
    ceilings,
    deployable,
    oversubscribed,
    unassigned: deployable !== null && ceilings !== null && !oversubscribed ? deployable - ceilings : null,
    fill: deployable === null || deployable === 0 || ceilings === null ? 0 : Math.min(1, ceilings / deployable),
  };
}
