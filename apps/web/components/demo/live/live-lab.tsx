"use client";

import { useReducedMotion } from "@/lib/motion";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, arr, code, conflicts, liveServerUrl, rec, str, streamEvents, type Json, type JsonRecord, type LiveEvent } from "./live-client";
import { ACTIVITY, derivePresentation, formatDuration, ROLE_TITLES, ROLES, type AgentCard, type RoleName } from "./live-model";
import "./live-lab.css";

const SERVER = liveServerUrl(process.env.NEXT_PUBLIC_LIVE_AGENTS_URL);
const REFRESH_ON = new Set(["MANDATE_VERSION_AUTHORIZED", "MANDATE_PAUSED", "PORTFOLIO_AUTHORIZED", "PORTFOLIO_REFUSED", "ROOM_FINALIZED", "POLICY_STRESS_COMPLETED", "MANDATE_AMENDMENT_REFUSED", "MANDATE_AMENDMENT_AUTHORIZED"]);
const CHIPS = [
  "Deploy $2,000 across approved markets",
  "Keep at least $300 unallocated",
  "Prefer stocks and yield",
  "Limit derivatives to $400",
  "Use only approved venues",
];
const TEXT_FIELDS: readonly { path: string; label: string; group: string }[] = [
  { path: "portfolio.totalCapital", label: "Total capital", group: "PORTFOLIO" },
  { path: "portfolio.maxDeployed", label: "Maximum deployed", group: "PORTFOLIO" },
  { path: "portfolio.maxDerivative", label: "Derivative exposure", group: "PORTFOLIO" },
  { path: "portfolio.maxIlliquid", label: "Illiquid exposure", group: "PORTFOLIO" },
  { path: "portfolio.minUnallocated", label: "Minimum unallocated", group: "PORTFOLIO" },
  { path: "portfolio.validityMinutes", label: "Validity (minutes)", group: "PORTFOLIO" },
  { path: "market.maxLeverage", label: "Leverage", group: "MARKETS" },
  { path: "market.maxSlippageBps", label: "Slippage (bps)", group: "MARKETS" },
  { path: "market.maxQuoteAgeSeconds", label: "Quote freshness (s)", group: "MARKETS" },
];
const GROUPS = ["PORTFOLIO", "AGENT", "MARKET", "EXECUTION"] as const;

function Badge({ value }: { value: string }): ReactNode {
  const tone = /BLOCKED|REFUSED|FAILED|INVALID|NO AUTHORITY|CONFLICT|IGNORED/.test(value)
    ? "bad"
    : /AUTHORIZED|RESERVED|ADMISSIBLE|VALID|ACTIVE|SATISFIED|SETTLED|LIVE_TESTNET|SUCCESS/.test(value)
      ? "good"
      : /STALE|TIMED|PENDING|RESPONDING|WARNING|SEND|DRAFT|PAUSED/.test(value)
        ? "warn"
        : "plain";
  return <span className={`live-badge live-badge--${tone}`}>{value}</span>;
}

