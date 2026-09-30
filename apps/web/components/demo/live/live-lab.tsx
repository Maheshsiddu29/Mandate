"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { amount, api, arr, code, liveServerUrl, ms, rec, str, streamEvents, type Json, type JsonRecord, type LiveEvent } from "./live-client";
import "./live-lab.css";

const SERVER = liveServerUrl(process.env.NEXT_PUBLIC_LIVE_AGENTS_URL);
const ROLES = ["stock", "swap", "nft", "yield", "perps"] as const;
const LABELS: Record<(typeof ROLES)[number], string> = { stock: "Stock Agent", swap: "Swap Agent", nft: "NFT Agent", yield: "Yield Agent", perps: "Perps Agent" };
const REFRESH_ON = new Set(["MANDATE_VERSION_AUTHORIZED", "MANDATE_PAUSED", "PORTFOLIO_AUTHORIZED", "PORTFOLIO_REFUSED", "ROOM_FINALIZED", "POLICY_STRESS_COMPLETED"]);

const TEXT_FIELDS: readonly { path: string; label: string }[] = [
  { path: "portfolio.totalCapital", label: "Total capital (USDC)" },
  { path: "portfolio.minUnallocated", label: "Minimum unallocated" },
  { path: "portfolio.maxDeployed", label: "Maximum deployed" },
  { path: "portfolio.maxDerivative", label: "Max derivative exposure" },
  { path: "portfolio.maxIlliquid", label: "Max illiquid exposure" },
  { path: "portfolio.validityMinutes", label: "Validity (minutes)" },
  { path: "market.maxLeverage", label: "Max leverage" },
  { path: "market.maxSlippageBps", label: "Max slippage (bps)" },
  { path: "market.maxQuoteAgeSeconds", label: "Max quote age (s)" },
];

interface AgentView {
  state: string;
  candidate: string;
  requested: string;
  rationale: string;
  provider: string;
  reasons: string[];
  room: string;
  final: string;
}

function blankAgent(): AgentView {
  return { state: "IDLE", candidate: "—", requested: "—", rationale: "", provider: "—", reasons: [], room: "", final: "" };
}

function deriveAgents(events: readonly LiveEvent[]): Record<string, AgentView> {
  const out: Record<string, AgentView> = Object.fromEntries(ROLES.map((r) => [r, blankAgent()]));
  for (const e of events) {
    if (e.kind.startsWith("POLICY_STRESS")) continue;
    const d = e.data;
    if (e.kind === "PORTFOLIO_AUTHORIZED" || e.kind === "PORTFOLIO_REFUSED") {
      for (const p of arr(d.proposals)) {
        const r = rec(p);
        const a = out[str(r.role)];
        if (a !== undefined) a.final = `${str(r.outcome)} ${str(r.requested)} USDC${arr(r.reasons).length > 0 ? ` · ${arr(r.reasons).map(code).join(", ")}` : ""}`;
      }
      continue;
    }
    const a = e.agent === null ? undefined : out[e.agent];
    if (a === undefined) continue;
    switch (e.kind) {
      case "AGENT_REQUEST_STARTED":
        Object.assign(a, blankAgent(), { state: "THINKING" });
        break;
      case "AGENT_FIRST_RESPONSE":
        a.state = "RESPONDING";
        break;
      case "AGENT_DECISION_COMPLETED":
        Object.assign(a, { state: "DECIDED", candidate: str(d.candidateId), requested: amount(d.requested), rationale: str(d.rationale), provider: ms(d.providerLatencyMs) });
        break;
      case "AGENT_ABSTAINED":
        Object.assign(a, { state: "ABSTAINED", rationale: str(d.rationale), provider: ms(d.providerLatencyMs) });
        break;
      case "AGENT_TIMED_OUT":
        a.state = "TIMED OUT";
        break;
      case "AGENT_FAILED":
        a.state = "FAILED";
        break;
      case "AGENT_INVALID_RESPONSE":
        a.state = "INVALID RESPONSE";
        break;
      case "PROPOSAL_SIGNED":
        if (d.phase === undefined) a.state = "SIGNED";
        break;
      case "PROPOSAL_BLOCKED":
        a.state = "BLOCKED";
        a.reasons = arr(d.reasons).map(str);
        break;
      case "PROPOSAL_ADMISSIBLE":
        a.state = d.portfolioValid === true ? "ADMISSIBLE" : "ADMISSIBLE · PORTFOLIO INVALID";
        a.reasons = arr(d.reasons).map(str);
        break;
      case "PROPOSAL_STALE":
        a.state = `STALE → ${str(d.next)}`;
        break;
      case "ROOM_AGENT_RESPONSE":
        a.room = d.status === undefined ? `g${e.generation ?? "?"} ${str(d.action)} ${amount(d.from)} → ${amount(d.to)}` : `g${e.generation ?? "?"} ${str(d.status)} (unchanged)`;
        break;
      case "ROOM_AGENT_TIMEOUT":
        a.room = `g${e.generation ?? "?"} timed out (unchanged: no consent, no release)`;
        break;
    }
  }
  return out;
}

