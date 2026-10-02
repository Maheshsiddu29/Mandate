"use client";

import { LatticeLoader, type LatticePatternName } from "@/components/react-bits/lattice-loader";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { explainReasons, ROLE_TITLES, usd, type AgentCard, type RoleName } from "./live-model";
import { AgentGlyph, Pill } from "./workspace-ui";

const PATTERNS: Record<RoleName, LatticePatternName> = { stock: "orbit", swap: "ripple", nft: "snake", yield: "sweep", perps: "orbit" };

export function elapsedSince(at: string | null, now: number): number | null {
  if (at === null) return null;
  const start = Date.parse(at);
  return Number.isNaN(start) ? null : Math.max(0, now - start);
}

/** What Mandate concluded about one agent, in words first. The raw reason codes stay in details. */
export function mandateVerdict(agent: AgentCard): { readonly tone: "good" | "warn" | "bad" | "neutral"; readonly label: string; readonly line: string } | null {
  if (agent.finalOutcome === "RESERVED") return { tone: "good", label: "AUTHORIZED", line: `${usd(agent.finalAmount)} reserved` };
  if (agent.phase === "BLOCKED") return { tone: "bad", label: "BLOCKED", line: explainReasons(agent.reasons).headline || "Blocked" };
  if (agent.portfolioConflict) return { tone: "warn", label: "PORTFOLIO CONFLICT", line: "Valid action, but the portfolio is over a shared limit" };
  if (agent.phase === "ADMISSIBLE") return { tone: "good", label: "ALLOWED", line: "Inside your mandate" };
  if (agent.phase === "STALE") return { tone: "warn", label: "STALE QUOTE", line: "Quote expired; a fresh decision is required" };
  return null;
}

/**
 * Why Mandate refused, after the one-line verdict: every distinct reason in
 * words when there is more than one, then the exact protocol codes — one per
 * line, never joined — under Technical details, closed by default.
 */
export function MandateReasons({ reasons, summary = "Technical details" }: { readonly reasons: readonly string[]; readonly summary?: string }): ReactNode {
  const { labels, codes } = explainReasons(reasons);
  if (codes.length === 0) return null;
  return (
    <>
      {labels.length > 1 ? (
        <ul className="mw-reasons" aria-label="Reasons">
          {labels.map((label) => <li key={label}>{label}</li>)}
        </ul>
      ) : null}
      <details className="mw-disclosure mw-disclosure--inline">
        <summary>{summary}</summary>
        <ul className="mw-codes">{codes.map((reasonCode) => <li key={reasonCode}><code>{reasonCode}</code></li>)}</ul>
      </details>
    </>
  );
}

function quiet(agent: AgentCard): string | null {
  switch (agent.phase) {
    case "ABSTAINED": return "No proposal. Nothing was submitted.";
    case "TIMED OUT": return `${agent.title} agent didn't respond in time. No action was submitted.`;
    case "FAILED": return `${agent.title} agent couldn't respond. No action was submitted.`;
    case "INVALID RESPONSE": return `${agent.title} agent returned an invalid answer. No action was submitted.`;
    default: return null;
  }
}

