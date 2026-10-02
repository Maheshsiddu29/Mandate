"use client";

import { LatticeLoader } from "@/components/react-bits/lattice-loader";
import { useState, type ReactNode } from "react";
import { rec, str, type JsonRecord, type LiveEvent } from "./live-client";
import { explainReasons, formatDuration, groupEventsByElapsed, ROLE_TITLES, usd, type AgentCard, type RoleName, type SettlementView, type StressAttempt, type TradeReview } from "./live-model";
import { MandateReasons, mandateVerdict } from "./stage-agents";
import { AgentGlyph, Pill } from "./workspace-ui";

const TABS = ["Summary", "Decisions", "Evidence"] as const;
const IDENTITY_ROWS = [["agentIdentity", "Identity", "VALID"], ["membership", "Membership", "VALID"], ["delegation", "Delegation", "ACTIVE"], ["signature", "Signature", "VALID"]] as const;

/** Post-trade review. Every count comes from the run's events. */
export function ReviewBody(props: {
  readonly review: TradeReview;
  readonly agents: readonly AgentCard[];
  readonly settlement: SettlementView;
  readonly mandate: JsonRecord | null;
  readonly sessionId: string;
  readonly provider: string;
  readonly eventCount: number;
  readonly onEvents: () => void;
}): ReactNode {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Summary");
  const { review } = props;
  return (
    <div className="mw-review">
      <div className="mw-segmented" role="tablist" aria-label="Review sections">
        {TABS.map((name) => (
          <button key={name} type="button" role="tab" id={`review-tab-${name}`} aria-selected={tab === name} aria-controls={`review-panel-${name}`} onClick={() => setTab(name)}>{name}</button>
        ))}
      </div>
      <div role="tabpanel" id={`review-panel-${tab}`} aria-labelledby={`review-tab-${tab}`}>
        {tab === "Summary" ? (
          <>
            <h3 className="mw-review__h">What happened</h3>
            <ul className="mw-tally">
              <li><strong>{review.evaluated}</strong> {review.evaluated === 1 ? "agent evaluated" : "agents evaluated"}</li>
              <li data-tone="bad"><strong>{review.blocked}</strong> {review.blocked === 1 ? "action blocked" : "actions blocked"}</li>
              {review.noProposal > 0 ? <li><strong>{review.noProposal}</strong> without a proposal</li> : null}
              <li data-tone="warn"><strong>{review.conflictsResolved}</strong> {review.conflictsResolved === 1 ? "portfolio conflict resolved" : "portfolio conflicts resolved"}</li>
              <li data-tone="good"><strong>{review.authorizedCount}</strong> {review.authorizedCount === 1 ? "action authorized" : "actions authorized"}</li>
              <li data-tone={review.settlementsConfirmed > 0 ? "good" : undefined}><strong>{review.settlementsConfirmed}</strong> {review.settlementsConfirmed === 1 ? "testnet settlement" : "testnet settlements"} confirmed</li>
            </ul>
            <p className="mw-fine">Agents propose. Agents negotiate. Mandate authorizes. Markets settle.</p>
          </>
        ) : null}
        {tab === "Decisions" ? (
          <ul className="mw-decisions">
            {props.agents.filter((agent) => agent.startedAt !== null).map((agent) => {
              const verdict = mandateVerdict(agent);
              return (
                <li key={agent.role} data-role={agent.role}>
                  <p className="mw-decisions__name"><span className="mw-glyph mw-glyph--sm"><AgentGlyph role={agent.role} size={16} /></span>{agent.title}</p>
                  <div className="mw-layer mw-layer--model">
                    <span className="mw-layer__tag">Model proposed</span>
                    <p className="mw-layer__main">{agent.candidate === "—" ? <strong>No proposal</strong> : <><strong>{agent.candidate}</strong><span>{usd(agent.requested)}</span></>}</p>
                    {agent.rationale === "" ? null : <p className="mw-layer__why">{agent.rationale}</p>}
                  </div>
                  <div className="mw-layer mw-layer--mandate" data-tone={verdict?.tone ?? "neutral"}>
                    <span className="mw-layer__tag">Mandate decided</span>
                    <p className="mw-layer__main"><strong>{verdict?.line ?? (agent.phase === "ABSTAINED" ? "Nothing to decide" : agent.phase.toLowerCase())}</strong></p>
                    <MandateReasons reasons={agent.reasons} />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {tab === "Evidence" ? (
          <dl className="mw-evidence">
            <div><dt>Session</dt><dd><code>{props.sessionId}</code></dd></div>
            <div><dt>Model provider</dt><dd>{props.provider}</dd></div>
            {props.mandate === null ? null : <>
              <div><dt>Mandate</dt><dd>V{str(props.mandate.version)} · {str(props.mandate.status)}</dd></div>
              <div><dt>Mandate digest</dt><dd><code>{str(props.mandate.digest)}</code></dd></div>
              <div><dt>Signed with</dt><dd>{str(props.mandate.signatureLabel)}</dd></div>
            </>}
            {props.mandate === null ? null : <div><dt>Portfolio authorization</dt><dd>{str(rec(props.mandate.authorization).method) === "WALLET_PRINCIPAL_V2" ? `Wallet principal · ${str(rec(props.mandate.authorization).principal)}` : str(rec(props.mandate.authorization).method) === "WALLET_EIP712" ? `Wallet-signed mandate · ${str(rec(props.mandate.authorization).principal)}` : "Demo principal key (not a wallet signature)"}</dd></div>}
            <div><dt>Domain settlement authority</dt><dd>{props.settlement.principals === null ? "Separate testnet custody (not delegated by the mandate signature)" : props.settlement.principals.domainKind === "SAME_PRINCIPAL" ? `Same address as the wallet · ${props.settlement.principals.domainAddress}` : props.settlement.principals.domainKind === "WALLET_GATE_EIP712" ? `Wallet gate signature, per execution · ${props.settlement.principals.domainAddress}` : `Separate testnet custody · ${props.settlement.principals.domainAddress}`}</dd></div>
            <div><dt>Settlement evidence</dt><dd>{props.settlement.settled ? "LIVE_TESTNET" : props.settlement.evidence ?? "None in this session"}{props.settlement.consumed ? " · reservation consumed" : ""}{props.settlement.rpcProvider === null ? "" : ` · RPC ${props.settlement.rpcProvider}`}</dd></div>
            <div><dt>Events</dt><dd>{props.eventCount} · <button type="button" className="mw-text-button" onClick={props.onEvents}>Open event log</button></dd></div>
          </dl>
        ) : null}
        {tab === "Evidence" ? <CandidateEvidence agents={props.agents} /> : null}
      </div>
    </div>
  );
}

/**
 * Developer evidence: what each agent discovered, what eligibility let it
 * choose from, and why the rest stayed discovery only. Eligibility is
 * advisory; Mandate still screened every proposal in full.
 */
function CandidateEvidence({ agents }: { readonly agents: readonly AgentCard[] }): ReactNode {
  const evaluated = agents.filter((agent) => agent.eligibility !== null);
  if (evaluated.length === 0) return null;
  return (
    <section className="mw-candidates" aria-label="Candidate eligibility">
      <h3 className="mw-review__h">Candidates</h3>
      <p className="mw-fine">Discovery is broad; each model chose only among actionable candidates. Eligibility is advisory — every proposal was still checked by Mandate.</p>
      <ul>
        {evaluated.map((agent) => (
          <li key={agent.role}>
            <p className="mw-decisions__name"><span className="mw-glyph mw-glyph--sm"><AgentGlyph role={agent.role} size={16} /></span>{agent.title}</p>
            <ul className="mw-candidates__list">
              {agent.eligibility?.actionable.map((id) => <li key={id}><code>{id}</code><Pill tone="good">ACTIONABLE</Pill></li>)}
              {agent.eligibility?.excluded.map((row) => (
                <li key={row.candidateId}>
                  <code>{row.candidateId}</code><Pill>DISCOVERY ONLY</Pill>
                  <span>{explainReasons(row.codes).headline}</span>
                  <MandateReasons reasons={row.codes} />
                </li>
              ))}
              {agent.eligibility?.actionable.length === 0 ? <li className="mw-fine">No eligible opportunities under this mandate.</li> : null}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

const READABLE: Readonly<Record<string, string>> = {
  AGENT_CANDIDATES_EVALUATED: "Candidate eligibility evaluated",
  AGENT_REQUEST_STARTED: "Agent request started",
  AGENT_FIRST_RESPONSE: "First response received",
  AGENT_DECISION_COMPLETED: "Model decision completed",
  PROPOSAL_BLOCKED: "Mandate blocked proposal",
  PROPOSAL_ADMISSIBLE: "Proposal individually admissible",
  PORTFOLIO_CONFLICT: "Portfolio conflict detected",
  ROOM_OPENED: "Mandate Room opened",
  ROOM_AGENT_RESPONSE: "Room response received",
  ROOM_PROPOSAL_CREATED: "Room proposal ready",
  MANDATE_REVERIFY_STARTED: "Mandate re-verification started",
  PORTFOLIO_AUTHORIZED: "Portfolio authorized and reserved",
  PORTFOLIO_REFUSED: "Portfolio refused",
};

export function eventSummary(event: LiveEvent): string {
  const agent = event.agent === null ? "" : `${ROLE_TITLES[event.agent as RoleName] ?? event.agent} · `;
  const text = event.kind === "ROOM_GENERATION_STARTED" ? `Round ${event.generation ?? "—"} started` : READABLE[event.kind] ?? event.kind.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
  return `${agent}${text}`;
}

/** The exact stream. Sequence is authoritative; equal real timestamps stay equal and are grouped. */
export function EventLogBody({ events }: { readonly events: readonly LiveEvent[] }): ReactNode {
  const groups = groupEventsByElapsed(events);
  return (
    <div className="mw-events">
      <p className="mw-fine">MANDATE_LIVE_AI.V1 · {events.length} events. Sequence is authoritative. Equal real timestamps stay equal and are grouped.</p>
      <ol className="mw-event-groups">
        {groups.map((group) => (
          <li key={`${group.elapsedMs}:${group.events[0]?.sequence}`}>
            <time dateTime={group.at}>{formatDuration(group.elapsedMs)}</time>
            <ol>
              {group.events.map((event) => (
                <li key={event.sequence}>
                  <span className="mw-events__step">Step {event.sequence + 1}</span>
                  <span>{eventSummary(event)}</span>
                  <details className="mw-disclosure mw-disclosure--inline"><summary>Raw event</summary><code>{event.kind}</code><pre>{JSON.stringify(event.data, null, 2)}</pre></details>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}

function caseTitle(caseId: string): string {
  return caseId.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

/** The security demo: the same valid Swap agent, different actions, different authorization results. */
export function StressBody(props: { readonly attempts: readonly StressAttempt[]; readonly started: boolean; readonly running: boolean; readonly canRun: boolean; readonly onRun: () => void }): ReactNode {
  const identity = props.attempts.find((attempt) => Object.keys(attempt.identity).length > 0)?.identity ?? {};
  return (
    <div className="mw-stress">
      <p className="mw-stress__thesis">VALID AGENT ≠ VALID ACTION</p>
      <p>The same authorized Swap agent submits a series of actions. Its identity, membership, delegation and signature stay valid throughout. Mandate judges each action, not the agent&apos;s reputation.</p>
      <button type="button" className="mw-cta" disabled={!props.canRun || props.running} onClick={props.onRun}>{props.running ? "Testing…" : props.started ? "Run the test again" : "Test the firewall"}</button>
      {props.started ? (
        <>
          <dl className="mw-identity">
            {IDENTITY_ROWS.map(([key, label, fallback]) => (
              <div key={key}><dt>{label}</dt><dd><Pill tone="good">{str(identity[key] ?? fallback)}</Pill></dd></div>
            ))}
          </dl>
          <ol className="mw-attempts" aria-live="polite">
            {props.attempts.map((attempt, index) => (
              <li key={attempt.attempt} data-outcome={attempt.outcome}>
                <span className="mw-attempts__n">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <p className="mw-attempts__case">{caseTitle(attempt.caseId)}</p>
                  <p className="mw-fine">{attempt.reasons.length > 0 ? explainReasons(attempt.reasons).headline || "Refused" : attempt.outcome === "AUTHORIZED" ? "Compliant control" : attempt.outcome === "PENDING" ? "Evaluating…" : "Not submitted"}</p>
                  {attempt.rationale === "" ? null : <details className="mw-disclosure mw-disclosure--inline"><summary>Declared rationale</summary><p>{attempt.rationale}</p></details>}
                  <MandateReasons reasons={attempt.reasons} />
                </div>
                {attempt.outcome === "PENDING" ? <LatticeLoader label="Evaluating" status="working" pattern="ripple" showTimer={false} /> : <Pill tone={attempt.outcome === "AUTHORIZED" ? "good" : attempt.outcome === "REFUSED" ? "bad" : "neutral"}>{attempt.outcome}</Pill>}
              </li>
            ))}
          </ol>
          <p className="mw-stress__foot"><span>SAME AGENT</span><span>DIFFERENT ACTION</span><strong>DIFFERENT AUTHORIZATION RESULT</strong></p>
        </>
      ) : null}
    </div>
  );
}

export function PauseBody({ phrase, onPause }: { readonly phrase: string; readonly onPause: (text: string) => void }): ReactNode {
  const [text, setText] = useState("");
  return (
    <div className="mw-pause">
      <p>Pausing revokes the active mandate. Existing reservations stay recorded; nothing new can be authorized.</p>
      <label className="mw-confirm"><span>Type <code>{phrase}</code></span><input value={text} onChange={(event) => setText(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      <button type="button" className="mw-danger-button" disabled={text !== phrase} onClick={() => onPause(text)}>Pause mandate</button>
    </div>
  );
}