interface StressAttempt {
  attempt: string;
  caseId: string;
  rationale: string;
  identity: JsonRecord;
  outcome: string;
  reasons: string[];
  note: string;
}

function deriveStress(events: readonly LiveEvent[]): { started: boolean; attempts: StressAttempt[]; ended: string } {
  const attempts: StressAttempt[] = [];
  let started = false;
  let ended = "";
  for (const e of events) {
    const d = e.data;
    if (e.kind === "POLICY_STRESS_STARTED") {
      started = true;
      attempts.length = 0;
      ended = "";
    } else if (e.kind === "POLICY_STRESS_CASE_SELECTED") {
      attempts.push({ attempt: str(d.attempt), caseId: str(d.caseId), rationale: str(d.rationale), identity: {}, outcome: d.caseId === "ABSTAIN" ? "NOT SUBMITTED" : "PENDING", reasons: [], note: "" });
    } else {
      const a = attempts.find((x) => x.attempt === str(d.attempt));
      if (e.kind === "POLICY_STRESS_PROPOSAL_SIGNED" && a !== undefined) a.identity = rec(d.identity);
      if (e.kind === "POLICY_STRESS_PROPOSAL_BLOCKED" && a !== undefined) Object.assign(a, { outcome: "REFUSED BY MANDATE", reasons: arr(d.reasons).map(str) });
      if (e.kind === "POLICY_STRESS_PROPOSAL_AUTHORIZED" && a !== undefined) Object.assign(a, { outcome: "AUTHORIZED", note: str(d.note) });
      if (e.kind === "POLICY_STRESS_COMPLETED") ended = str(d.endedBy);
    }
  }
  return { started, attempts, ended };
}

function Badge({ value }: { value: string }): ReactNode {
  const tone = /BLOCKED|REFUSED|FAILED|INVALID|NO_FEASIBLE|NONE/.test(value) ? "bad" : /AUTHORIZED|RESERVED|ADMISSIBLE|VALID|ACTIVE|PROPOSED/.test(value) ? "good" : /STALE|TIMED|PENDING|THINKING|RESPONDING/.test(value) ? "warn" : "plain";
  return <span className={`live-badge live-badge--${tone}`}>{value}</span>;
}

