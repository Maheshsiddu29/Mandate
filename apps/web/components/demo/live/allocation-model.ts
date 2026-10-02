/**
 * Mandate Room V2 in the browser (docs/v2/mandate-room-v2.md): who decides
 * the split, the Planning Room's proposal, the principal's edits, and which
 * Stock trade — if any — actually received execution authority.
 *
 * Presentation only. The server classifies, validates and decides; these
 * functions read what it returned and never grant anything. Client-side
 * budget checks only give immediate feedback: the server validates again.
 */

import { arr, rec, str, type Json, type JsonRecord, type LiveEvent } from "./live-client.ts";
import { ROLE_TITLES, ROLES, type RoleName } from "./live-model.ts";

export type AllocationIntent = "FIXED" | "DYNAMIC" | "HYBRID" | "NEEDS_AGENT_SELECTION";
export type PlanningState = "NONE" | "REQUIRED" | "OPTIONAL" | "COMPLETE";

export interface AllocationState {
  readonly intent: AllocationIntent;
  readonly planning: PlanningState;
  readonly enabled: readonly RoleName[];
  readonly undecided: readonly RoleName[];
  readonly fixed: readonly RoleName[];
  readonly pool: readonly RoleName[];
  readonly autoReallocate: boolean;
  /** Decimal USDC text, from the server's atoms. */
  readonly deployable: string | null;
  readonly pooled: string | null;
}

const INTENTS: readonly AllocationIntent[] = ["FIXED", "DYNAMIC", "HYBRID", "NEEDS_AGENT_SELECTION"];
const PLANNING: readonly PlanningState[] = ["NONE", "REQUIRED", "OPTIONAL", "COMPLETE"];
const roles = (v: Json | undefined): RoleName[] => arr(v).filter((x): x is RoleName => typeof x === "string" && (ROLES as readonly string[]).includes(x));

