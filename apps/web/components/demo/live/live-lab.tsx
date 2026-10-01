"use client";

import { LatticeLoader, type LatticePatternName } from "@/components/react-bits/lattice-loader";
import { PromptBar } from "@/components/react-bits/prompt-bar";
import { useReducedMotion } from "@/lib/motion";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, arr, code, liveServerUrl, rec, str, streamEvents, type Json, type JsonRecord, type LiveEvent } from "./live-client";
import {
  derivePresentation,
  formatDuration,
  groupEventsByElapsed,
  reasonLabel,
  resourceLabel,
  ROLE_TITLES,
  ROLES,
  type AgentCard,
  type RoleName,
} from "./live-model";
import "./live-lab.css";

const SERVER = liveServerUrl(process.env.NEXT_PUBLIC_LIVE_AGENTS_URL);
const REFRESH_ON = new Set([
  "MANDATE_VERSION_AUTHORIZED",
  "MANDATE_PAUSED",
  "PORTFOLIO_AUTHORIZED",
  "PORTFOLIO_REFUSED",
  "ROOM_FINALIZED",
  "POLICY_STRESS_COMPLETED",
  "MANDATE_AMENDMENT_REFUSED",
  "MANDATE_AMENDMENT_AUTHORIZED",
]);

const CHIPS = [
  "Deploy $2,000",
  "Keep $300 free",
  "Derivatives ≤ $400",
  "Approved venues only",
  "Prefer stocks + yield",
];

const TEXT_FIELDS: readonly { path: string; label: string; group: string }[] = [
  { path: "portfolio.totalCapital", label: "Total capital", group: "Capital" },
  { path: "portfolio.maxDeployed", label: "Maximum deployed", group: "Capital" },
  { path: "portfolio.minUnallocated", label: "Minimum unallocated", group: "Capital" },
  { path: "portfolio.maxDerivative", label: "Derivative exposure", group: "Risk" },
  { path: "portfolio.maxIlliquid", label: "Illiquid exposure", group: "Risk" },
  { path: "portfolio.validityMinutes", label: "Validity (minutes)", group: "Risk" },
  { path: "market.maxLeverage", label: "Leverage", group: "Execution" },
  { path: "market.maxSlippageBps", label: "Slippage (bps)", group: "Execution" },
  { path: "market.maxQuoteAgeSeconds", label: "Quote freshness (s)", group: "Execution" },
];

const STEPS = ["Mandate", "Agents", "Room", "Verify", "Settle"] as const;
const PATTERNS: Record<RoleName, LatticePatternName> = {
  stock: "orbit",
  swap: "ripple",
  nft: "snake",
  yield: "sweep",
  perps: "orbit",
};

function Badge({ value }: { readonly value: string }): ReactNode {
  const tone = /BLOCKED|REFUSED|FAILED|INVALID|NO AUTHORITY|IGNORED/.test(value)
    ? "bad"
    : /AUTHORIZED|RESERVED|ADMISSIBLE|VALID|ACTIVE|SATISFIED|SETTLED|LIVE_TESTNET|SUCCESS/.test(value)
      ? "good"
      : /CONFLICT|STALE|TIMED|PENDING|RESPONDING|WARNING|SEND|DRAFT|PAUSED|FIXTURE/.test(value)
        ? "warn"
        : "plain";
  return <span className={`live-badge live-badge--${tone}`}>{value}</span>;
}

function money(value: string): string {
  if (value === "" || value === "—") return "—";
  return `$${value.replace(/ USDC$/, "")}`;
}

function appendChip(prompt: string, chip: string): string {
  const clean = prompt.trim();
  if (clean === "") return `${chip}.`;
  return `${clean}${/[.!?]$/.test(clean) ? "" : "."} ${chip}.`;
}

function elapsedSince(at: string | null, now: number): number | null {
  if (at === null) return null;
  const start = Date.parse(at);
  return Number.isNaN(start) ? null : Math.max(0, now - start);
}

function stageFor(active: Json, events: readonly LiveEvent[], presentation: ReturnType<typeof derivePresentation>): number {
  if (active === null || active === undefined) return 0;
  if (presentation.room.reverify && !presentation.room.authorized && !presentation.room.refused) return 3;
  if (presentation.room.open && !presentation.room.authorized && !presentation.room.refused && !presentation.room.noFeasible) return 2;
  if (events.some((event) => event.kind === "PORTFOLIO_AUTHORIZED" || event.kind === "PORTFOLIO_REFUSED" || event.kind === "ROOM_NO_FEASIBLE_PORTFOLIO")) return 4;
  return 1;
}

function eventSummary(event: LiveEvent): string {
  const agent = event.agent === null ? "" : `${ROLE_TITLES[event.agent as RoleName] ?? event.agent} · `;
  const readable: Readonly<Record<string, string>> = {
    AGENT_REQUEST_STARTED: "Agent request started",
    AGENT_FIRST_RESPONSE: "First response received",
    AGENT_DECISION_COMPLETED: "Model decision completed",
    PROPOSAL_BLOCKED: "Mandate blocked proposal",
    PROPOSAL_ADMISSIBLE: "Proposal individually admissible",
    PORTFOLIO_CONFLICT: "Portfolio conflict detected",
    ROOM_OPENED: "Mandate Room opened",
    ROOM_GENERATION_STARTED: `Round ${event.generation ?? "—"} started`,
    ROOM_AGENT_RESPONSE: "Room response received",
    ROOM_PROPOSAL_CREATED: "Room proposal ready",
    MANDATE_REVERIFY_STARTED: "Mandate re-verification started",
    PORTFOLIO_AUTHORIZED: "Portfolio authorized and reserved",
    PORTFOLIO_REFUSED: "Portfolio refused",
  };
  return `${agent}${readable[event.kind] ?? event.kind.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase())}`;
}