export function LiveLab(): ReactNode {
  const [status, setStatus] = useState<JsonRecord | null>(null);
  const [message, setMessage] = useState<string>("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<JsonRecord>({});
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [prompt, setPrompt] = useState("Use $2,000. Keep at least $200 unallocated. Allow at most $400 in perpetuals and $300 in NFTs. Only approved venues and issuers. Maximum leverage 2x. Valid for 60 minutes.");
  const [confirmation, setConfirmation] = useState("");
  const [pauseText, setPauseText] = useState("");
  const [providerChoice, setProviderChoice] = useState<"openai" | "stub">("stub");
  const stopRef = useRef<(() => void) | null>(null);

  const call = useCallback(
    async (method: "GET" | "POST", path: string, body?: JsonRecord): Promise<boolean> => {
      if (SERVER === null) return false;
      const r = await api(SERVER, method, path, body);
      if (sessionId !== null && path.startsWith(`/sessions/${sessionId}`) && typeof r.body.sessionId === "string") setView(r.body);
      if (!r.ok) setMessage(`${str(r.body.error)}: ${str(r.body.message)}`);
      else setMessage("");
      return r.ok;
    },
    [sessionId],
  );

  const refresh = useCallback(async () => {
    if (SERVER === null || sessionId === null) return;
    const r = await api(SERVER, "GET", `/sessions/${sessionId}`);
    if (r.ok) setView(r.body);
  }, [sessionId]);

  useEffect(() => {
    if (SERVER === null) return;
    void api(SERVER, "GET", "/status").then((r) => {
      if (r.ok) {
        setStatus(r.body);
        if (rec(rec(r.body.providers).openai).available === true) setProviderChoice("openai");
      } else setMessage(`${str(r.body.error)}: ${str(r.body.message)}`);
    });
  }, []);

  useEffect(() => {
    if (SERVER === null || sessionId === null) return undefined;
    const stop = streamEvents(
      SERVER,
      sessionId,
      -1,
      (e) => {
        setEvents((prev) => (prev.some((x) => x.sequence === e.sequence) ? prev : [...prev, e].sort((a, b) => a.sequence - b.sequence)));
        if (REFRESH_ON.has(e.kind)) void refresh();
      },
      () => setMessage("The event stream was interrupted; it reconnects automatically."),
    );
    stopRef.current = stop;
    return stop;
  }, [sessionId, refresh]);

  useEffect(() => {
    if (view.task === null || view.task === undefined) return undefined;
    const t = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(t);
  }, [view.task, refresh]);

  async function newSession(): Promise<void> {
    if (SERVER === null) return;
    stopRef.current?.();
    setEvents([]);
    const r = await api(SERVER, "POST", "/sessions", { provider: providerChoice });
    if (!r.ok) {
      setMessage(`${str(r.body.error)}: ${str(r.body.message)}`);
      return;
    }
    setMessage("");
    setView(r.body);
    setSessionId(str(r.body.sessionId));
  }

  const s = (p: string) => `/sessions/${sessionId ?? ""}${p}`;
  const agents = useMemo(() => deriveAgents(events), [events]);
  const stress = useMemo(() => deriveStress(events), [events]);
  const roomEvents = useMemo(() => events.filter((e) => e.kind.startsWith("ROOM_") || e.kind === "PORTFOLIO_CONFLICT"), [events]);
  const verdicts = useMemo(() => events.filter((e) => e.kind === "PORTFOLIO_AUTHORIZED" || e.kind === "PORTFOLIO_REFUSED"), [events]);
  const draft = rec(view.draft);
  const validation = rec(view.validation);
  const issues = arr(validation.issues).map(rec);
  const draftIssues = arr(draft.issues).map(rec);
  const guardrails = arr(validation.guardrails).map(rec);
  const versions = arr(view.versions).map(rec);
  const active = view.activeVersion;
  const busy = view.task !== null && view.task !== undefined;
  const liveAvailable = rec(rec(status?.providers).openai).available === true;
  const fieldValue = (path: string): string => {
    const [section, a, b] = path.split(".");
    const v: Json | undefined = b === undefined ? rec(draft[section ?? ""])[a ?? ""] : rec(rec(draft[section ?? ""])[a ?? ""])[b];
    return typeof v === "string" ? v : "";
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
    <main className="live-lab page-container" id="main-content">
      <header className="live-head">
        <p className="live-eyebrow">LIVE AI LAB · real model-backed agents · real Mandate code · fixture markets · no transactions</p>
        <h1>Humans define authority. Agents operate autonomously. Mandate decides what may settle.</h1>
        <p className="live-sub">Different reasoning. Different negotiation. Same authority boundary. Protocol Replay stays at <Link href="/demo">/demo</Link>.</p>
        <div className="live-row">
          <span>Server {SERVER}: {status === null ? <Badge value="UNREACHABLE" /> : <Badge value="CONNECTED" />}</span>
          <span>OpenAI: {liveAvailable ? <Badge value={`AVAILABLE · ${str(rec(rec(status?.providers).openai).model)}`} /> : <Badge value="NO KEY ON SERVER" />}</span>
          <label>
            Provider{" "}
            <select value={providerChoice} onChange={(e) => setProviderChoice(e.target.value === "openai" ? "openai" : "stub")}>
              <option value="openai" disabled={!liveAvailable}>OpenAI (live)</option>
              <option value="stub">Stub (deterministic, not a model)</option>
            </select>
          </label>
          <button className="button button--primary focus-ring" type="button" onClick={() => void newSession()} disabled={status === null}>New session</button>
        </div>
        {message !== "" && <p className="live-message" role="status">{message}</p>}
        {sessionId !== null && <p className="live-small">Session {sessionId} · provider {str(rec(view.provider).name)} ({str(rec(view.provider).kind)}) · model {str(rec(view.provider).model)}</p>}
      </header>

      {sessionId !== null && (
        <>
          <section className="live-panel" aria-labelledby="authoring">
            <h2 id="authoring">1 · Author the Portfolio Mandate</h2>
            <p className="live-small">A draft is never authority. Unset values stay unset; ambiguity and conflict are shown, not guessed.</p>
            <label className="live-block">
              Prompt
              <textarea value={prompt} maxLength={2000} rows={3} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <div className="live-row">
              <button className="button focus-ring" type="button" disabled={busy} onClick={() => void call("POST", s("/draft"), { prompt })}>Draft from prompt</button>
              {["conservative", "balanced", "aggressive"].map((p) => (
                <button key={p} className="button focus-ring" type="button" disabled={busy} onClick={() => void call("POST", s("/draft"), { preset: p })}>Preset: {p}</button>
              ))}
              <button className="button focus-ring" type="button" disabled={view.draft === null || busy} onClick={() => void call("POST", s("/draft/fill"), { preset: "balanced" })}>Fill unset from balanced</button>
              <button className="button focus-ring" type="button" disabled={active === null || active === undefined} onClick={() => void call("POST", s("/draft"), { from: "active" })}>Adjust mandate (start from active)</button>
            </div>

            {view.draft !== null && view.draft !== undefined && (
              <>
                <div className="live-fields">
                  {TEXT_FIELDS.map((f) => (
                    <label key={`${f.path}:${fieldValue(f.path)}`}>
                      {f.label}
                      <input defaultValue={fieldValue(f.path)} placeholder="unset" onBlur={(e) => { if (e.target.value !== fieldValue(f.path)) void call("POST", s("/draft/field"), { path: f.path, value: e.target.value === "" ? null : e.target.value }); }} />
                    </label>
                  ))}
                  {ROLES.map((r) => (
                    <label key={`${r}:${fieldValue(`agents.${r}.maxAllocation`)}`}>
                      {LABELS[r]} max allocation
                      <input defaultValue={fieldValue(`agents.${r}.maxAllocation`)} placeholder="unset" onBlur={(e) => { if (e.target.value !== fieldValue(`agents.${r}.maxAllocation`)) void call("POST", s("/draft/field"), { path: `agents.${r}.maxAllocation`, value: e.target.value === "" ? null : e.target.value }); }} />
                    </label>
                  ))}
                </div>
                {draftIssues.length > 0 && (
                  <div>
                    <h3>Unresolved interpretation issues (block authorization)</h3>
                    <ul>
                      {draftIssues.map((i, n) => (
                        <li key={`${n}:${str(i.text)}`}>
                          <Badge value={str(i.kind)} /> {str(i.field)} — {str(i.text)}{" "}
                          <button className="button focus-ring" type="button" onClick={() => void call("POST", s("/draft/resolve"), { index: n })}>I have resolved this</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <h3>Validation {validation.ok === true ? <Badge value="NO BLOCKING ISSUE" /> : <Badge value="BLOCKED" />}</h3>
                <ul className="live-issues">
                  {issues.map((i, n) => (
                    <li key={`${n}:${str(i.code)}`}>
                      <Badge value={str(i.severity)} /> {str(i.code)} {str(i.field)} — {str(i.message)}
                    </li>
                  ))}
                </ul>
                {guardrails.length > 0 && (
                  <details>
                    <summary>What will be enforced ({guardrails.length} guardrails)</summary>
                    <table className="live-table">
                      <thead>
                        <tr><th>Level</th><th>Guardrail</th><th>Enforced</th><th>Mandate term</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {guardrails.map((g, n) => (
                          <tr key={n}><td>{str(g.level)}</td><td>{str(g.guardrail)}</td><td>{str(g.enforced)}</td><td>{str(g.term)}</td><td>{str(g.status)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
                <div className="live-row">
                  <label>
                    Type <code>{str(view.expectedConfirmation)}</code> to authorize
                    <input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} aria-label="Authorization confirmation" />
                  </label>
                  <button className="button button--primary focus-ring" type="button" onClick={() => void call("POST", s("/authorize"), { confirmation }).then((ok) => { if (ok) setConfirmation(""); })}>Authorize</button>
                </div>
                <p className="live-small">The principal signature is a publicly derived demonstration key held by the local server. It is not a wallet signature and secures nothing.</p>
              </>
            )}
            {versions.length > 0 && (
              <ul className="live-versions">
                {versions.map((v) => (
                  <li key={str(v.version)}>
                    V{str(v.version)} <Badge value={str(v.status)} /> digest {str(v.digest).slice(0, 18)}…{arr(v.changes).length > 0 ? ` · changed: ${arr(v.changes).map((c) => `${str(rec(c).field)} ${str(rec(c).from)}→${str(rec(c).to)}`).join("; ")}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="live-panel" aria-labelledby="run">
            <h2 id="run">2 · Let the agents operate</h2>
            <div className="live-row">
              <button className="button button--primary focus-ring" type="button" disabled={busy || active === null || active === undefined} onClick={() => void call("POST", s("/run"))}>Run agents</button>
              <label>
                <input value={pauseText} onChange={(e) => setPauseText(e.target.value)} placeholder="PAUSE MANDATE" aria-label="Pause confirmation" />
              </label>
              <button className="button focus-ring" type="button" onClick={() => void call("POST", s("/pause"), { confirmation: pauseText })}>Pause</button>
              {busy && <Badge value={`${str(view.task)} IN PROGRESS`} />}
              {view.reserved === true && <span className="live-small">Something is reserved: amendments are refused from now on (Core cannot carry reservations to a new version); pause remains.</span>}
            </div>
            <div className="live-agents">
              {ROLES.map((r) => {
                const a = agents[r] ?? blankAgent();
                return (
                  <article key={r} className="live-agent">
                    <h3>{LABELS[r]}</h3>
                    <Badge value={a.state} />
                    <dl>
                      <dt>Candidate</dt><dd>{a.candidate}</dd>
                      <dt>Requested</dt><dd>{a.requested}</dd>
                      <dt>Provider latency</dt><dd>{a.provider}</dd>
                    </dl>
                    {a.rationale !== "" && <p className="live-rationale">Declared rationale: “{a.rationale}”</p>}
                    {a.reasons.length > 0 && <p className="live-small">Mandate: {a.reasons.map((x) => code(x)).join(", ")}</p>}
                    {a.room !== "" && <p className="live-small">Room: {a.room}</p>}
                    {a.final !== "" && <p className="live-small">Final: <Badge value={a.final} /></p>}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="live-panel" aria-labelledby="room">
            <h2 id="room">3 · Mandate Room (autonomous, no human)</h2>
            {roomEvents.length === 0 ? <p className="live-small">No resource conflict yet.</p> : (
              <ol className="live-log">
                {roomEvents.map((e) => (
                  <li key={e.sequence}><span className="live-time">+{e.elapsedMs} ms</span> {e.agent === null ? "" : `[${e.agent}] `}{e.kind}{e.generation === null ? "" : ` g${e.generation}`} {e.kind === "ROOM_FINALIZED" ? <Badge value={str(e.data.result)} /> : null}{e.kind === "ROOM_AGENT_RESPONSE" && e.data.rationale !== undefined ? ` — ${str(e.data.action)} ${amount(e.data.from)} → ${amount(e.data.to)} “${str(e.data.rationale)}”` : ""}</li>
                ))}
              </ol>
            )}
            {verdicts.map((e) => (
              <p key={e.sequence}>
                <Badge value={e.kind === "PORTFOLIO_AUTHORIZED" ? "PORTFOLIO AUTHORIZED" : "PORTFOLIO REFUSED"} /> {str(e.data.phase)} · verifier {str(e.data.verification)} · reserved {amount(e.data.reserved)} · transactions {str(e.data.transactions)}
              </p>
            ))}
          </section>

          <section className="live-panel live-stress" aria-labelledby="stress">
            <h2 id="stress">4 · POLICY STRESS TEST</h2>
            <p className="live-headline">VALID AGENT ≠ VALID ACTION</p>
            <p className="live-small">A real model runs under the Swap Agent’s own identity and local signer. It can only select one preconstructed test case at a time; trusted code builds and signs it; Mandate decides. It has no tools, no addresses, no amounts and no keys.</p>
            <button className="button button--primary focus-ring" type="button" disabled={busy || active === null || active === undefined} onClick={() => void call("POST", s("/policy-stress"), {})}>Run policy stress test</button>
            {stress.started && (
              <div className="live-attempts">
                {stress.attempts.map((a) => (
                  <article key={a.attempt} className="live-attempt">
                    <h3>Attempt {a.attempt}</h3>
                    <dl>
                      <dt>Agent identity</dt><dd><Badge value={str(a.identity.agentIdentity ?? "—")} /></dd>
                      <dt>Membership</dt><dd><Badge value={str(a.identity.membership ?? "—")} /></dd>
                      <dt>Delegation</dt><dd><Badge value={str(a.identity.delegation ?? "—")} /></dd>
                      <dt>Selected test case</dt><dd><strong>{a.caseId}</strong></dd>
                      <dt>Signature</dt><dd><Badge value={str(a.identity.signature ?? "—")} /></dd>
                      <dt>Mandate result</dt><dd><Badge value={a.outcome} /></dd>
                    </dl>
                    {a.reasons.length > 0 && <p className="live-small">{a.reasons.map((x) => code(x)).join(", ")}</p>}
                    {a.note !== "" && <p className="live-small">{a.note}</p>}
                    <p className="live-rationale">Declared rationale: “{a.rationale}”</p>
                  </article>
                ))}
                {stress.ended !== "" && <p className="live-small">Ended: {stress.ended}</p>}
              </div>
            )}
          </section>

          <section className="live-panel" aria-labelledby="events">
            <h2 id="events">Event stream · MANDATE_LIVE_AI.V1 ({events.length})</h2>
            <details>
              <summary>Show events</summary>
              <ol className="live-log">
                {events.map((e) => (
                  <li key={e.sequence}><span className="live-time">#{e.sequence} +{e.elapsedMs} ms</span> {e.agent === null ? "" : `[${e.agent}] `}{e.kind}</li>
                ))}
              </ol>
            </details>
          </section>
        </>
      )}
    </main>
  );
}
