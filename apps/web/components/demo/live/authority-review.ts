/**
 * C2.1 authority Review presentation
 * (docs/demo/c2-1-authority-review.md).
 *
 * Pure: derives what the Review screen shows from the session draft JSON and
 * allocation view. Does not decide authority and does not call the server.
 */

import { arr, rec, str, type JsonRecord } from "./live-client.ts";
import { ROLE_TITLES, ROLES, usd, type RoleName } from "./live-model.ts";
import type { AllocationState } from "./allocation-model.ts";

export type AgentEnableState = "ENABLED" | "DISABLED" | "NOT_SELECTED";

export interface AgentReviewRow {
  readonly role: RoleName;
  readonly title: string;
  readonly state: AgentEnableState;
  readonly stateLabel: string;
  readonly authorityLabel: string;
  /** Accepted / principal-set plan amount (draft budget), when present. */
  readonly currentPlan: string | null;
  readonly fixedBudget: string | null;
  /** Signed envelope ceiling (draft maxAllocation), when present. */
  readonly maxAuthority: string | null;
  readonly dynamicPool: boolean;
  readonly provenanceLabel: string | null;
}

export interface AllocationReview {
  readonly intent: string;
  readonly headline: string;
  readonly detail: string;
  readonly planningNote: string | null;
  /** Current plan rows (budgets / available). Distinct from maximum authority. */
  readonly lines: readonly { readonly label: string; readonly value: string }[];
  /** Per-agent signed maxima when they differ from, or accompany, the current plan. */
  readonly maxLines: readonly { readonly label: string; readonly value: string }[];
}

export interface AdvancedRow {
  readonly group: string;
  readonly label: string;
  readonly value: string;
  readonly advisory?: boolean;
}

export interface ReviewIssueCard {
  readonly index: number;
  readonly kind: string;
  readonly field: string | null;
  readonly text: string;
  readonly dangerous: boolean;
  readonly softUnsupported: boolean;
  readonly capitalChoices: readonly string[] | null;
}

export interface ReviewBlocker {
  readonly id: string;
  readonly text: string;
}