/** USDC atoms (decimal text) as decimal USDC text: "1450000000" → "1450". */
export function atomsText(atoms: Json | undefined): string | null {
  if (typeof atoms !== "string" || !/^\d+$/.test(atoms)) return null;
  const n = BigInt(atoms);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

/** The server's allocation view (validation.allocation), or null before a draft exists. */
export function allocationState(validation: JsonRecord): AllocationState | null {
  const a = rec(validation.allocation);
  const intent = str(a.intent) as AllocationIntent;
  if (!INTENTS.includes(intent)) return null;
  const planning = str(a.planning) as PlanningState;
  return {
    intent,
    planning: PLANNING.includes(planning) ? planning : "NONE",
    enabled: roles(a.enabled),
    undecided: roles(a.undecided),
    fixed: roles(a.fixed),
    pool: roles(a.pool),
    autoReallocate: a.autoReallocate === true,
    deployable: atomsText(a.deployableAtoms),
    pooled: atomsText(a.poolAtoms),
  };
}

/** The Planning Room may be asked: the principal left a split to two or more agents (or one, with no Room). */
export function canAskForPlan(s: AllocationState | null): boolean {
  return s !== null && (s.intent === "DYNAMIC" || s.intent === "HYBRID") && s.pool.length > 0 && s.planning !== "NONE";
}

/** One row of "Your allocation": the budget, and who set it. */
export interface BudgetRow {
  readonly role: RoleName;
  readonly amount: string | null;
  readonly source: "YOU" | "AGENTS" | "AGENTS, EDITED BY YOU" | null;
}

/** Every enabled agent's budget from the draft, as the review shows it. The signed maxima are derived from exactly these. */
export function budgetRows(draft: JsonRecord, enabled: readonly RoleName[]): BudgetRow[] {
  const agents = rec(draft.agents);
  const provenance = rec(draft.provenance);
  return enabled.map((role) => {
    const value = rec(agents[role]).budget;
    const source = str(provenance[`agents.${role}.budget`]);
    return { role, amount: typeof value === "string" ? value : null, source: source === "PLANNED" ? "AGENTS" : source === "USER" || source === "INTERPRETED" ? "YOU" : null };
  });
}

const decimal = (text: string | null | undefined): number | null => (typeof text === "string" && /^\d+(\.\d{1,6})?$/.test(text.trim()) ? Number(text.trim()) : null);

export interface BudgetCheck {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly total: number;
  readonly kept: number | null;
}

/**
 * Immediate feedback on an edited split, mirroring the server's rules
 * (docs/v2/mandate-room-v2.md §3.4): no malformed value, no disabled agent,
 * no budget above an agent's ceiling or a domain cap, no total above what
 * may be deployed. Display only — the server validates again.
 */
export function checkBudgets(input: {
  readonly budgets: { readonly [role: string]: string };
  readonly enabled: readonly RoleName[];
  readonly deployable: string | null;
  readonly ceilings?: { readonly [role: string]: string | null };
  readonly derivativeCap?: string | null;
  readonly illiquidCap?: string | null;
}): BudgetCheck {
  const issues: string[] = [];
  let total = 0;
  for (const [role, raw] of Object.entries(input.budgets)) {
    const name = ROLE_TITLES[role as RoleName] ?? role;
    if (!input.enabled.includes(role as RoleName)) {
      issues.push(`${name} is not enabled: it can be given no budget.`);
      continue;
    }
    const v = decimal(raw);
    if (v === null) {
      issues.push(`${name}: "${raw}" is not a USDC amount.`);
      continue;
    }
    total += v;
    const ceiling = decimal(input.ceilings?.[role] ?? null);
    if (ceiling !== null && v > ceiling) issues.push(`${name} may use at most $${ceiling}.`);
    if (role === "perps" && decimal(input.derivativeCap ?? null) !== null && v > (decimal(input.derivativeCap ?? null) as number)) issues.push(`Perps is above the derivative limit ($${input.derivativeCap}).`);
    if (role === "nft" && decimal(input.illiquidCap ?? null) !== null && v > (decimal(input.illiquidCap ?? null) as number)) issues.push(`NFT is above the illiquid limit ($${input.illiquidCap}).`);
  }
  const deployable = decimal(input.deployable);
  if (deployable !== null && total > deployable + 1e-9) issues.push(`The budgets add up to $${total}; at most $${deployable} may be deployed.`);
  return { ok: issues.length === 0, issues, total, kept: deployable === null ? null : Math.max(0, deployable - total) };
}

/** A proposed split as the server summarized it (view.lastPlan). */
export interface PlanView {
  readonly roomId: string;
  readonly purpose: string | null;
  readonly pool: string | null;
  readonly fixed: readonly { readonly role: RoleName; readonly amount: string | null }[];
  readonly budgets: readonly { readonly role: RoleName; readonly amount: string | null; readonly zero: string | null; readonly rationale: string; readonly candidate: string | null; readonly action: string }[];
  readonly allocated: string | null;
  readonly unallocated: string | null;
  readonly explanation: string;
}

const amountOf = (v: Json | undefined): string | null => {
  const r = rec(v);
  return typeof r.amount === "string" ? r.amount : null;
};

export function planView(lastPlan: Json | undefined): PlanView | null {
  const p = rec(lastPlan);
  if (typeof p.roomId !== "string") return null;
  const role = (v: Json | undefined) => str(v) as RoleName;
  return {
    roomId: p.roomId,
    purpose: typeof p.roomPurpose === "string" ? p.roomPurpose : null,
    pool: amountOf(p.pool),
    fixed: arr(p.fixed).map(rec).map((f) => ({ role: role(f.role), amount: amountOf(f.budget) })),
    budgets: arr(p.budgets).map(rec).map((b) => ({ role: role(b.role), amount: amountOf(b.budget), zero: typeof b.zero === "string" ? b.zero : null, rationale: typeof b.rationale === "string" ? b.rationale : "", candidate: typeof b.candidate === "string" ? b.candidate : null, action: str(b.action) })),
    allocated: amountOf(p.allocated),
    unallocated: amountOf(p.unallocated),
    explanation: str(p.explanation),
  };
}

/** One agent in a Planning Room, from its OPPORTUNITY_CARD_CREATED event as it arrives. */
export interface PlanningCard {
  readonly role: RoleName;
  readonly action: string;
  readonly candidate: string | null;
  readonly rationale: string;
  readonly runtime: string;
}

export function planningCards(events: readonly LiveEvent[], roomId: string | null): PlanningCard[] {
  const opened = [...events].reverse().find((e) => e.kind === "ROOM_OPENED" && e.data.stage === "PRE_AUTHORIZATION" && (roomId === null || e.roomId === roomId));
  const room = roomId ?? opened?.roomId ?? null;
  return events
    .filter((e) => e.kind === "OPPORTUNITY_CARD_CREATED" && e.roomId === room && e.agent !== null)
    .map((e) => ({ role: e.agent as RoleName, action: str(e.data.action), candidate: typeof e.data.candidate === "string" ? e.data.candidate : null, rationale: str(e.data.rationale), runtime: str(e.data.runtime) }));
}

/** What each Room is for, in the words the page uses. Never the generic "shared authority conflict" unless it is one. */
export const ROOM_PURPOSE_COPY: Readonly<Record<string, string>> = {
  INITIAL_ALLOCATION: "Agents are proposing how to allocate your capital.",
  HYBRID_ALLOCATION: "Agents are proposing how to allocate the capital you left to them.",
  REALLOCATION: "Agents are deciding how released capital should be reassigned.",
  SHARED_RESOURCE_COORDINATION: "Valid proposals are competing for shared authority.",
};

export function roomCopy(purpose: Json | undefined): string {
  return ROOM_PURPOSE_COPY[str(purpose)] ?? "Agents are coordinating inside your signed limits.";
}

/** The Stock trade that received execution authority: a RESERVED Stock proposal in a real Mandate verdict. */
export interface AuthorizedStockTrade {
  readonly authorized: boolean;
  /** The candidate the model chose, shown only when that choice was reserved. */
  readonly candidate: string | null;
  readonly amount: string | null;
}

/**
 * Derived only from PORTFOLIO_AUTHORIZED: a Stock proposal the verifier
 * reserved. A Stock proposal that was blocked, refused, stale or never made
 * is no trade decision, and offers no settlement control. The model's choice
 * alone is never shown as one.
 */
export function authorizedStockTrade(events: readonly LiveEvent[], reservations: readonly JsonRecord[] = []): AuthorizedStockTrade {
  let amount: string | null = null;
  for (const e of events) {
    if (e.kind !== "PORTFOLIO_AUTHORIZED") continue;
    for (const p of arr(e.data.proposals).map(rec)) if (p.role === "stock" && p.outcome === "RESERVED" && typeof p.requested === "string") amount = p.requested;
  }
  const reserved = amount !== null || reservations.some((r) => r.role === "stock");
  if (!reserved) return { authorized: false, candidate: null, amount: null };
  const decision = [...events].reverse().find((e) => e.kind === "AGENT_DECISION_COMPLETED" && e.agent === "stock");
  return { authorized: true, candidate: decision === undefined ? null : str(decision.data.candidate), amount };
}

/** The candidate pipeline and Room semantics a server must advertise before this page runs agents against it. */
export const REQUIRED_PIPELINE = "DISCOVERED>ACTIONABLE>EXECUTABLE>MODEL";
export const REQUIRED_ROOM_SEMANTICS = "MANDATE_ROOM_V2_PLAN_BOUND";

export function serverCompatible(status: JsonRecord | null): boolean {
  return status !== null && status.candidatePipeline === REQUIRED_PIPELINE && status.roomSemantics === REQUIRED_ROOM_SEMANTICS;
}

export const STALE_SERVER = "This local server was started from older code: it does not provide the plan-bound Mandate Room V2 authorization contract. Restart it (npm run agents:lab) and reload.";