function AgentActivity({ agent, now, enabled, reduced }: { readonly agent: AgentCard; readonly now: number; readonly enabled: boolean | null; readonly reduced: boolean }): ReactNode {
  const working = agent.phase === "PENDING" || agent.phase === "RESPONDING";
  const checking = agent.phase === "RESPONDED" || agent.phase === "SIGNED";
  const verdict = mandateVerdict(agent);
  const silent = quiet(agent);
  const decided = agent.candidate !== "—";
  if (enabled === false) {
    return (
      <li className="mw-activity" data-role={agent.role} data-state="off">
        <span className="mw-glyph"><AgentGlyph role={agent.role} /></span>
        <div className="mw-activity__body"><p className="mw-activity__name">{agent.title}</p><p className="mw-activity__line">No authority. This agent cannot propose.</p></div>
      </li>
    );
  }
  return (
    <motion.li layout={reduced ? false : "position"} className="mw-activity" data-role={agent.role} data-state={verdict?.tone ?? (silent === null ? (working || checking ? "working" : "idle") : "quiet")}>
      <span className="mw-glyph"><AgentGlyph role={agent.role} /></span>
      <div className="mw-activity__body">
        <div className="mw-activity__top">
          <p className="mw-activity__name">{agent.title}</p>
          {verdict === null ? null : <Pill tone={verdict.tone}>{verdict.label}</Pill>}
        </div>
        {agent.phase === "WAITING" ? <p className="mw-activity__line mw-muted">Waiting to start…</p> : null}
        {working ? (
          <LatticeLoader label={agent.phase === "RESPONDING" ? "Responding…" : agent.activity} status="working" pattern={PATTERNS[agent.role]} elapsedMs={elapsedSince(agent.startedAt, now)} className="mw-lattice--row" />
        ) : null}
        <AnimatePresence initial={false}>
          {decided ? (
            <motion.div key="decision" className="mw-layers" initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : 0.2, ease: [0.23, 1, 0.32, 1] }}>
              <div className="mw-layer mw-layer--model">
                <span className="mw-layer__tag">Model</span>
                <p className="mw-layer__main"><strong>{agent.candidate}</strong><span>{usd(agent.requested)}</span></p>
                {agent.rationale === "" ? null : <p className="mw-layer__why">{agent.rationale}</p>}
              </div>
              <div className="mw-layer mw-layer--mandate" data-tone={verdict?.tone ?? "neutral"}>
                <span className="mw-layer__tag">Mandate</span>
                {checking ? (
                  <LatticeLoader label="Checking with Mandate…" status="working" pattern="sweep" showTimer={false} className="mw-lattice--row" />
                ) : (
                  <p className="mw-layer__main"><strong>{verdict?.line ?? "Checked"}</strong></p>
                )}
                <MandateReasons reasons={agent.reasons} />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        {silent === null ? null : <p className="mw-activity__line">{silent}{agent.rationale !== "" && agent.phase === "ABSTAINED" ? <span className="mw-layer__why"> {agent.rationale}</span> : null}</p>}
      </div>
    </motion.li>
  );
}

export function AgentsStage(props: {
  readonly agents: readonly AgentCard[];
  readonly enabled: (role: RoleName) => boolean | null;
  readonly now: number;
  readonly reviewing: boolean;
  readonly version: number | null;
  readonly reduced: boolean;
}): ReactNode {
  const active = props.agents.filter((agent) => props.enabled(agent.role) !== false).length;
  return (
    <div className="mw-agents">
      <header className="mw-stage-head">
        <p className="mw-kicker">Mandate V{props.version ?? "—"} · {active} {active === 1 ? "agent" : "agents"}</p>
        <h2>{props.reviewing ? "Mandate review" : "Agents are working"}</h2>
        <p>{props.reviewing ? "Each proposal has been checked. Mandate is evaluating the portfolio as a whole." : "Each agent works independently. Nothing executes until Mandate allows it."}</p>
      </header>
      <ul className="mw-activity-list" aria-live="polite" aria-label="Agent activity">
        {props.agents.map((agent) => <AgentActivity key={agent.role} agent={agent} now={props.now} enabled={props.enabled(agent.role)} reduced={props.reduced} />)}
      </ul>
      {props.reviewing ? <div className="mw-inline-status" aria-live="polite"><LatticeLoader label="Checking the combined portfolio" status="working" pattern="sweep" showTimer={false} /></div> : null}
    </div>
  );
}

/** One line per agent, for the collapsed trail and the review. */
export function AgentSummaryList({ agents, enabled }: { readonly agents: readonly AgentCard[]; readonly enabled: (role: RoleName) => boolean | null }): ReactNode {
  return (
    <ul className="mw-verdicts">
      {agents.map((agent) => {
        const verdict = mandateVerdict(agent);
        const silent = quiet(agent);
        const off = enabled(agent.role) === false;
        const mark = off ? "–" : verdict === null ? "·" : verdict.tone === "good" ? "✓" : verdict.tone === "bad" ? "✕" : "!";
        return (
          <li key={agent.role} data-tone={off ? "neutral" : verdict?.tone ?? "neutral"}>
            <span className="mw-verdicts__mark" aria-hidden="true">{mark}</span>
            <strong>{ROLE_TITLES[agent.role]}</strong>
            <span>{off ? "No authority" : verdict?.line ?? silent ?? "Not evaluated"}</span>
          </li>
        );
      })}
    </ul>
  );
}