export function LiveLab(): ReactNode {
  const reducedMotion = useReducedMotion();
  const [status, setStatus] = useState<JsonRecord | null>(null);
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<JsonRecord>({});
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [prompt, setPrompt] = useState("Deploy $2,000 across approved strategies. Keep derivatives under $400. Use only approved issuers and venues.");
  const [confirmation, setConfirmation] = useState("");
  const [pauseText, setPauseText] = useState("");
  const [providerChoice, setProviderChoice] = useState<"openai" | "stub">("stub");
  const [drafting, setDrafting] = useState(false);
  const [revising, setRevising] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [openStage, setOpenStage] = useState(0);
  const stopRef = useRef<(() => void) | null>(null);
  const authorityDialog = useRef<HTMLDialogElement>(null);
  const eventDialog = useRef<HTMLDialogElement>(null);
  const pauseDialog = useRef<HTMLDialogElement>(null);

  const call = useCallback(async (method: "GET" | "POST", path: string, body?: JsonRecord): Promise<boolean> => {
    if (SERVER === null) return false;
    const result = await api(SERVER, method, path, body);
    if (result.ok && typeof result.body.sessionId === "string") setView(result.body);
    if (!result.ok) setMessage(`${str(result.body.error)}: ${str(result.body.message)}`);
    else setMessage("");
    return result.ok;
  }, []);

  const refresh = useCallback(async () => {
    if (SERVER === null || sessionId === null) return;
    const result = await api(SERVER, "GET", `/sessions/${sessionId}`);
    if (result.ok) setView(result.body);
  }, [sessionId]);

  useEffect(() => {
    if (SERVER === null) return;
    void api(SERVER, "GET", "/status").then((result) => {
      if (result.ok) {
        setStatus(result.body);
        if (rec(rec(result.body.providers).openai).available === true) setProviderChoice("openai");
      } else setMessage(`${str(result.body.error)}: ${str(result.body.message)}`);
    });
  }, []);

  useEffect(() => {
    if (SERVER === null || sessionId === null) return undefined;
    const stop = streamEvents(
      SERVER,
      sessionId,
      -1,
      (event) => {
        setEvents((previous) => previous.some((item) => item.sequence === event.sequence) ? previous : [...previous, event].sort((a, b) => a.sequence - b.sequence));
        if (event.kind === "MANDATE_VERSION_AUTHORIZED") setOpenStage(1);
        if (event.kind === "ROOM_OPENED") setOpenStage(2);
        if (event.kind === "MANDATE_REVERIFY_STARTED") setOpenStage(3);
        if (event.kind === "PORTFOLIO_AUTHORIZED" || event.kind === "PORTFOLIO_REFUSED" || event.kind === "ROOM_NO_FEASIBLE_PORTFOLIO") setOpenStage(3);
        if (REFRESH_ON.has(event.kind)) void refresh();
      },
      () => setMessage("The event stream was interrupted. It reconnects automatically."),
    );
    stopRef.current = stop;
    return () => stop();
  }, [refresh, sessionId]);

  const presentation = useMemo(() => derivePresentation(events, arr(rec(view.lastRun).timing).map(rec)), [events, view.lastRun]);
  const waiting = presentation.agents.some((agent) => agent.phase === "PENDING" || agent.phase === "RESPONDING");

  useEffect(() => {
    if (!waiting) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [waiting]);

  const draft = rec(view.draft);
  const validation = rec(view.validation);
  const issues = arr(validation.issues).map(rec);
  const draftIssues = arr(draft.issues).map(rec);
  const guardrails = arr(validation.guardrails).map(rec);
  const versions = arr(view.versions).map(rec);
  const active = view.activeVersion ?? null;
  const busy = view.task !== null && view.task !== undefined;
  const liveAvailable = rec(rec(status?.providers).openai).available === true;
  const expected = str(view.expectedConfirmation);
  const phraseMatches = confirmation === expected && expected !== "—";
  const reviewBlocked = validation.ok !== true || draftIssues.length > 0;
  const provider = rec(view.provider);
  const providerKind = str(provider.kind);
  const model = sessionId === null ? str(rec(rec(status?.providers).openai).model) : str(provider.model);
  const mode = providerKind === "LIVE" ? "LIVE" : sessionId === null && providerChoice === "openai" ? "LIVE" : "DEMO FIXTURE";
  const currentStage = stageFor(active, events, presentation);
  const draftPresent = view.draft !== null && view.draft !== undefined;
  const authoringExpanded = active === null || active === undefined || revising;
  const eventGroups = useMemo(() => groupEventsByElapsed(events), [events]);

  const path = (suffix: string): string => `/sessions/${sessionId ?? ""}${suffix}`;
  const fieldValue = (field: string): string => {
    const [section, first, second] = field.split(".");
    const value: Json | undefined = second === undefined ? rec(draft[section ?? ""])[first ?? ""] : rec(rec(draft[section ?? ""])[first ?? ""])[second];
    return typeof value === "string" ? value : "";
  };
  const agentEnabled = (role: RoleName): boolean | null => {
    const value = rec(rec(draft.agents)[role]).enabled;
    return typeof value === "boolean" ? value : null;
  };
  const enabledCount = ROLES.filter((role) => agentEnabled(role) === true).length;

  async function buildMandate(): Promise<void> {
    if (SERVER === null || prompt.trim() === "") return;
    setDrafting(true);
    let id = sessionId;
    if (id === null) {
      setEvents([]);
      const created = await api(SERVER, "POST", "/sessions", { provider: providerChoice });
      if (!created.ok) {
        setMessage(`${str(created.body.error)}: ${str(created.body.message)}`);
        setDrafting(false);
        return;
      }
      id = str(created.body.sessionId);
      setSessionId(id);
      setView(created.body);
    }
    const result = await api(SERVER, "POST", `/sessions/${id}/draft`, { prompt });
    if (result.ok) {
      setView(result.body);
      setMessage("");
      setRevising(true);
    } else setMessage(`${str(result.body.error)}: ${str(result.body.message)}`);
    setDrafting(false);
  }

  const adjust = (): void => {
    setRevising(true);
    setOpenStage(0);
    void call("POST", path("/draft"), { from: "active" });
  };

  if (SERVER === null) {
    return (
      <main className="live-lab" id="main-content">
        <h1>Live AI Lab</h1>
        <p role="alert">NEXT_PUBLIC_LIVE_AGENTS_URL must be a loopback http URL (127.0.0.1 or localhost). The browser talks only to the local Live AI Lab server.</p>
      </main>
    );
  }

  return (
    <main id="main-content" className={`live-lab${reducedMotion ? " live-lab--reduced" : " live-lab--motion"}`}>
      <header className="live-top">
        <div className="live-brand">
          <span>MANDATE / LIVE AI LAB</span>
          <h1>One authority layer for autonomous markets.</h1>
        </div>
        <nav className="live-nav" aria-label="Live AI Lab">
          <Link href="/demo">Protocol Replay</Link>
          <button type="button" onClick={() => eventDialog.current?.showModal()}>Event log</button>
        </nav>
      </header>

      <div className="live-statusbar" aria-label="Environment">
        <span><small>MODEL</small>{model === "—" ? "Not connected" : model}</span>
        <span><small>MANDATE</small>{active === null || active === undefined ? "NOT ACTIVE" : `V${str(active)} ACTIVE`}</span>
        <span><small>MODE</small>{status === null ? "OFFLINE" : mode}</span>
        <span><small>SETTLEMENT</small>ROBINHOOD TESTNET</span>
      </div>

      <nav className="live-stepper" aria-label="Demo progression">
        {STEPS.map((step, index) => (
          <button
            key={step}
            type="button"
            className="live-step"
            data-state={index === openStage ? "active" : index < currentStage ? "complete" : "upcoming"}
            aria-current={index === openStage ? "step" : undefined}
            disabled={index > currentStage}
            onClick={() => setOpenStage(index)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            {step}
          </button>
        ))}
      </nav>

      {message !== "" && <p className="live-alert" role="alert">{message}</p>}

      <StageShell
        number="01"
        title={active !== null && active !== undefined && !revising ? `Mandate V${str(active)}` : "Give your agents authority"}
        state={active !== null && active !== undefined && !revising ? "ACTIVE" : drafting ? "BUILDING" : draftPresent ? "DRAFT" : "CURRENT"}
        expanded={openStage === 0}
        onOpen={() => setOpenStage(0)}
      >
        {!authoringExpanded ? (
          <ActiveMandateSummary
            version={str(active)}
            capital={fieldValue("portfolio.totalCapital")}
            derivatives={fieldValue("portfolio.maxDerivative")}
            agents={enabledCount}
            paused={view.paused === true || presentation.paused}
            onAuthority={() => authorityDialog.current?.showModal()}
            onAdjust={adjust}
          />
        ) : drafting ? (
          <div className="live-centered" aria-live="polite">
            <LatticeLoader label="Building Mandate V1" status="working" pattern="ripple" showTimer={false} />
            <p>Converting principal intent into explicit authority.</p>
          </div>
        ) : (
          <Authoring
            connected={status !== null}
            prompt={prompt}
            setPrompt={setPrompt}
            providerChoice={providerChoice}
            setProviderChoice={setProviderChoice}
            liveAvailable={liveAvailable}
            draftPresent={draftPresent}
            reviewBlocked={reviewBlocked}
            expected={expected}
            confirmation={confirmation}
            setConfirmation={setConfirmation}
            phraseMatches={phraseMatches}
            issues={issues}
            draftIssues={draftIssues}
            active={active}
            agentEnabled={agentEnabled}
            capital={fieldValue("portfolio.totalCapital")}
            derivatives={fieldValue("portfolio.maxDerivative")}
            enabledCount={enabledCount}
            busy={busy}
            onBuild={() => void buildMandate()}
            onChip={(chip) => setPrompt((current) => appendChip(current, chip))}
            onAuthority={() => authorityDialog.current?.showModal()}
            onFill={() => {
              setRevising(true);
              void call("POST", path("/draft/fill"), { preset: "balanced" });
            }}
            onResolve={(index) => void call("POST", path("/draft/resolve"), { index })}
            onAuthorize={() => void call("POST", path("/authorize"), { confirmation }).then((ok) => {
              if (ok) {
                setConfirmation("");
                setRevising(false);
              }
            })}
            onToggle={(role, enabled) => void call("POST", path("/draft/field"), { path: `agents.${role}.enabled`, value: enabled })}
          />
        )}
      </StageShell>

      {active !== null && active !== undefined && (
        <StageShell number="02" title="Agents are working" state={currentStage === 1 ? "CURRENT" : currentStage > 1 ? "COMPLETE" : "READY"} expanded={openStage === 1} onOpen={() => setOpenStage(1)}>
          <Control
            presentation={presentation}
            now={now}
            busy={busy}
            paused={view.paused === true || presentation.paused}
            task={str(view.task)}
            providerKind={providerKind}
            agentEnabled={agentEnabled}
            onRun={() => void call("POST", path("/run"), {})}
            onPause={() => pauseDialog.current?.showModal()}
            onAdjust={adjust}
          />
        </StageShell>
      )}

      {currentStage >= 2 && (
        <StageShell number="03" title={presentation.room.noFeasible ? "No feasible portfolio" : "Portfolio conflict"} state={currentStage === 2 ? "CURRENT" : presentation.room.authorized ? "RESOLVED" : presentation.room.noFeasible ? "CLOSED" : "COMPLETE"} expanded={openStage === 2} onOpen={() => setOpenStage(2)}>
          <RoomPanel presentation={presentation} onRun={() => void call("POST", path("/run"), {})} onAdjust={adjust} />
        </StageShell>
      )}

      {currentStage >= 3 && (
        <StageShell number="04" title="Mandate verification" state={presentation.room.authorized ? "AUTHORIZED" : presentation.room.refused ? "REFUSED" : "CURRENT"} expanded={openStage === 3} onOpen={() => setOpenStage(3)}>
          <VerificationPanel presentation={presentation} busy={busy} active={active} onStress={() => void call("POST", path("/policy-stress"), {})} />
        </StageShell>
      )}

      {currentStage >= 4 && (
        <StageShell number="05" title="Settlement" state={presentation.settlement.settled ? "SETTLED" : presentation.settlement.stage === "FAILED" ? "FAILED" : "AVAILABLE"} expanded={openStage === 4} onOpen={() => setOpenStage(4)}>
          <SettlementPanel presentation={presentation} stock={presentation.agents.find((agent) => agent.role === "stock")} />
        </StageShell>
      )}

      <p className="live-thesis">Agents propose. <span>Agents negotiate.</span> Mandate authorizes. Markets settle.</p>

      <dialog ref={authorityDialog} className="live-dialog live-authority" aria-labelledby="authority-title">
        <div className="live-dialog__head">
          <div><p className="live-kicker">Mandate authority</p><h2 id="authority-title">Full authority</h2></div>
          <button className="live-icon-button" type="button" aria-label="Close authority" onClick={() => authorityDialog.current?.close()}>×</button>
        </div>
        <AuthorityDetails
          guardrails={guardrails}
          draftPresent={draftPresent}
          fieldValue={fieldValue}
          agentEnabled={agentEnabled}
          busy={busy}
          onField={(field, value) => {
            setRevising(true);
            void call("POST", path("/draft/field"), { path: field, value });
          }}
          onPreset={(preset) => {
            setRevising(true);
            void call("POST", path("/draft"), { preset });
          }}
          onFill={() => {
            setRevising(true);
            void call("POST", path("/draft/fill"), { preset: "balanced" });
          }}
        />
        {versions.length > 0 && <p className="live-small">Signed versions are immutable. Adjusting creates a new draft version.</p>}
      </dialog>

      <dialog ref={eventDialog} className="live-dialog live-event-dialog" aria-labelledby="event-log-title">
        <div className="live-dialog__head">
          <div><p className="live-kicker">Technical evidence</p><h2 id="event-log-title">Event log</h2></div>
          <button className="live-icon-button" type="button" aria-label="Close event log" onClick={() => eventDialog.current?.close()}>×</button>
        </div>
        <p className="live-small">MANDATE_LIVE_AI.V1 · {events.length} events. Sequence is authoritative. Equal real timestamps stay equal and are grouped.</p>
        <ol className="live-event-groups">
          {eventGroups.map((group) => (
            <li key={`${group.elapsedMs}:${group.events[0]?.sequence}`}>
              <time dateTime={group.at}>{formatDuration(group.elapsedMs)}</time>
              <ol>{group.events.map((event) => <li key={event.sequence}><span>Step {event.sequence + 1}</span>{eventSummary(event)}<details><summary>Raw event</summary><code>{event.kind}</code></details></li>)}</ol>
            </li>
          ))}
        </ol>
      </dialog>

      <dialog ref={pauseDialog} className="live-dialog live-confirm" aria-labelledby="pause-title">
        <div className="live-dialog__head"><h2 id="pause-title">Pause mandate</h2><button className="live-icon-button" type="button" aria-label="Close pause dialog" onClick={() => pauseDialog.current?.close()}>×</button></div>
        <p>Pausing revokes the active root. Existing reservations stay recorded.</p>
        <label>Type <code>{str(status?.pauseConfirmation)}</code><input value={pauseText} onChange={(event) => setPauseText(event.target.value)} autoComplete="off" /></label>
        <button className="button button--danger" type="button" disabled={pauseText !== str(status?.pauseConfirmation)} onClick={() => void call("POST", path("/pause"), { confirmation: pauseText }).then((ok) => {
          if (ok) {
            setPauseText("");
            pauseDialog.current?.close();
          }
        })}>Pause mandate</button>
      </dialog>
    </main>
  );
}

function StageShell({ number, title, state, expanded, onOpen, children }: { readonly number: string; readonly title: string; readonly state: string; readonly expanded: boolean; readonly onOpen: () => void; readonly children: ReactNode }): ReactNode {
  return (
    <section className="live-stage" data-expanded={expanded ? "" : undefined}>
      <button className="live-stage__summary" type="button" aria-expanded={expanded} onClick={onOpen}>
        <span className="live-stage__number">{number}</span><span className="live-stage__title">{title}</span><Badge value={state} /><span className="live-stage__chevron" aria-hidden="true">⌄</span>
      </button>
      {expanded && <div className="live-stage__body">{children}</div>}
    </section>
  );
}

function ActiveMandateSummary({ version, capital, derivatives, agents, paused, onAuthority, onAdjust }: { readonly version: string; readonly capital: string; readonly derivatives: string; readonly agents: number; readonly paused: boolean; readonly onAuthority: () => void; readonly onAdjust: () => void }): ReactNode {
  return (
    <div className="live-active-summary">
      <div className="live-active-summary__title"><div><p className="live-kicker">Principal authority</p><h2>Mandate V{version}</h2></div><Badge value={paused ? "PAUSED" : "ACTIVE"} /></div>
      <dl className="live-summary-grid"><div><dt>Capital</dt><dd>{money(capital)}</dd></div><div><dt>Derivatives</dt><dd>≤ {money(derivatives)}</dd></div><div><dt>Agents</dt><dd>{agents}</dd></div></dl>
      <div className="live-actions"><button className="button" type="button" onClick={onAuthority}>View authority</button><button className="button button--quiet" type="button" onClick={onAdjust}>Adjust</button></div>
    </div>
  );
}

function Authoring(props: {
  readonly connected: boolean; readonly prompt: string; readonly setPrompt: (value: string) => void; readonly providerChoice: "openai" | "stub"; readonly setProviderChoice: (value: "openai" | "stub") => void; readonly liveAvailable: boolean; readonly draftPresent: boolean; readonly reviewBlocked: boolean; readonly expected: string; readonly confirmation: string; readonly setConfirmation: (value: string) => void; readonly phraseMatches: boolean; readonly issues: readonly JsonRecord[]; readonly draftIssues: readonly JsonRecord[]; readonly active: Json; readonly agentEnabled: (role: RoleName) => boolean | null; readonly capital: string; readonly derivatives: string; readonly enabledCount: number; readonly busy: boolean; readonly onBuild: () => void; readonly onChip: (chip: string) => void; readonly onAuthority: () => void; readonly onFill: () => void; readonly onResolve: (index: number) => void; readonly onAuthorize: () => void; readonly onToggle: (role: RoleName, enabled: boolean) => void;
}): ReactNode {
  return (
    <div className="live-authoring">
      <div className="live-section-heading"><p className="live-kicker">Principal</p><h2>Give your agents authority</h2><p>Describe what they may do. Mandate turns that intent into enforceable limits.</p></div>
      {!props.draftPresent && <div className="live-provider-choice"><span>Run with</span><button type="button" data-active={props.providerChoice === "stub" ? "" : undefined} onClick={() => props.setProviderChoice("stub")}>Demo fixture</button><button type="button" data-active={props.providerChoice === "openai" ? "" : undefined} disabled={!props.liveAvailable} onClick={() => props.setProviderChoice("openai")}>Live model</button></div>}
      {!props.draftPresent && <><PromptBar value={props.prompt} onChange={props.setPrompt} onSend={props.onBuild} busy={props.busy} disabled={!props.connected} />
      <div className="live-chips" aria-label="Prompt suggestions">{CHIPS.map((chip) => <button key={chip} type="button" onClick={() => props.onChip(chip)}>+ {chip}</button>)}</div></>}
      {props.draftPresent && <>
        <div className="live-draft-head"><div><p className="live-kicker">Mandate {props.expected === "—" ? "" : props.expected.replace("AUTHORIZE MANDATE ", "")}</p><h3>DRAFT</h3></div><Badge value="NOT AUTHORIZED" /></div>
        <dl className="live-draft-summary"><div><dt>Capital</dt><dd>{money(props.capital)}</dd></div><div><dt>Derivatives</dt><dd>≤ {money(props.derivatives)}</dd></div><div><dt>Agents</dt><dd>{props.enabledCount} enabled</dd></div><div><dt>Execution</dt><dd>Approved venues only</dd></div></dl>
        <div className="live-agent-toggles" aria-label="Agent authority">{ROLES.map((role) => { const enabled = props.agentEnabled(role); return <button key={role} type="button" aria-pressed={enabled === true} disabled={props.busy} onClick={() => props.onToggle(role, enabled !== true)}><span>{ROLE_TITLES[role]}</span><strong>{enabled === false ? "NO AUTHORITY" : enabled === true ? "ENABLED" : "UNSET"}</strong></button>; })}</div>
        <p className="live-small">Disabled means no authority: no mandate entry and no delegation.</p>
        <button className="button button--quiet" type="button" onClick={props.onAuthority}>View full authority</button>
        {props.reviewBlocked && <div className="live-alert live-review" role="status"><div><strong>Authority needs review.</strong><p>{props.draftIssues.length + props.issues.length} explicit choices remain. Authorization stays closed until each is resolved.</p></div>{props.draftIssues.length > 0 && <ul>{props.draftIssues.map((issue, index) => <li key={`${index}:${str(issue.text)}`}><Badge value={str(issue.kind)} /> {str(issue.text)} <button className="button button--quiet" type="button" onClick={() => props.onResolve(index)}>Mark resolved</button></li>)}</ul>}<div className="live-actions"><button className="button button--primary" type="button" disabled={props.busy} onClick={props.onFill}>Complete with balanced demo settings</button><button className="button button--quiet" type="button" onClick={props.onAuthority}>Review every field</button></div></div>}
        {!props.reviewBlocked && <div className="live-activate"><div><p className="live-kicker">Ready to activate</p><h3>{props.expected.replace("AUTHORIZE ", "")}</h3><p>Type the exact phrase. A generic confirmation cannot activate authority.</p></div><label>Type <code>{props.expected}</code><input value={props.confirmation} onChange={(event) => props.setConfirmation(event.target.value)} aria-label="Authorization confirmation" autoComplete="off" /></label><button className="button button--primary" type="button" disabled={!props.phraseMatches} onClick={props.onAuthorize}>Activate mandate</button></div>}
        {props.active !== null && props.active !== undefined && <p className="live-small">Active V{str(props.active)} remains unchanged until this new draft is authorized. Signed versions are not edited in place.</p>}
      </>}
    </div>
  );
}

function AuthorityDetails(props: { readonly guardrails: readonly JsonRecord[]; readonly draftPresent: boolean; readonly fieldValue: (field: string) => string; readonly agentEnabled: (role: RoleName) => boolean | null; readonly busy: boolean; readonly onField: (field: string, value: string | null) => void; readonly onPreset: (preset: string) => void; readonly onFill: () => void }): ReactNode {
  const groups = ["PORTFOLIO", "AGENT", "MARKET", "EXECUTION"];
  return <><div className="live-authority-groups">{groups.map((group) => <section key={group}><h3>{group === "AGENT" ? "Agents" : group === "MARKET" ? "Markets" : group[0] + group.slice(1).toLowerCase()}</h3><dl>{props.guardrails.filter((row) => str(row.level) === group).map((row, index) => <div key={`${group}:${index}`}><dt>{str(row.guardrail)} <Badge value={str(row.status)} /></dt><dd>{str(row.enforced)}</dd></div>)}</dl></section>)}</div>{props.draftPresent && <details className="live-advanced"><summary>Advanced authority editing</summary><p className="live-small">Editing creates or changes the draft. It never mutates an active signed mandate.</p><div className="live-presets"><button className="button" type="button" onClick={props.onFill}>Fill unset from balanced</button>{["conservative", "balanced", "aggressive"].map((preset) => <button className="button button--quiet" type="button" key={preset} onClick={() => props.onPreset(preset)}>{preset}</button>)}</div><div className="live-fields">{TEXT_FIELDS.map((field) => <label key={`${field.path}:${props.fieldValue(field.path)}`}><span>{field.group}</span>{field.label}<input defaultValue={props.fieldValue(field.path)} placeholder="unset" disabled={props.busy} onBlur={(event) => { if (event.target.value !== props.fieldValue(field.path)) props.onField(field.path, event.target.value === "" ? null : event.target.value); }} /></label>)}{ROLES.map((role) => <label key={`${role}:${props.fieldValue(`agents.${role}.maxAllocation`)}`}><span>Agent limits</span>{ROLE_TITLES[role]} maximum<input defaultValue={props.fieldValue(`agents.${role}.maxAllocation`)} placeholder={props.agentEnabled(role) === false ? "no authority" : "unset"} disabled={props.busy} onBlur={(event) => { if (event.target.value !== props.fieldValue(`agents.${role}.maxAllocation`)) props.onField(`agents.${role}.maxAllocation`, event.target.value === "" ? null : event.target.value); }} /></label>)}</div></details>}</>;
}

function Control(props: { readonly presentation: ReturnType<typeof derivePresentation>; readonly now: number; readonly busy: boolean; readonly paused: boolean; readonly task: string; readonly providerKind: string; readonly agentEnabled: (role: RoleName) => boolean | null; readonly onRun: () => void; readonly onPause: () => void; readonly onAdjust: () => void }): ReactNode {
  return <div><div className="live-section-heading live-section-heading--action"><div><p className="live-kicker">Independent operators</p><h2>Agents are working</h2><p>Five specialized agents operate independently. Their decisions still require Mandate authorization.</p></div><button className="button button--primary" type="button" disabled={props.busy || props.paused} onClick={props.onRun}>{props.busy && props.task === "RUN" ? "Agents working…" : "Run agents"}</button></div><div className="live-secondary-actions"><button className="button button--quiet" type="button" onClick={props.onAdjust}>Adjust mandate</button><button className="button button--quiet" type="button" onClick={props.onPause}>Pause mandate</button>{props.paused && <Badge value="PAUSED" />}</div><div className="live-agents" aria-live="polite">{props.presentation.agents.map((agent) => <AgentCardView key={agent.role} agent={agent} now={props.now} providerKind={props.providerKind} settled={props.presentation.settlement.settled && agent.role === "stock"} enabled={props.agentEnabled(agent.role)} />)}</div></div>;
}

function AgentCardView({ agent, now, providerKind, settled, enabled }: { readonly agent: AgentCard; readonly now: number; readonly providerKind: string; readonly settled: boolean; readonly enabled: boolean | null }): ReactNode {
  const working = agent.phase === "PENDING" || agent.phase === "RESPONDING";
  const failed = agent.phase === "FAILED" || agent.phase === "INVALID RESPONSE" || agent.phase === "TIMED OUT";
  const idle = agent.phase === "WAITING" && agent.candidate === "—" && agent.rationale === "";
  const tone = agent.hardBlock ? "blocked" : agent.portfolioConflict ? "conflict" : agent.mandateLabel === "ADMISSIBLE" || agent.finalOutcome === "RESERVED" ? "ok" : "plain";
  const modelEvidence = providerKind === "LIVE" ? "LIVE MODEL" : "DEMO FIXTURE";
  const marketEvidence = agent.role === "perps" ? "OFFCHAIN_ONLY" : settled && agent.role === "stock" ? "LIVE_TESTNET" : "FIXTURE";
  if (enabled === false) return <article className="live-agent live-agent--disabled"><div className="live-agent__head"><h3>{agent.title}</h3><Badge value="NO AUTHORITY" /></div><p>No mandate entry. No delegation. This agent cannot propose.</p></article>;
  return <article className={`live-agent live-agent--${tone}`}><div className="live-agent__head"><h3>{agent.title}</h3><Badge value={working ? "LIVE" : agent.finalOutcome === "RESERVED" ? "AUTHORIZED" : agent.phase} /></div>{idle && <><p className="live-agent__empty">No proposal yet.</p><p className="live-evidence"><Badge value={modelEvidence} /><Badge value={marketEvidence} /></p></>}{working && <div className="live-agent__thinking"><LatticeLoader label={agent.activity} status="working" pattern={PATTERNS[agent.role]} elapsedMs={elapsedSince(agent.startedAt, now)} /></div>}{!idle && !working && <><LatticeLoader label={failed ? "Agent run failed" : "Decision complete"} status={failed ? "error" : "done"} pattern={PATTERNS[agent.role]} elapsedMs={agent.providerMs} />{agent.candidate !== "—" && <div className="live-agent__decision"><p className="live-kicker">Model decision</p><h4>{agent.candidate}</h4><strong>{agent.requested}</strong>{agent.rationale !== "" && <p className="live-rationale">{agent.rationale}</p>}</div>}<div className="live-agent__mandate"><p className="live-kicker">Mandate check</p><Badge value={agent.hardBlock ? "BLOCKED" : agent.mandateLabel} />{agent.hardBlock && <p>{reasonLabel(agent.reasons[0] ?? "BLOCKED")}</p>}{agent.portfolioConflict && <p>Locally admissible. Portfolio authority is exceeded. Enters Mandate Room.</p>}{agent.finalOutcome === "RESERVED" && <p><strong>{agent.finalAmount || agent.requested} reserved</strong><br /><span>Reserved is not settled.</span></p>}{agent.phase === "ABSTAINED" && <p>No proposal. Nothing entered authorization.</p>}{agent.timedOut && <p>Timed out. No allocation change recorded. Timeout is not consent or release.</p>}{agent.reasons.length > 0 && <details><summary>Why?</summary><dl><dt>Reason</dt><dd>{agent.reasons.map((reason) => <code key={reason}>{code(reason)}</code>)}</dd><dt>Human meaning</dt><dd>{agent.reasons.map(reasonLabel).join(" · ")}</dd></dl></details>}</div><p className="live-evidence"><Badge value={modelEvidence} /><Badge value={marketEvidence} /></p></>}</article>;
}

function RoomPanel({ presentation, onRun, onAdjust }: { readonly presentation: ReturnType<typeof derivePresentation>; readonly onRun: () => void; readonly onAdjust: () => void }): ReactNode {
  const room = presentation.room;
  const conflict = room.lines.find((line) => line.status === "CONFLICT" || line.status === "UNRESOLVED") ?? room.lines[0];
  return <div className="live-room">{conflict !== undefined && <section className="live-conflict-card"><div><p className="live-kicker">{resourceLabel(conflict.resource)}</p><h2>{conflict.status === "SATISFIED" ? "Conflict resolved" : "Needs negotiation"}</h2></div><dl><div><dt>Requested</dt><dd>{money(conflict.demand)}</dd></div><div><dt>Allowed</dt><dd>{money(conflict.authority)}</dd></div><div><dt>{conflict.demandAfter === null ? "Need to reduce" : "After"}</dt><dd>{conflict.demandAfter === null ? money(conflict.reduction) : money(conflict.demandAfter)}</dd></div></dl><Badge value={conflict.status === "SATISFIED" ? "SATISFIED" : "PORTFOLIO CONFLICT"} /></section>}<div className="live-room__heading"><div><p className="live-kicker">Autonomous negotiation</p><h2>Mandate Room</h2><p>Agents may adjust requests. The Room cannot create authority.</p></div><div className="live-zero"><span>ROOM AUTHORITY</span><strong>NONE</strong></div></div><div className="live-room-feed" aria-live="polite">{room.activity.map((item) => <article key={item.sequence} data-state={item.state}><div className="live-avatar">{item.agent === null ? "M" : (item.agent[0] ?? "A").toUpperCase()}</div><div><p><strong>{item.agent === null ? "Mandate" : `${ROLE_TITLES[item.agent as RoleName] ?? item.agent} Agent`}</strong>{item.generation === null ? "" : ` · Round ${item.generation}`}</p><h3>{item.action}{item.from === "—" ? "" : ` ${item.from}${item.to === "—" || item.to === item.from ? "" : ` → ${item.to}`}`}</h3>{item.rationale !== "" && <p>{item.rationale}</p>}</div></article>)}</div><div className="live-resource-stack">{room.lines.map((line) => <article key={line.resource}><div><span>{resourceLabel(line.resource)}</span><code>{line.resource}</code></div><p><strong>Before</strong> {money(line.demand)} / {money(line.authority)}</p>{line.demandAfter !== null && <p><strong>After</strong> {money(line.demandAfter)} / {money(line.authority)}</p>}<Badge value={line.status} /></article>)}</div><p className="live-small">Each typed resource is a separate authority limit. Incomparable reductions are not added together.</p>{room.proposal && !room.authorized && !room.refused && <div className="live-proposal"><Badge value="ROOM PROPOSAL READY" /><h3>Not yet authorized.</h3><p>Room consensus must pass independent Mandate re-verification.</p></div>}{room.noFeasible && <div className="live-terminal"><Badge value="NO FEASIBLE PORTFOLIO" /><h3>Nothing was authorized.</h3><p>{conflict === undefined ? "The requests remain outside authority." : `${resourceLabel(conflict.resource)} remains ${money(conflict.reduction)} above authority.`}</p><div className="live-actions"><button className="button" type="button" onClick={onRun}>Run again</button><button className="button button--quiet" type="button" onClick={onAdjust}>Adjust mandate</button></div></div>}</div>;
}

function VerificationPanel(props: { readonly presentation: ReturnType<typeof derivePresentation>; readonly busy: boolean; readonly active: Json; readonly onStress: () => void }): ReactNode {
  const room = props.presentation.room;
  const stress = props.presentation.stress;
  const identity = stress.attempts.find((attempt) => Object.keys(attempt.identity).length > 0)?.identity ?? {};
  const reserved = props.presentation.agents.filter((agent) => agent.finalOutcome === "RESERVED");
  return <div className="live-verify">{room.reverify && !room.authorized && !room.refused && <div className="live-centered"><LatticeLoader label="Mandate re-verifying" status="working" pattern="sweep" showTimer={false} /><p>Checking the negotiated portfolio against the principal&apos;s authority.</p></div>}{room.authorized && <section className="live-authorized"><Badge value="PORTFOLIO AUTHORIZED" /><h2>Authorized portfolio</h2><div>{reserved.map((agent) => <p key={agent.role}><span>{agent.title}</span><strong>{agent.finalAmount || agent.requested}</strong></p>)}</div>{room.reserved !== null && <p className="live-authorized__total"><span>Total reserved</span><strong>{room.reserved}</strong></p>}<p>Reserved is not settled.</p></section>}{room.refused && <section className="live-terminal"><Badge value="REFUSED" /><h2>Mandate refused the Room proposal.</h2><p>Nothing was authorized by consensus alone.</p></section>}<section className="live-stress" aria-labelledby="stress-title"><div className="live-section-heading live-section-heading--action"><div><p className="live-kicker">Security proof</p><h2 id="stress-title">Valid agent ≠ valid action</h2><p>The same authorized agent can make compliant and non-compliant requests. Mandate evaluates the action, not the agent&apos;s reputation.</p></div><button className="button button--primary" type="button" disabled={props.busy || props.active === null || props.active === undefined} onClick={props.onStress}>{props.busy ? "Evaluating…" : "Run policy stress"}</button></div>{stress.started && <><article className="live-identity"><div><p className="live-kicker">Swap agent</p><h3>Same identity throughout</h3></div><dl><div><dt>Identity</dt><dd><Badge value={str(identity.agentIdentity ?? "VALID")} /></dd></div><div><dt>Membership</dt><dd><Badge value={str(identity.membership ?? "VALID")} /></dd></div><div><dt>Delegation</dt><dd><Badge value={str(identity.delegation ?? "ACTIVE")} /></dd></div><div><dt>Signature</dt><dd><Badge value={str(identity.signature ?? "VALID")} /></dd></div></dl></article><div className="live-attempts" aria-live="polite">{stress.attempts.map((attempt, index) => <article key={attempt.attempt} data-outcome={attempt.outcome}><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{attempt.caseId.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase())}</h3><p>{attempt.reasons.length > 0 ? reasonLabel(attempt.reasons[0] ?? "REFUSED") : attempt.outcome === "AUTHORIZED" ? "Compliant control" : "Evaluating action"}</p>{attempt.rationale !== "" && <details><summary>View declared rationale</summary><p>{attempt.rationale}</p></details>}</div><div><Badge value={attempt.outcome} />{attempt.reasons.length > 0 && <details><summary>Reason code</summary>{attempt.reasons.map((reason) => <code key={reason}>{code(reason)}</code>)}</details>}</div></article>)}</div><p className="live-stress__thesis"><span>SAME AGENT</span><span>DIFFERENT ACTION</span><strong>DIFFERENT AUTHORIZATION RESULT</strong></p></>}</section></div>;
}

function SettlementPanel({ presentation, stock }: { readonly presentation: ReturnType<typeof derivePresentation>; readonly stock: AgentCard | undefined }): ReactNode {
  const settlement = presentation.settlement;
  const title = settlement.stage === "SETTLED" ? "Settled" : settlement.stage === "FAILED" ? "Settlement failed" : settlement.stage === "SUBMITTED" ? "Submitted — not settled" : settlement.stage === "SIMULATION" ? "Simulation" : settlement.stage === "SEND_REQUIRED" ? "Awaiting send authorization" : settlement.present ? "Preflight" : "No testnet settlement in this session";
  return <div className="live-execution"><div className="live-section-heading"><p className="live-kicker">Controlled execution</p><h2>{title}</h2><p>Authorized actions may proceed to their configured execution domain. This page does not send a transaction.</p></div>{!settlement.present ? <div className="live-no-settlement"><p><span>Stock</span><Badge value={stock?.finalOutcome || "NOT RESERVED"} /></p><p><span>Settlement</span><Badge value="NOT STARTED" /></p></div> : <><section className="live-execution-card"><div><p className="live-kicker">Robinhood Chain Testnet</p><h3>{settlement.stage.replaceAll("_", " ")}</h3></div>{settlement.stage === "SIMULATION" && <LatticeLoader label="Running eth_call" status="working" pattern="ripple" showTimer={false} />}<dl><div><dt>Network</dt><dd>{settlement.network || "Robinhood Chain Testnet"}</dd></div><div><dt>Chain ID</dt><dd>{settlement.chainId || "46630"}</dd></div><div><dt>Gate</dt><dd className="live-hash">{settlement.gate || "—"}</dd></div><div><dt>Evidence</dt><dd><Badge value={settlement.settled ? "LIVE_TESTNET" : settlement.evidence ?? "NOT SETTLED"} /></dd></div></dl>{settlement.txHash !== null && <div className="live-tx"><span>Transaction</span><code title={settlement.txHash}>{settlement.txHash}</code><button className="button button--quiet" type="button" onClick={() => void navigator.clipboard.writeText(settlement.txHash ?? "")}>Copy</button></div>}{settlement.explorerUrl !== null && <a className="button" href={settlement.explorerUrl} target="_blank" rel="noreferrer noopener">View on explorer ↗</a>}</section>{settlement.settled && <section className="live-postconditions"><Badge value="ON-CHAIN COMMITMENT VERIFIED" /><p><span>Block</span><strong>{settlement.block}</strong></p><p><span>Gas used</span><strong>{settlement.gasUsed}</strong></p></section>}</>}<div className="live-execution-seam"><article><p className="live-kicker">Agent decision</p><h3>NVIDIA-backed decision</h3><p>Authorized allocation: {stock?.finalAmount || stock?.requested || "—"}</p><Badge value={stock?.finalOutcome || "NOT RESERVED"} /></article><span aria-hidden="true">≠</span><article><p className="live-kicker">Settlement proof</p><h3>Testnet fixture</h3><p>{settlement.fixtureIn === null ? "No fixture amounts" : `${settlement.fixtureIn} → ${settlement.fixtureOut ?? "—"}`}</p><Badge value={settlement.settled ? "LIVE_TESTNET" : "FIXTURE"} /></article></div><p className="live-qualify">Valueless demo assets. Not an NVDA trade. Not a Robinhood Stock Token.</p>{settlement.stage === "SUBMITTED" && <p className="live-alert">A transaction hash is not settlement. LIVE_TESTNET requires a confirmed receipt and verified postconditions.</p>}{settlement.stage === "FAILED" && <p className="live-alert live-alert--bad">Failed receipt. Never presented as LIVE_TESTNET.</p>}<p className="live-small">Swap, NFT and Yield remain fixture market domains. Perps is OFFCHAIN_ONLY. No browser transaction sending exists.</p></div>;
}