function elapsedSince(at: string | null, now: number): string {
  if (at === null) return "—";
  const start = Date.parse(at);
  if (Number.isNaN(start)) return "—";
  return formatDuration(Math.max(0, now - start));
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
  const stopRef = useRef<(() => void) | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const call = useCallback(
    async (method: "GET" | "POST", path: string, body?: JsonRecord): Promise<boolean> => {
      if (SERVER === null) return false;
      const result = await api(SERVER, method, path, body);
      if (sessionId !== null && path.startsWith(`/sessions/${sessionId}`) && typeof result.body.sessionId === "string") setView(result.body);
      if (!result.ok) setMessage(`${str(result.body.error)}: ${str(result.body.message)}`);
      else setMessage("");
      return result.ok;
    },
    [sessionId],
  );

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
        setEvents((prev) => (prev.some((item) => item.sequence === event.sequence) ? prev : [...prev, event].sort((a, b) => a.sequence - b.sequence)));
        if (REFRESH_ON.has(event.kind)) void refresh();
      },
      () => setMessage("The event stream was interrupted. It reconnects automatically."),
    );
    stopRef.current = stop;
    return stop;
  }, [sessionId, refresh]);

  const timing = useMemo(() => arr(rec(view.lastRun).agents).map(rec), [view.lastRun]);
  const presentation = useMemo(() => derivePresentation(events, timing), [events, timing]);
  const waiting = presentation.agents.some((agent) => agent.phase === "PENDING" || agent.phase === "RESPONDING");

  useEffect(() => {
    if (view.task === null || view.task === undefined) return undefined;
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [view.task, refresh]);

  useEffect(() => {
    if (!waiting) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  async function newSession(): Promise<void> {
    if (SERVER === null) return;
    stopRef.current?.();
    setEvents([]);
    const result = await api(SERVER, "POST", "/sessions", { provider: providerChoice });
    if (!result.ok) {
      setMessage(`${str(result.body.error)}: ${str(result.body.message)}`);
      return;
    }
    setMessage("");
    setRevising(false);
    setView(result.body);
    setSessionId(str(result.body.sessionId));
  }

  async function draftFromPrompt(): Promise<void> {
    setDrafting(true);
    await call("POST", `/sessions/${sessionId ?? ""}/draft`, { prompt });
    setDrafting(false);
  }

  const path = (suffix: string) => `/sessions/${sessionId ?? ""}${suffix}`;
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
  const model = sessionId === null ? str(rec(rec(status?.providers).openai).model) : str(provider.model);
  const mode = str(provider.kind) === "LIVE" ? "LIVE" : providerChoice === "openai" ? "LIVE" : "STUB";
  const roomEvents = events.filter((event) => event.kind.startsWith("ROOM_") || event.kind === "PORTFOLIO_CONFLICT" || event.kind === "MANDATE_REVERIFY_STARTED");
  const fieldValue = (field: string): string => {
    const [section, a, b] = field.split(".");
    const value: Json | undefined = b === undefined ? rec(draft[section ?? ""])[a ?? ""] : rec(rec(draft[section ?? ""])[a ?? ""])[b];
    return typeof value === "string" ? value : "";
  };
  const agentEnabled = (role: RoleName): boolean | null => {
    const value = rec(rec(draft.agents)[role]).enabled;
    return typeof value === "boolean" ? value : null;
  };

  if (SERVER === null) {
    return (
      <main className="live-lab page-container" id="main-content">
        <h1>Live AI Lab</h1>
        <p role="alert">NEXT_PUBLIC_LIVE_AGENTS_URL must be a loopback http URL (127.0.0.1 or localhost). The browser talks only to the local Live AI Lab server.</p>
      </main>
    );
  }

  return (
    <main id="main-content" className={`live-lab${reducedMotion ? "" : " live-lab--motion"}`}>
      <header className="live-top">
        <div className="live-brand">
          <strong>MANDATE</strong>
          <h1>Live AI Lab</h1>
        </div>
        <nav className="live-nav" aria-label="Live AI Lab">
          <Link href="/demo">Protocol Replay</Link>
          <Link href="/docs">Docs</Link>
          <button type="button" onClick={() => dialogRef.current?.showModal()}>Event log</button>
        </nav>
      </header>
      <dl className="live-meta">
        <div>
          <dt>Model</dt>
          <dd>{model === "—" ? "—" : model}</dd>
        </div>
        <div>
          <dt>Mandate</dt>
          <dd>{active === null || active === undefined ? "None" : `V${str(active)}`}</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>Robinhood Chain Testnet</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{status === null ? "UNREACHABLE" : mode}</dd>
        </div>
      </dl>
      <p className="live-lead">Humans define authority. Agents operate autonomously. Mandate decides what may settle.</p>
      {message !== "" && <p className="live-alert" role="alert">{message}</p>}
      {sessionId === null ? (
        <section className="live-panel" aria-labelledby="start">
          <h2 id="start">Create your mandate</h2>
          <p className="live-lead">Tell the system what your agents may do. Mandate turns that intent into explicit authority.</p>
          <label>
            Provider
            <select value={providerChoice} onChange={(event) => setProviderChoice(event.target.value === "openai" ? "openai" : "stub")}>
              <option value="openai" disabled={!liveAvailable}>OpenAI</option>
              <option value="stub">Stub (deterministic, not a model)</option>
            </select>
          </label>
          <p className="live-small">{liveAvailable ? "A live model is available on the local server." : "No model key is configured on the server. The stub provider is deterministic."}</p>
          <button className="button button--primary focus-ring" type="button" onClick={() => void newSession()} disabled={status === null}>Open a session</button>
        </section>
      ) : (
        <>
          <Authoring
            prompt={prompt}
            setPrompt={setPrompt}
            drafting={drafting}
            busy={busy}
            draftPresent={view.draft !== null && view.draft !== undefined}
            reviewBlocked={reviewBlocked}
            expected={expected}
            confirmation={confirmation}
            setConfirmation={setConfirmation}
            phraseMatches={phraseMatches}
            issues={issues}
            draftIssues={draftIssues}
            guardrails={guardrails}
            versions={versions}
            active={active}
            paused={view.paused === true || presentation.paused}
            reserved={view.reserved === true}
            revising={revising}
            amendmentRefused={presentation.amendmentRefused}
            agentEnabled={agentEnabled}
            fieldValue={fieldValue}
            onDraft={() => { setRevising(true); void draftFromPrompt(); }}
            onPreset={(preset) => { setRevising(true); void call("POST", path("/draft"), { preset }); }}
            onFill={() => { setRevising(true); void call("POST", path("/draft/fill"), { preset: "balanced" }); }}
            onAdjust={() => { setRevising(true); void call("POST", path("/draft"), { from: "active" }); }}
            onField={(field, value) => { setRevising(true); void call("POST", path("/draft/field"), { path: field, value }); }}
            onResolve={(index) => { setRevising(true); void call("POST", path("/draft/resolve"), { index }); }}
            onAuthorize={() => void call("POST", path("/authorize"), { confirmation }).then((ok) => { if (ok) { setConfirmation(""); setRevising(false); } })}
            onToggle={(role, enabled) => { setRevising(true); void call("POST", path("/draft/field"), { path: `agents.${role}.enabled`, value: enabled }); }}
          />
          <Control
            presentation={presentation}
            now={now}
            busy={busy}
            active={active}
            paused={view.paused === true || presentation.paused}
            reserved={view.reserved === true}
            task={str(view.task)}
            pauseText={pauseText}
            setPauseText={setPauseText}
            pausePhrase={str(status?.pauseConfirmation)}
            providerKind={str(provider.kind)}
            onRun={() => void call("POST", path("/run"), {})}
            onPause={() => void call("POST", path("/pause"), { confirmation: pauseText })}
            onAdjust={() => { setRevising(true); void call("POST", path("/draft"), { from: "active" }); }}
          />
          <RoomPanel events={roomEvents} presentation={presentation} onRun={() => void call("POST", path("/run"), {})} onAdjust={() => { setRevising(true); void call("POST", path("/draft"), { from: "active" }); }} />
          <SettlementPanel presentation={presentation} stock={presentation.agents.find((agent) => agent.role === "stock")} />
          <StressPanel
            presentation={presentation}
            busy={busy}
            active={active}
            onRun={() => void call("POST", path("/policy-stress"), {})}
          />
          <Summary presentation={presentation} model={model} versions={versions} />
        </>
      )}
      <dialog ref={dialogRef} className="live-dialog" aria-labelledby="event-log-title">
        <h2 id="event-log-title">Event log</h2>
        <p className="live-small">MANDATE_LIVE_AI.V1 · {events.length} events. Events describe the session. They do not authorize it.</p>
        <ol className="live-log">
          {events.map((event) => (
            <li key={event.sequence}>
              <span className="live-code">{formatDuration(event.elapsedMs)}</span>
              <span>{event.agent === null ? "" : `${event.agent} `}{event.kind}</span>
            </li>
          ))}
        </ol>
        <button className="button focus-ring" type="button" onClick={() => dialogRef.current?.close()}>Close</button>
      </dialog>
    </main>
  );
}

function Authoring(props: {
  prompt: string;
  setPrompt: (value: string) => void;
  drafting: boolean;
  busy: boolean;
  draftPresent: boolean;
  reviewBlocked: boolean;
  expected: string;
  confirmation: string;
  setConfirmation: (value: string) => void;
  phraseMatches: boolean;
  issues: JsonRecord[];
  draftIssues: JsonRecord[];
  guardrails: JsonRecord[];
  versions: JsonRecord[];
  active: Json;
  paused: boolean;
  reserved: boolean;
  revising: boolean;
  amendmentRefused: string | null;
  agentEnabled: (role: RoleName) => boolean | null;
  fieldValue: (field: string) => string;
  onDraft: () => void;
  onPreset: (preset: string) => void;
  onFill: () => void;
  onAdjust: () => void;
  onField: (field: string, value: string | null) => void;
  onResolve: (index: number) => void;
  onAuthorize: () => void;
  onToggle: (role: RoleName, enabled: boolean) => void;
}): ReactNode {
  return (
    <section className="live-panel" aria-labelledby="create">
      <p className="live-kicker">Principal</p>
      <h2 id="create">Create your mandate</h2>
      <p className="live-lead">Tell the system what your agents may do. Mandate turns that intent into explicit authority.</p>
      <label>
        Principal intent
        <textarea value={props.prompt} maxLength={2000} onChange={(event) => props.setPrompt(event.target.value)} />
      </label>
      <div className="live-chips" aria-label="Prompt suggestions">
        {CHIPS.map((chip) => (
          <button key={chip} className="live-chip focus-ring" type="button" onClick={() => props.setPrompt(props.prompt.trim() === "" ? chip : `${props.prompt.trim()} ${chip}.`)}>{chip}</button>
        ))}
      </div>
      <div className="live-chips" aria-label="Agents">
        {ROLES.map((role) => {
          const enabled = props.agentEnabled(role);
          return (
            <button
              key={role}
              className="live-chip focus-ring"
              type="button"
              {...(enabled === null ? {} : { "aria-pressed": enabled })}
              disabled={!props.draftPresent || props.busy}
              onClick={() => props.onToggle(role, enabled !== true)}
            >
              {ROLE_TITLES[role]}
              {enabled === false ? " · NO AUTHORITY" : ""}
            </button>
          );
        })}
      </div>
      <p className="live-small">A disabled agent is still shown. Disabled means no authority: no mandate entry and no delegation.</p>
      <div className="live-row">
        <button className="button button--primary focus-ring" type="button" disabled={props.busy || props.drafting} onClick={props.onDraft}>Draft from prompt</button>
        {["conservative", "balanced", "aggressive"].map((preset) => (
          <button key={preset} className="button focus-ring" type="button" disabled={props.busy} onClick={() => props.onPreset(preset)}>Preset: {preset}</button>
        ))}
        <button className="button focus-ring" type="button" disabled={!props.draftPresent || props.busy} onClick={props.onFill}>Fill unset from balanced</button>
        <button className="button focus-ring" type="button" disabled={props.active === null || props.active === undefined} onClick={props.onAdjust}>Adjust mandate</button>
      </div>
      {props.drafting && <p role="status">Interpreting principal intent…</p>}
      {props.paused && (
        <p className="live-alert" role="status"><strong>Mandate paused.</strong> New actions cannot be authorized. Existing reservations stay recorded.</p>
      )}
      {props.amendmentRefused !== null && <p className="live-alert live-alert--bad" role="alert">Amendment refused. {props.amendmentRefused}</p>}
      {props.draftPresent && (
        <>
          {props.active !== null && props.active !== undefined && !props.revising ? (
            <>
              <h3>Mandate V{str(props.active)} active</h3>
              <p className="live-small">Changing a field starts the next draft. The signed version is not edited in place.</p>
            </>
          ) : (
            <>
              <h3>{props.expected === "—" ? "Draft" : props.expected.replace("AUTHORIZE ", "")} · Draft — not authorized</h3>
              <p className="live-small">A draft is not authority. Signing a new version does not edit the previous version in place.{props.active !== null && props.active !== undefined ? ` V${str(props.active)} stays active until this draft is authorized.` : ""}</p>
            </>
          )}
          {props.reviewBlocked && (
            <div className="live-alert" role="status">
              <strong>Authority needs review.</strong> Authorization stays closed until these issues are resolved.
              <ul>
                {props.draftIssues.map((issue, index) => (
                  <li key={`${index}:${str(issue.text)}`}>
                    <Badge value={str(issue.kind)} /> {str(issue.field)} — {str(issue.text)}{" "}
                    <button className="button focus-ring" type="button" onClick={() => props.onResolve(index)}>I have resolved this</button>
                  </li>
                ))}
                {props.issues.map((issue, index) => (
                  <li key={`${index}:${str(issue.code)}`}><Badge value={str(issue.code)} /> {str(issue.field)} — {str(issue.message)}</li>
                ))}
              </ul>
            </div>
          )}
          {props.guardrails.length === 0 ? null : <div className="live-guard">
            {GROUPS.map((group) => {
              const rows = props.guardrails.filter((row) => str(row.level) === group);
              return (
                <article key={group}>
                  <h3>{group === "AGENT" ? "Agents" : group === "MARKET" ? "Markets" : group === "EXECUTION" ? "Execution" : "Portfolio"}</h3>
                  {rows.length === 0 ? <p className="live-small">Shown when the draft validates.</p> : (
                    <ul>
                      {rows.map((row, index) => (
                        <li key={`${group}:${index}`}>
                          <Badge value={str(row.status)} /> {str(row.guardrail)} — {str(row.enforced)}
                        </li>
                      ))}
                    </ul>
                  )}
              </article>
            );
          })}
          </div>}
          <div className="live-fields live-guard">
            {TEXT_FIELDS.map((field) => (
              <label key={`${field.path}:${props.fieldValue(field.path)}`}>
                {field.label}
                <input defaultValue={props.fieldValue(field.path)} placeholder="unset" onBlur={(event) => { if (event.target.value !== props.fieldValue(field.path)) props.onField(field.path, event.target.value === "" ? null : event.target.value); }} />
              </label>
            ))}
            {ROLES.map((role) => (
              <label key={`${role}:${props.fieldValue(`agents.${role}.maxAllocation`)}`}>
                {ROLE_TITLES[role]} maximum
                <input defaultValue={props.fieldValue(`agents.${role}.maxAllocation`)} placeholder={props.agentEnabled(role) === false ? "no authority" : "unset"} onBlur={(event) => { if (event.target.value !== props.fieldValue(`agents.${role}.maxAllocation`)) props.onField(`agents.${role}.maxAllocation`, event.target.value === "" ? null : event.target.value); }} />
              </label>
            ))}
          </div>
          {props.reviewBlocked || (props.active !== null && props.active !== undefined && !props.revising) ? null : (
            <div className="live-row">
              <label>
                Type <code>{props.expected}</code>
                <input value={props.confirmation} onChange={(event) => props.setConfirmation(event.target.value)} aria-label="Authorization confirmation" autoComplete="off" />
              </label>
              <button className="button button--primary focus-ring" type="button" disabled={!props.phraseMatches} onClick={props.onAuthorize}>Submit authorization</button>
            </div>
          )}
          <p className="live-small">The principal signature is a publicly derived demonstration key held by the local server. It is not a wallet signature.</p>
        </>
      )}
      {props.active !== null && props.active !== undefined && <p role="status"><Badge value={`MANDATE V${str(props.active)} ACTIVE`} /></p>}
      {props.reserved && <p className="live-small">A reservation exists. A later amendment is refused. Pause still applies. Recorded reservations stay.</p>}
      {props.versions.length > 0 && (
        <ul className="live-versions">
          {props.versions.map((version) => (
            <li key={str(version.version)} className="live-version">
              V{str(version.version)} <Badge value={str(version.status)} />
              {str(version.status) === "SUPERSEDED" ? " Superseded. Not edited in place." : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Control(props: {
  presentation: ReturnType<typeof derivePresentation>;
  now: number;
  busy: boolean;
  active: Json;
  paused: boolean;
  reserved: boolean;
  task: string;
  pauseText: string;
  setPauseText: (value: string) => void;
  pausePhrase: string;
  providerKind: string;
  onRun: () => void;
  onPause: () => void;
  onAdjust: () => void;
}): ReactNode {
  return (
    <section className="live-panel" aria-labelledby="agents">
      <p className="live-kicker">Agents</p>
      <h2 id="agents">Agent control plane</h2>
      <p className="live-lead">Five agents operate independently. A model decision is not a Mandate decision.</p>
      <div className="live-row">
        <button className="button button--primary focus-ring" type="button" disabled={props.busy || props.paused || props.active === null || props.active === undefined} onClick={props.onRun}>Run agents</button>
        <label>
          Pause confirmation
          <input value={props.pauseText} onChange={(event) => props.setPauseText(event.target.value)} placeholder={props.pausePhrase === "—" ? "PAUSE MANDATE" : props.pausePhrase} aria-label="Pause confirmation" />
        </label>
        <button className="button focus-ring" type="button" onClick={props.onPause}>Pause</button>
        <button className="button focus-ring" type="button" disabled={props.active === null || props.active === undefined} onClick={props.onAdjust}>Adjust mandate</button>
        {props.busy && props.task !== "—" && <Badge value={`${props.task} IN PROGRESS`} />}
      </div>
      {props.paused && <p role="status">Mandate paused. New actions cannot be authorized.</p>}
      <div className="live-agents" aria-live="polite">
        {props.presentation.agents.map((agent) => (
          <AgentCardView key={agent.role} agent={agent} now={props.now} providerKind={props.providerKind} settled={props.presentation.settlement.settled && agent.role === "stock"} />
        ))}
      </div>
      {props.presentation.room.lines.length > 0 && (
        <div>
          <h3>Portfolio authority</h3>
          <div className="live-resources">
            {props.presentation.room.lines.map((line) => (
              <article key={line.resource} className={`live-resource live-resource--${line.status === "CONFLICT" || line.status === "UNRESOLVED" ? "conflict" : "ok"}`}>
                <h3 className="live-code">{line.resource}</h3>
                <p>{line.demandAfter === null ? `${line.demand} / ${line.authority}` : `${line.demand} → ${line.demandAfter} / ${line.authority}`}</p>
                <Badge value={line.status} />
                {line.status === "CONFLICT" || line.status === "UNRESOLVED" ? <p>Reduce by {line.reduction}</p> : null}
              </article>
            ))}
          </div>
          <p className="live-small">Each resource is a separate limit. Reductions are not added together.</p>
        </div>
      )}
    </section>
  );
}

function AgentCardView({ agent, now, providerKind, settled }: { agent: AgentCard; now: number; providerKind: string; settled: boolean }): ReactNode {
  const waiting = agent.phase === "PENDING" || agent.phase === "RESPONDING";
  const idle = agent.phase === "WAITING" && agent.candidate === "—" && agent.rationale === "" && agent.roomNote === "";
  const tone = agent.hardBlock ? "blocked" : agent.portfolioConflict ? "conflict" : agent.mandateLabel === "ADMISSIBLE" || agent.finalOutcome === "RESERVED" ? "ok" : "plain";
  const modelEvidence = providerKind === "LIVE" ? "LIVE MODEL" : "FIXTURE";
  const settlementEvidence = agent.role === "stock" ? (settled ? "LIVE_TESTNET" : "FIXTURE") : agent.role === "perps" ? "OFFCHAIN_ONLY" : "FIXTURE";
  if (idle) {
    return (
      <article className={`live-agent live-agent--${tone}`}>
        <h3>{agent.title}</h3>
        <p><Badge value="WAITING" /></p>
        <p className="live-small">Model <Badge value={modelEvidence} /> Settlement <Badge value={settlementEvidence} /></p>
      </article>
    );
  }
  return (
    <article className={`live-agent live-agent--${tone}${waiting ? " live-agent--wait" : ""}`}>
      <h3>{agent.title}</h3>
      <p><Badge value={waiting ? agent.phase : agent.phase} /> {agent.phase === "BLOCKED" ? null : agent.mandateLabel !== "WAITING" && agent.mandateLabel !== agent.phase ? <Badge value={agent.mandateLabel} /> : null}</p>
      {waiting && (
        <p role="status"><span className="live-dot" aria-hidden="true" />{ACTIVITY[agent.role]} {elapsedSince(agent.startedAt, now)}</p>
      )}
      <div className="live-split">
        <section>
          <h4>Model decision</h4>
          <dl>
            <dt>Decision</dt><dd className="live-code">{agent.candidate}</dd>
            <dt>Requested</dt><dd>{agent.requested}</dd>
          </dl>
          {agent.rationale !== "" && <p className="live-rationale">Declared rationale: {agent.rationale}</p>}
          <p className="live-small">Provider {formatDuration(agent.providerMs)} · first response {formatDuration(agent.firstResponseMs)}</p>
          <p className="live-small">Validation {formatDuration(agent.validationMs)} · signing {formatDuration(agent.signingMs)} · Mandate {formatDuration(agent.mandateMs)}</p>
        </section>
        <section>
          <h4>Mandate check</h4>
          <Badge value={agent.hardBlock ? "BLOCKED" : agent.mandateLabel} />
          {agent.reasons.length > 0 && <p className="live-code">{agent.reasons.join(" ")}</p>}
          {agent.hardBlock && <p className="live-small">Blocked by authority. This proposal does not enter the Room.</p>}
          {agent.portfolioConflict && <p className="live-small">Admissible. Portfolio conflict. This may enter the Room.</p>}
          {agent.timedOut && <p>Timed out. No allocation change recorded. A timeout is not consent, a release, or a crash.</p>}
          {agent.ignored !== null && <p><Badge value={`${agent.ignored} — IGNORED`} /> The late response did not change the portfolio.</p>}
          {agent.roomNote !== "" && <p className="live-small">{agent.roomNote}</p>}
          {agent.finalOutcome !== "" && <p>Final <Badge value={agent.finalOutcome} /></p>}
          <p className="live-small">Model <Badge value={modelEvidence} /> Settlement <Badge value={settlementEvidence} /></p>
          {agent.role === "stock" && <p className="live-small">A confirmed testnet settlement is a valueless fixture. Not an NVDA trade. Not a Robinhood Stock Token.</p>}
          {agent.role !== "stock" && <p className="live-small">{agent.role === "perps" ? "Settlement is off-chain in this flow." : "No live chain settlement in this flow."}</p>}
        </section>
      </div>
    </article>
  );
}

function RoomPanel(props: {
  events: LiveEvent[];
  presentation: ReturnType<typeof derivePresentation>;
  onRun: () => void;
  onAdjust: () => void;
}): ReactNode {
  const room = props.presentation.room;
  const verdict = room.authorized ? "AUTHORIZED" : room.refused ? "REFUSED" : room.reverify ? "MANDATE RE-VERIFYING" : room.proposal ? "NOT YET AUTHORIZED" : room.open ? "NEGOTIATING" : "WAITING";
  return (
    <section className="live-panel" aria-labelledby="room">
      <p className="live-kicker">Autonomous negotiation</p>
      <h2 id="room">Mandate Room</h2>
      <p className="live-lead">Agents may adjust requests. The Room cannot create authority. A Room proposal is not yet authorized.</p>
      {!room.open && !room.noFeasible ? <p className="live-small">No resource conflict yet. Hard policy blocks stay outside the Room.</p> : (
        <>
          <p>
            {room.roomId === null ? "" : <>Room {room.roomId} · </>}
            {room.generation === null ? "" : <>Generation {room.generation} · </>}
            <Badge value={verdict} />
          </p>
          {room.proposal && !room.authorized && !room.refused && <p role="status"><strong>Room proposal. Not yet authorized.</strong></p>}
          {room.reverify && !room.authorized && !room.refused && <p role="status">Mandate re-verifying. Authorization waits for the verifier.</p>}
          {room.authorized && <p role="status"><Badge value="AUTHORIZED" /> The verifier authorized this portfolio.</p>}
          {room.refused && <p role="status"><Badge value="REFUSED" /> The verifier refused this portfolio.</p>}
          <div className="live-agents">
            {props.presentation.agents.filter((agent) => agent.inRoom || agent.roomNote !== "" || agent.ignored !== null || agent.timedOut).map((agent) => (
              <article key={agent.role} className="live-agent">
                <h3>{agent.title}</h3>
                <p>{agent.roomNote === "" ? agent.phase : agent.roomNote}</p>
                {agent.ignored !== null && <Badge value={`${agent.ignored} — IGNORED`} />}
              </article>
            ))}
          </div>
          {room.lines.length > 0 && (
            <div className="live-resources">
              {room.lines.map((line) => (
                <article key={line.resource} className="live-resource">
                  <h3 className="live-code">{line.resource}</h3>
                  <p>Demand {line.demand}</p>
                  <p>Authority {line.authority}</p>
                  {line.demandAfter !== null && <p>After {line.demandAfter}</p>}
                  <p>Need {line.reduction === "0" ? "0" : `-${line.reduction}`}</p>
                  <Badge value={line.status} />
                </article>
              ))}
            </div>
          )}
          <ul className="live-log">
            {props.events.map((e) => {
              const line = conflicts(e.data.conflicts);
              return (
                <li key={e.sequence}>
                  <span className="live-code">{formatDuration(e.elapsedMs)}</span>
                  <span>{e.agent === null ? "" : `${e.agent} `}{e.kind}{line === "" ? "" : ` — ${line}`}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {room.noFeasible && (
        <div className="live-alert" role="status">
          <strong>No feasible portfolio.</strong> Nothing was authorized.
          <div className="live-row">
            <button className="button focus-ring" type="button" onClick={props.onRun}>Run again</button>
            <button className="button focus-ring" type="button" onClick={props.onAdjust}>Adjust mandate</button>
          </div>
        </div>
      )}
      {props.presentation.agents.filter((agent) => agent.finalOutcome === "RESERVED").length > 0 && room.authorized && (
        <div>
          <h3>Authorized portfolio</h3>
          <ul>
            {props.presentation.agents.filter((agent) => agent.finalOutcome !== "").map((agent) => (
              <li key={agent.role}>{agent.title} {agent.finalAmount === "" ? agent.requested : agent.finalAmount} <Badge value={agent.finalOutcome} /></li>
            ))}
          </ul>
          <p className="live-small">Reserved is not settled.</p>
        </div>
      )}
    </section>
  );
}

function SettlementPanel({ presentation, stock }: { presentation: ReturnType<typeof derivePresentation>; stock: AgentCard | undefined }): ReactNode {
  const settlement = presentation.settlement;
  const headline = settlement.stage === "SETTLED"
    ? "Settled"
    : settlement.stage === "FAILED"
      ? "Transaction failed"
      : settlement.stage === "SIMULATION_FAILED"
        ? "Testnet simulation failed"
        : settlement.stage === "PREFLIGHT_FAILED"
          ? "Network refused"
          : settlement.stage === "SUBMITTED"
            ? "Submitted"
            : settlement.stage === "SEND_REQUIRED"
              ? "Human send authorization required"
              : settlement.present
                ? "Testnet preflight"
                : "No testnet settlement in this session";
  return (
    <section className="live-panel" aria-labelledby="settlement">
      <p className="live-kicker">Settlement</p>
      <h2 id="settlement">Testnet settlement proof</h2>
      <p className="live-lead">This page does not send a transaction. Send authorization stays on the local server.</p>
      <div className="live-layers">
        <article className="live-layer">
          <h3>Agent decision</h3>
          <p>NVIDIA-backed fixture decision semantics.</p>
          <p>Requested: {stock?.requested && stock.requested !== "—" ? stock.requested : "—"}</p>
          <p>Reserved: {stock?.finalAmount || settlement.decisionNotional || "—"}</p>
          <Badge value={stock?.finalOutcome === "" ? "NOT RESERVED" : stock?.finalOutcome ?? "NOT RESERVED"} />
        </article>
        <article className="live-layer">
          <h3>Fixture amounts</h3>
          <p>Robinhood Chain testnet fixture.</p>
          {settlement.fixtureIn === null && settlement.fixtureOut === null ? <p>No fixture amounts in this session.</p> : <p>{settlement.fixtureIn ?? "—"} → {settlement.fixtureOut ?? "—"}</p>}
          <p className="live-qualify">Valueless demo assets. Not an NVDA trade. Not a Robinhood Stock Token.</p>
        </article>
      </div>
      <p role="status"><strong>{headline}.</strong> {settlement.stage === "SIMULATION_FAILED" ? "Nothing broadcast." : ""} {settlement.stage === "FAILED" ? "Not marked settled." : ""} {settlement.stage === "PREFLIGHT_FAILED" ? "Expected Robinhood Chain Testnet · 46630." : ""}</p>
      {settlement.present && (
        <dl>
          <dt>Network</dt><dd>{settlement.network || "Robinhood Chain Testnet"}</dd>
          <dt>Chain ID</dt><dd>{settlement.chainId || "—"}</dd>
          <dt>Gate</dt><dd className="live-hash">{settlement.gate || "—"}</dd>
          <dt>Evidence</dt><dd><Badge value={settlement.settled ? "LIVE_TESTNET" : settlement.evidence ?? "NOT SETTLED"} /></dd>
          {settlement.txHash !== null && (
            <>
              <dt>Transaction</dt>
              <dd className="live-hash">{settlement.txHash} <button className="button focus-ring" type="button" onClick={() => void navigator.clipboard.writeText(settlement.txHash ?? "")}>Copy</button></dd>
            </>
          )}
          {settlement.explorerUrl !== null && <dd><a href={settlement.explorerUrl} target="_blank" rel="noreferrer noopener">View on Robinhood Chain Explorer ↗</a></dd>}
          {settlement.block !== null && <><dt>Block</dt><dd>{settlement.block}</dd></>}
          {settlement.gasUsed !== null && <><dt>Gas used</dt><dd>{settlement.gasUsed}</dd></>}
          {settlement.receiptStatus !== null && <><dt>Receipt</dt><dd>{settlement.receiptStatus}</dd></>}
        </dl>
      )}
      {settlement.stage === "SEND_REQUIRED" && <p>Human send authorization is required on the server. This button is not a send.</p>}
      <p className="live-small">{settlement.detail}</p>
    </section>
  );
}

function StressPanel(props: {
  presentation: ReturnType<typeof derivePresentation>;
  busy: boolean;
  active: Json;
  onRun: () => void;
}): ReactNode {
  const stress = props.presentation.stress;
  const identity = stress.attempts.find((attempt) => Object.keys(attempt.identity).length > 0)?.identity ?? {};
  return (
    <section className="live-panel live-stress" aria-labelledby="stress">
      <h2 id="stress">POLICY STRESS TEST</h2>
      <p className="live-headline">VALID AGENT ≠ VALID ACTION</p>
      <p className="live-lead">The same authorized agent identity can submit different actions. Mandate evaluates each action against the principal&apos;s authority. Same identity. Different action. Different authorization result.</p>
      <button className="button button--primary focus-ring" type="button" disabled={props.busy || props.active === null || props.active === undefined} onClick={props.onRun}>Run policy stress test</button>
      {stress.started && (
        <>
          <dl className="live-meta">
            <div><dt>Agent identity</dt><dd><Badge value={str(identity.agentIdentity ?? "—")} /></dd></div>
            <div><dt>Membership</dt><dd><Badge value={str(identity.membership ?? "—")} /></dd></div>
            <div><dt>Delegation</dt><dd><Badge value={str(identity.delegation ?? "—")} /></dd></div>
            <div><dt>Signature</dt><dd><Badge value={str(identity.signature ?? "—")} /></dd></div>
            <div><dt>Same Swap signer</dt><dd><Badge value={identity.sameSignerAsSwapAgent === true ? "YES" : "—"} /></dd></div>
          </dl>
          <div className="live-attempts">
            {stress.attempts.map((attempt) => (
              <article key={attempt.attempt} className={`live-attempt${attempt.outcome === "AUTHORIZED" ? " live-attempt--ok" : ""}`}>
                <h3>Attempt {attempt.attempt}</h3>
                <dl>
                  <dt>Selected test case</dt><dd><strong>{attempt.caseId}</strong></dd>
                  <dt>Mandate result</dt><dd><Badge value={attempt.outcome} /></dd>
                </dl>
                {attempt.screening !== "" && attempt.screening !== "—" && <p>Screening <Badge value={attempt.screening} /></p>}
                {attempt.reasons.length > 0 && <p className="live-code">{attempt.reasons.map((reason) => code(reason)).join(" ")}</p>}
                {attempt.caseId === "COMPLIANT_CONTROL" && attempt.outcome === "AUTHORIZED" && <p>Same agent. Same identity. Compliant action. Authorized.</p>}
                {attempt.note !== "" && <p className="live-small">{attempt.note}</p>}
                {attempt.rationale !== "" && <p className="live-rationale">Declared rationale: {attempt.rationale}</p>}
              </article>
            ))}
          </div>
          {stress.ended !== "" && <p className="live-small">Ended: {stress.ended}</p>}
        </>
      )}
    </section>
  );
}

function Summary(props: { presentation: ReturnType<typeof derivePresentation>; model: string; versions: JsonRecord[] }): ReactNode {
  const active = props.versions.find((version) => str(version.status) === "ACTIVE");
  return (
    <section className="live-panel" aria-labelledby="session">
      <h2 id="session">Session</h2>
      <dl className="live-meta">
        <div><dt>Model</dt><dd>{props.model}</dd></div>
        <div><dt>Agents</dt><dd>5</dd></div>
        <div><dt>Blocked</dt><dd>{props.presentation.blocked}</dd></div>
        <div><dt>Admissible</dt><dd>{props.presentation.admissible}</dd></div>
        <div><dt>Room generations</dt><dd>{props.presentation.roomGenerations}</dd></div>
        <div><dt>Mandate</dt><dd>{active === undefined ? "—" : `V${str(active.version)}`}</dd></div>
        <div><dt>Testnet</dt><dd>{props.presentation.settlement.settled ? "1" : "0"}</dd></div>
        <div><dt>Evidence</dt><dd>{props.presentation.settlement.settled ? "LIVE_TESTNET" : "OFFCHAIN"}</dd></div>
      </dl>
    </section>
  );
}