export interface ReviewChange {
  readonly field: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

export interface AuthorityReviewModel {
  readonly total: string;
  readonly currency: string;
  readonly maxDeployable: string | null;
  readonly minUnallocated: string | null;
  readonly totalProvenance: string | null;
  readonly agents: readonly AgentReviewRow[];
  readonly allocation: AllocationReview;
  readonly advanced: readonly AdvancedRow[];
  readonly riskPreference: { readonly label: string; readonly advisory: true } | null;
  readonly changes: readonly ReviewChange[];
  readonly unsupported: readonly ReviewIssueCard[];
  readonly conflicts: readonly ReviewIssueCard[];
  readonly ambiguities: readonly ReviewIssueCard[];
  readonly clarifications: readonly ReviewIssueCard[];
  readonly blockers: readonly ReviewBlocker[];
  readonly canAuthorize: boolean;
  readonly blockerSummary: string;
}

const SOURCE: Readonly<Record<string, string>> = {
  INTERPRETED: "From your prompt",
  EXPLICIT_PROMPT: "From your prompt",
  MODEL_EXTRACTED: "Suggested by model",
  DETERMINISTIC_DERIVED: "Derived from total",
  PRESET: "Default",
  USER: "Entered manually",
  PLANNED: "From Planning Room",
};

const DANGEROUS = [/recipient/i, /send (?:funds|profits|output|money)/i, /0x[a-f0-9]{40}/i, /calldata/i, /ignore (?:previous|all)/i, /any venue/i, /unbounded leverage|whatever leverage/i];

function money(text: string): string {
  return text === "" ? "—" : usd(text);
}

function agentState(enabled: unknown): AgentEnableState {
  if (enabled === true) return "ENABLED";
  if (enabled === false) return "DISABLED";
  return "NOT_SELECTED";
}

function parseCapitalChoices(text: string): readonly string[] | null {
  const matches = [...text.matchAll(/\$(\d[\d,]*(?:\.\d+)?)/g)].map((m) => (m[1] ?? "").replace(/,/g, ""));
  const unique = [...new Set(matches)].filter((x) => x !== "");
  return unique.length >= 2 ? unique : null;
}

function issueCards(issues: readonly JsonRecord[]): ReviewIssueCard[] {
  return issues.map((issue, index) => {
    const kind = str(issue.kind);
    const text = str(issue.text);
    const dangerous = kind === "UNSUPPORTED" && DANGEROUS.some((re) => re.test(text));
    const softUnsupported = kind === "UNSUPPORTED" && !dangerous;
    return {
      index,
      kind,
      field: typeof issue.field === "string" ? issue.field : null,
      text,
      dangerous,
      softUnsupported,
      capitalChoices: kind === "CONFLICT" && /which total|portfolio capital/i.test(text) ? parseCapitalChoices(text) : null,
    };
  });
}

function agentBudget(agents: JsonRecord, role: RoleName): string | null {
  const value = rec(agents[role]).budget;
  return typeof value === "string" ? value : null;
}

function agentMax(agents: JsonRecord, role: RoleName): string | null {
  const value = rec(agents[role]).maxAllocation;
  return typeof value === "string" ? value : null;
}

function maxAuthorityLines(agents: JsonRecord, roles: readonly RoleName[]): readonly { readonly label: string; readonly value: string }[] {
  return roles.flatMap((role) => {
    const max = agentMax(agents, role);
    return max === null ? [] : [{ label: ROLE_TITLES[role].replace(" Agent", ""), value: `up to ${money(max)}` }];
  });
}

/** Compact label: current plan stays distinct from the signed maximum. */
export function planAuthorityLabel(budget: string | null, max: string | null, mode: "fixed" | "dynamic" | "enabled"): string {
  if (mode === "fixed" && budget !== null) return `Fixed allocation ${money(budget)}`;
  if (budget !== null && max !== null) return `${money(budget)} planned · up to ${money(max)}`;
  if (budget !== null) return `${money(budget)} planned`;
  if (mode === "dynamic") return max !== null ? `Dynamic remainder · up to ${money(max)}` : "Dynamic remainder";
  if (max !== null) return `Up to ${money(max)}`;
  return "Enabled · ceiling unset";
}

function allocationReview(allocation: AllocationState | null, draft: JsonRecord): AllocationReview {
  const intent = allocation?.intent ?? "UNKNOWN";
  const agents = rec(draft.agents);
  const planNote =
    allocation?.autoReallocate === true
      ? "Agents may reallocate unused capital only within their signed maximums."
      : "Current allocations may be lower than each agent's signed maximum.";
  if (intent === "NEEDS_AGENT_SELECTION") {
    return {
      intent,
      headline: "Choose agents",
      detail: "Choose which agents may use this capital.",
      planningNote: "Authorization is blocked until agents are selected.",
      lines: [],
      maxLines: [],
    };
  }
  if (intent === "FIXED") {
    const roles = allocation?.fixed ?? [];
    const lines = roles.map((role) => ({
      label: ROLE_TITLES[role].replace(" Agent", ""),
      value: money(agentBudget(agents, role) ?? ""),
    }));
    return {
      intent,
      headline: "Fixed",
      detail: "Each enabled agent has a principal-set budget.",
      planningNote: "No Planning Room is required for the initial split.",
      lines,
      maxLines: maxAuthorityLines(agents, roles),
    };
  }
  if (intent === "DYNAMIC") {
    const pool = allocation?.pool ?? [];
    const planned = allocation?.planning === "COMPLETE" && pool.every((role) => agentBudget(agents, role) !== null);
    if (planned) {
      let used = 0;
      const lines = pool.map((role) => {
        const amount = agentBudget(agents, role) ?? "";
        if (/^\d+(\.\d+)?$/.test(amount)) used += Number(amount);
        return { label: ROLE_TITLES[role].replace(" Agent", ""), value: money(amount) };
      });
      const deployable = allocation?.deployable;
      if (deployable !== null && deployable !== undefined && /^\d+(\.\d+)?$/.test(deployable)) {
        const available = Math.max(0, Number(deployable) - used);
        lines.push({ label: "Available", value: money(String(available)) });
      }
      return {
        intent,
        headline: "Current plan",
        detail: planNote,
        planningNote: null,
        lines,
        maxLines: maxAuthorityLines(agents, pool),
      };
    }
    return {
      intent,
      headline: "Agents decide the split",
      detail: `${money(allocation?.deployable ?? "")} available to ${pool.map((r) => ROLE_TITLES[r].replace(" Agent", "")).join(", ") || "selected agents"}.`,
      planningNote:
        allocation?.planning === "REQUIRED" || allocation?.planning === "OPTIONAL"
          ? (pool.length === 1 ? "The agent will propose how much of its available capital to use before authorization." : "Planning Room will propose the allocation before authorization.")
          : null,
      lines: pool.map((role) => ({ label: ROLE_TITLES[role].replace(" Agent", ""), value: "In the flexible pool" })),
      maxLines: maxAuthorityLines(agents, pool),
    };
  }
  if (intent === "HYBRID") {
    const pool = allocation?.pool ?? [];
    const fixed = allocation?.fixed ?? [];
    const poolPlanned = allocation?.planning === "COMPLETE" && pool.every((role) => agentBudget(agents, role) !== null);
    if (poolPlanned) {
      const lines = [
        ...fixed.map((role) => ({
          label: `${ROLE_TITLES[role].replace(" Agent", "")} fixed`,
          value: money(agentBudget(agents, role) ?? ""),
        })),
        ...pool.map((role) => ({
          label: ROLE_TITLES[role].replace(" Agent", ""),
          value: money(agentBudget(agents, role) ?? ""),
        })),
      ];
      return {
        intent,
        headline: "Current plan",
        detail: planNote,
        planningNote: null,
        lines,
        maxLines: maxAuthorityLines(agents, [...fixed, ...pool]),
      };
    }
    const lines = [
      ...fixed.map((role) => ({
        label: `${ROLE_TITLES[role].replace(" Agent", "")} fixed`,
        value: money(agentBudget(agents, role) ?? ""),
      })),
      { label: "Flexible pool", value: money(allocation?.pooled ?? "") },
    ];
    return {
      intent,
      headline: "Fixed + flexible",
      detail: "Planning Room allocates only the flexible pool.",
      planningNote: "Review the proposed pool split before authorizing.",
      lines,
      maxLines: maxAuthorityLines(agents, [...fixed, ...pool]),
    };
  }
  return { intent, headline: intent, detail: "", planningNote: null, lines: [], maxLines: [] };
}

function advancedRows(draft: JsonRecord, notes: readonly string[]): AdvancedRow[] {
  const portfolio = rec(draft.portfolio);
  const market = rec(draft.market);
  const out: AdvancedRow[] = [];
  const perpsOn = rec(rec(draft.agents).perps).enabled === true;
  const lev = typeof market.maxLeverage === "string" ? market.maxLeverage : "";
  out.push({
    group: "Execution limits",
    label: "Leverage",
    value: lev === "" ? (perpsOn ? "Not granted" : "Not set") : `≤ ${lev}×`,
  });
  if (typeof market.maxSlippageBps === "string" && market.maxSlippageBps !== "") {
    out.push({ group: "Execution limits", label: "Slippage", value: `≤ ${market.maxSlippageBps} bps` });
  }
  if (typeof market.maxQuoteAgeSeconds === "string" && market.maxQuoteAgeSeconds !== "") {
    out.push({ group: "Execution limits", label: "Quote freshness", value: `≤ ${market.maxQuoteAgeSeconds} s` });
  }
  out.push({ group: "Execution limits", label: "Buy / sell", value: "Buy / open / deposit only (lab action set)" });

  if (typeof portfolio.maxDerivative === "string" && portfolio.maxDerivative !== "") {
    out.push({ group: "Exposure", label: "Derivative exposure", value: `≤ ${money(portfolio.maxDerivative)}` });
  }
  if (typeof portfolio.maxIlliquid === "string" && portfolio.maxIlliquid !== "") {
    out.push({ group: "Exposure", label: "Illiquid exposure", value: `≤ ${money(portfolio.maxIlliquid)}` });
  }

  const venues = Array.isArray(market.venues) ? market.venues : null;
  if (venues !== null) out.push({ group: "Assets & venues", label: "Venues", value: `${venues.length} approved venues only` });
  const assets = Array.isArray(market.assets) ? market.assets : null;
  if (assets !== null) out.push({ group: "Assets & venues", label: "Assets", value: assets.map(String).join(", ") });

  out.push({
    group: "Mandate lifecycle",
    label: "Auto reallocation",
    value: portfolio.autoReallocate === true ? "On" : "Off",
  });
  if (typeof portfolio.minUnallocated === "string" && portfolio.minUnallocated !== "") {
    out.push({ group: "Mandate lifecycle", label: "Minimum kept available", value: money(portfolio.minUnallocated) });
  } else {
    out.push({ group: "Mandate lifecycle", label: "Unused capital", value: "Allowed" });
  }
  if (typeof portfolio.validityMinutes === "string" && portfolio.validityMinutes !== "") {
    out.push({ group: "Mandate lifecycle", label: "Validity", value: `${portfolio.validityMinutes} minutes` });
  }

  const risk = notes.find((n) => /Risk preference \(advisory only\): (CONSERVATIVE|MODERATE|AGGRESSIVE)/i.exec(n));
  if (risk !== undefined) {
    const m = /Risk preference \(advisory only\): (CONSERVATIVE|MODERATE|AGGRESSIVE)/i.exec(risk);
    if (m?.[1] !== undefined) {
      out.push({ group: "Risk preference", label: "Risk preference", value: m[1].charAt(0) + m[1].slice(1).toLowerCase(), advisory: true });
    }
  }
  return out;
}

/** Build the Review model the Approve stage renders. */
export function buildAuthorityReview(input: {
  readonly draft: JsonRecord;
  readonly allocation: AllocationState | null;
  readonly validationOk: boolean;
  readonly validationBlocking: readonly JsonRecord[];
}): AuthorityReviewModel {
  const draft = input.draft;
  const portfolio = rec(draft.portfolio);
  const provenance = rec(draft.provenance);
  const agentsRec = rec(draft.agents);
  const notes = arr(draft.notes).map((n) => str(n));
  const issues = issueCards(arr(draft.issues).map(rec));
  const pool = new Set(input.allocation?.pool ?? []);
  const fixed = new Set(input.allocation?.fixed ?? []);

  const agents: AgentReviewRow[] = ROLES.map((role) => {
    const row = rec(agentsRec[role]);
    const state = agentState(row.enabled);
    const budget = typeof row.budget === "string" ? row.budget : null;
    const max = typeof row.maxAllocation === "string" ? row.maxAllocation : null;
    const source = str(provenance[`agents.${role}.budget`] || provenance[`agents.${role}.maxAllocation`] || provenance[`agents.${role}.enabled`]);
    const dynamicPool = state === "ENABLED" && pool.has(role);
    let authorityLabel = "—";
    if (state === "ENABLED") {
      if (fixed.has(role) && budget !== null) authorityLabel = planAuthorityLabel(budget, max, "fixed");
      else if (dynamicPool) authorityLabel = planAuthorityLabel(budget, max, "dynamic");
      else authorityLabel = planAuthorityLabel(budget, max, "enabled");
    } else if (state === "DISABLED") authorityLabel = "No authority";
    else authorityLabel = "Not selected";
    return {
      role,
      title: ROLE_TITLES[role].replace(" Agent", ""),
      state,
      stateLabel: state === "ENABLED" ? "Enabled" : state === "DISABLED" ? "Disabled" : "Not selected",
      authorityLabel,
      currentPlan: state === "ENABLED" ? budget : null,
      fixedBudget: fixed.has(role) ? budget : null,
      maxAuthority: max,
      dynamicPool,
      provenanceLabel: source === "—" ? null : SOURCE[source] ?? source,
    };
  });

  const unsupported = issues.filter((i) => i.kind === "UNSUPPORTED");
  const conflicts = issues.filter((i) => i.kind === "CONFLICT");
  const ambiguities = issues.filter((i) => i.kind === "AMBIGUOUS");
  const clarifications = issues.filter((i) => i.kind === "NEEDS_CLARIFICATION");

  const blockers: ReviewBlocker[] = [];
  for (const c of conflicts) blockers.push({ id: `conflict-${c.index}`, text: c.text });
  for (const a of ambiguities) blockers.push({ id: `ambiguous-${a.index}`, text: a.text });
  for (const c of clarifications) blockers.push({ id: `clarify-${c.index}`, text: c.text });
  for (const u of unsupported) {
    blockers.push({
      id: `unsupported-${u.index}`,
      text: u.dangerous ? u.text : `${u.text} (not in the signed mandate until acknowledged or removed)`,
    });
  }
  if (input.allocation?.intent === "NEEDS_AGENT_SELECTION") {
    blockers.push({ id: "agents", text: "Choose which agents may use this capital." });
  }
  if (input.allocation?.planning === "REQUIRED") {
    const single = (input.allocation.pool.length ?? 0) === 1;
    blockers.push({ id: "plan", text: single ? "Review the agent plan before authorizing." : "Ask the Planning Room for a split before authorizing." });
  }
  for (const issue of input.validationBlocking) {
    const code = str(issue.code);
    // Interpretation issues are already listed as conflicts / ambiguities / unsupported.
    if (code === "INTERPRETATION_UNRESOLVED") continue;
    blockers.push({ id: `val-${code}-${str(issue.field)}`, text: str(issue.message) });
  }

  const canAuthorize = input.validationOk && issues.length === 0 && input.allocation?.intent !== "NEEDS_AGENT_SELECTION" && input.allocation?.planning !== "REQUIRED";
  const blockerSummary =
    blockers.length === 0
      ? ""
      : `Resolve ${blockers.length} item${blockers.length === 1 ? "" : "s"} before authorizing`;

  const riskNote = notes.find((n) => /Risk preference \(advisory only\): (CONSERVATIVE|MODERATE|AGGRESSIVE)/i.test(n));
  const riskMatch = riskNote === undefined ? null : /Risk preference \(advisory only\): (CONSERVATIVE|MODERATE|AGGRESSIVE)/i.exec(riskNote);

  const evidence = rec(draft.evidence);
  const changes: ReviewChange[] = [];
  for (const [path, source] of Object.entries(provenance)) {
    if (source !== "USER") continue;
    const prior = str(rec(evidence[path]).sourceText);
    if (prior === "—" || prior === "") continue;
    const [section, a, b] = path.split(".");
    let current = "";
    if (section === "agents" && b !== undefined) current = String(rec(agentsRec[a ?? ""])[b ?? ""] ?? "");
    else if (section === "portfolio") current = String(portfolio[a ?? ""] ?? "");
    else if (section === "market") current = String(rec(draft.market)[a ?? ""] ?? "");
    if (current === "" || current === prior) continue;
    changes.push({ field: path, label: path.replace(/^agents\./, "").replace(/\./g, " "), from: prior, to: current });
  }

  return {
    total: typeof portfolio.totalCapital === "string" ? portfolio.totalCapital : "",
    currency: "USDC",
    maxDeployable: typeof portfolio.maxDeployed === "string" ? portfolio.maxDeployed : input.allocation?.deployable ?? null,
    minUnallocated: typeof portfolio.minUnallocated === "string" ? portfolio.minUnallocated : null,
    totalProvenance: (() => {
      const s = str(provenance["portfolio.totalCapital"]);
      return s === "—" ? null : SOURCE[s] ?? s;
    })(),
    agents,
    allocation: allocationReview(input.allocation, draft),
    advanced: advancedRows(draft, notes),
    riskPreference: riskMatch?.[1] === undefined ? null : { label: riskMatch[1].charAt(0) + riskMatch[1].slice(1).toLowerCase(), advisory: true },
    changes: changes.slice(0, 8),
    unsupported,
    conflicts,
    ambiguities,
    clarifications,
    blockers,
    canAuthorize,
    blockerSummary,
  };
}

export { SOURCE as REVIEW_SOURCE_LABELS };
