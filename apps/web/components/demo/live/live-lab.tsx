"use client";

import { HeroWaves } from "@/components/mandate/hero-waves";
import { useReducedMotion } from "@/lib/motion";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, arr, liveServerUrl, rec, str, streamEvents, type Json, type JsonRecord, type LiveEvent } from "./live-client";
import { deriveFlow, eventsAfter, type Phase } from "./live-flow";
import { awaitingReplies, derivePresentation, deriveReview, deriveRoomChat, proposedPortfolio, ROLES, usd } from "./live-model";
import { RoomChat } from "./room-chat";
import { allocationState, authorizedStockTrade, budgetRows, planningCards, planView, serverCompatible, STALE_SERVER } from "./allocation-model";
import { AgentSelection, AllocationPanel, PlanningStage } from "./stage-planning";
import { EventLogBody, PauseBody, ReviewBody, StressBody } from "./sheets";
import { AgentsStage, AgentSummaryList } from "./stage-agents";
import { DraftingStage, PromptStage } from "./stage-compose";
import { ApproveStage, ConfigureStage, draftAccess, PermissionsBody, type WalletState } from "./stage-configure";
import { AuthorizedStage, FailedStage, ReceiptStage, SettlingStage, VerifyStage, type SettlementOffer } from "./stage-outcome";
import { APPROVAL_CHAIN, injectedWallet, shortAddress } from "./wallet";
import { Sheet } from "./workspace-ui";
import "./live-workspace.css";

const SERVER = liveServerUrl(process.env.NEXT_PUBLIC_LIVE_AGENTS_URL);
const REFRESH_ON = new Set([
  "MANDATE_VERSION_AUTHORIZED",
  "MANDATE_PAUSED",
  "PORTFOLIO_AUTHORIZED",
  "PORTFOLIO_REFUSED",
  "ROOM_NO_FEASIBLE_PORTFOLIO",
  "ROOM_FINALIZED",
  "POLICY_STRESS_COMPLETED",
  "MANDATE_AMENDMENT_REFUSED",
  "MANDATE_AMENDMENT_AUTHORIZED",
]);
const STAGE_KEY: Record<Phase, string> = {
  PROMPT: "prompt",
  DRAFTING: "drafting",
  CONFIGURE: "configure",
  PLANNING: "planning",
  APPROVE: "approve",
  AGENTS_WORKING: "agents",
  MANDATE_REVIEW: "agents",
  ROOM: "room",
  VERIFYING: "verify",
  AUTHORIZED: "authorized",
  SETTLING: "settling",
  COMPLETE: "complete",
  FAILED: "failed",
};
type SheetName = "permissions" | "review" | "events" | "stress" | "pause" | "agents" | "room" | null;

/** Where the durable session id is remembered, so a reload (or a server restart) returns to the same session. */
const SESSION_KEY = "mandate.live.session";
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

function rememberedSession(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("session");
  if (fromUrl !== null && SESSION_ID.test(fromUrl)) return fromUrl;
  try {
    const stored = window.localStorage.getItem(SESSION_KEY);
    return stored !== null && SESSION_ID.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

function rememberSession(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(SESSION_KEY);
    else window.localStorage.setItem(SESSION_KEY, id);
  } catch {
    // Storage is a convenience: the session id is still in the URL.
  }
  window.history.replaceState(null, "", id === null ? window.location.pathname : `${window.location.pathname}?session=${encodeURIComponent(id)}`);
}

/** Close the disclosure menu an item lives in, returning focus to its toggle. */
function closeMenu(target: Element): void {
  const menu = target.closest("details");
  if (menu === null) return;
  menu.open = false;
  menu.querySelector("summary")?.focus();
}

function message(body: JsonRecord): string {
  const text = str(body.message);
  return text === "—" ? str(body.error) : text;
}

export function LiveLab(): ReactNode {
  const reduced = useReducedMotion();
  const [status, setStatus] = useState<JsonRecord | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [providerChoice, setProviderChoice] = useState<"openai" | "stub">("stub");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<JsonRecord>({});
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [prompt, setPrompt] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [composing, setComposing] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [amending, setAmending] = useState(false);
  const [runFrom, setRunFrom] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sheet, setSheet] = useState<SheetName>(null);
  const [now, setNow] = useState(() => Date.now());
  const [wallet, setWallet] = useState<WalletState>({ available: false, address: null, chainId: null });
  const [resumed, setResumed] = useState(false);
  const [signing, setSigning] = useState(false);
  const [settlementOffer, setSettlementOffer] = useState<SettlementOffer>({ kind: "loading" });
  const [planOpen, setPlanOpen] = useState(false);
  const lastSequence = useRef(-1);
  const stageRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const shownStage = useRef<string | null>(null);

  useEffect(() => {
    if (SERVER === null) return;
    void api(SERVER, "GET", "/status").then((result) => {
      setConnected(result.ok);
      if (!result.ok) return;
      setStatus(result.body);
      if (rec(rec(result.body.providers).openai).available === true) setProviderChoice("openai");
      void api(SERVER, "GET", "/settlement").then((settlement) => {
        if (settlement.status === 404) {
          setSettlementOffer({ kind: "unavailable", message: "Settlement is not on this server. Start it with npm run agents:lab, then dry-run from this page." });
          return;
        }
        if (!settlement.ok) {
          setSettlementOffer({ kind: "unavailable", message: message(settlement.body) });
          return;
        }
        const phrase = str(settlement.body.sendAuthorization);
        setSettlementOffer(phrase === "—" ? { kind: "unavailable", message: "This server did not advertise the operator phrase. Nothing will be sent." } : { kind: "ready", phrase });
      });
      // A reload (or a server restart) returns to the same durable session; its events replay from the start.
      const id = rememberedSession();
      if (id === null) return;
      void api(SERVER, "GET", `/sessions/${encodeURIComponent(id)}`).then((session) => {
        if (!session.ok) {
          rememberSession(null);
          return;
        }
        setSessionId(id);
        setView(session.body);
        setComposing(false);
        setResumed(true);
        if (session.body.restored === true) setNotice("This session was restored after a server restart. It is evidence only: it runs no agents and authorizes nothing new.");
      });
    });
  }, []);

  const readWallet = useCallback(async () => {
    const w = injectedWallet();
    if (w === null) {
      setWallet({ available: false, address: null, chainId: null });
      return;
    }
    const [accounts, chain] = await Promise.all([w.getAccounts(), w.getChainId()]);
    setWallet({ available: true, address: accounts.ok ? (accounts.value[0] ?? null) : null, chainId: chain.ok ? chain.value : null });
  }, []);

  useEffect(() => {
    const w = injectedWallet();
    if (w === null) return undefined;
    let live = true;
    void Promise.all([w.getAccounts(), w.getChainId()]).then(([accounts, chain]) => {
      if (live) setWallet({ available: true, address: accounts.ok ? (accounts.value[0] ?? null) : null, chainId: chain.ok ? chain.value : null });
    });
    return () => {
      live = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (SERVER === null || sessionId === null) return;
    const result = await api(SERVER, "GET", `/sessions/${sessionId}`);
    if (result.ok) setView(result.body);
  }, [sessionId]);

  useEffect(() => {
    if (SERVER === null || sessionId === null) return undefined;
    return streamEvents(
      SERVER,
      sessionId,
      -1,
      (event) => {
        lastSequence.current = Math.max(lastSequence.current, event.sequence);
        setEvents((previous) => (previous.some((item) => item.sequence === event.sequence) ? previous : [...previous, event].sort((a, b) => a.sequence - b.sequence)));
        if (REFRESH_ON.has(event.kind)) void refresh();
      },
      () => setNotice("The event stream was interrupted. It reconnects automatically."),
    );
  }, [refresh, sessionId]);

  // While the server reports a task in progress, read its real status until it ends. No events are invented.
  const task = typeof view.task === "string" ? view.task : null;
  useEffect(() => {
    if (task === null) return undefined;
    const timer = window.setInterval(() => void refresh(), 700);
    return () => window.clearInterval(timer);
  }, [refresh, task]);

  const draft = rec(view.draft);
  const access = useMemo(() => draftAccess(draft), [draft]);
  const validation = rec(view.validation);
  const blocking = arr(validation.issues).map(rec).filter((issue) => str(issue.severity) === "BLOCKING");
  const draftIssues = arr(draft.issues).map(rec);
  const activeVersion = typeof view.activeVersion === "number" ? view.activeVersion : null;
  const draftPresent = view.draft !== null && view.draft !== undefined && !composing;
  const ready = validation.ok === true && draftIssues.length === 0;
  const lastRun = rec(view.lastRun);
  // A resumed session's run is everything after its latest version's authorization, as the server recorded it.
  const resumedFrom = useMemo(() => (resumed ? ([...events].reverse().find((event) => event.kind === "MANDATE_VERSION_AUTHORIZED")?.sequence ?? null) : null), [events, resumed]);
  const runStart = runFrom ?? resumedFrom;
  const runEvents = useMemo(() => eventsAfter(events, runStart), [events, runStart]);
  const presentation = useMemo(() => derivePresentation(runEvents, arr(lastRun.timing).map(rec)), [runEvents, lastRun.timing]);
  const stress = useMemo(() => derivePresentation(events).stress, [events]);
  const review = useMemo(() => deriveReview(runEvents), [runEvents]);
  const chat = useMemo(() => deriveRoomChat(runEvents), [runEvents]);
  const awaiting = useMemo(() => awaitingReplies(runEvents), [runEvents]);
  const allocation = allocationState(validation);
  const plan = useMemo(() => planView(view.lastPlan), [view.lastPlan]);
  const planCards = useMemo(() => planningCards(events, null), [events]);
  const compatible = status === null || serverCompatible(status);
  const flow = deriveFlow({
    drafting,
    draftPresent,
    planning: planOpen,
    reviewing,
    activeVersion,
    amending,
    runStarted: runStart !== null,
    task,
    lastRunStatus: typeof lastRun.status === "string" ? lastRun.status : null,
    lastError: typeof view.lastError === "string" ? view.lastError : null,
    runEvents,
    paused: view.paused === true,
  });
  const phase = flow.phase;
  const pending = presentation.agents.some((agent) => agent.phase === "PENDING" || agent.phase === "RESPONDING");
  const versions = arr(view.versions).map(rec);
  const activeRecord = versions.find((item) => item.version === activeVersion) ?? null;
  const roomSeen = runEvents.some((event) => event.kind === "ROOM_OPENED");
  const authorization = rec(activeRecord?.authorization);
  const authorizedBy = typeof authorization.method !== "string" ? null : authorization.method === "WALLET_PRINCIPAL_V2" || authorization.method === "WALLET_PRINCIPAL_V2_PLAN" ? `wallet principal ${shortAddress(str(authorization.principal))}` : authorization.method === "WALLET_EIP712" ? `authorized by ${shortAddress(str(authorization.principal))}` : "demo principal key";
  const provider = rec(view.provider);
  const providerKind = sessionId === null ? (providerChoice === "openai" ? "LIVE" : "STUB") : str(provider.kind);
  const liveAvailable = rec(rec(status?.providers).openai).available === true;

  // Keep the one main panel in view as it changes shape; never move the page when it is already visible.
  const stageKey = STAGE_KEY[phase];
  const stageStatus = phase === "PLANNING" && ((plan !== null && plan.purpose === null) || (plan === null && allocation?.pool.length === 1)) ? "Allocation proposal" : flow.status;
  useEffect(() => {
    const previous = shownStage.current;
    shownStage.current = stageKey;
    const element = stageRef.current;
    const bar = barRef.current;
    if (previous === null || previous === stageKey || element === null || bar === null) return;
    const top = element.getBoundingClientRect().top;
    if (top >= 72 && top <= window.innerHeight * 0.5) return;
    // Align the workspace bar just under the fixed site navigation, so status, trail and panel are all in view.
    window.scrollTo({ top: Math.max(0, window.scrollY + bar.getBoundingClientRect().top - 92), behavior: reduced ? "auto" : "smooth" });
  }, [reduced, stageKey]);

  useEffect(() => {
    if (!pending) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [pending]);

  const call = useCallback(async (method: "GET" | "POST", path: string, body?: JsonRecord): Promise<JsonRecord | null> => {
    if (SERVER === null || sessionId === null) return null;
    const result = await api(SERVER, method, `/sessions/${sessionId}${path}`, body);
    if (typeof result.body.sessionId === "string") setView(result.body);
    if (!result.ok) {
      setError(message(result.body));
      return null;
    }
    setError("");
    return result.body;
  }, [sessionId]);

  const startRun = useCallback(async (body: JsonRecord) => {
    const known = typeof body.events === "number" ? body.events - 1 : lastSequence.current;
    setRunFrom(known);
    await call("POST", "/run", {});
  }, [call]);

  async function buildMandate(): Promise<void> {
    if (SERVER === null || prompt.trim() === "" || drafting) return;
    if (!compatible) {
      setError(STALE_SERVER);
      return;
    }
    setDrafting(true);
    setSubmitted(prompt.trim());
    setError("");
    setNotice("");
    let id = sessionId;
    if (id === null) {
      const created = await api(SERVER, "POST", "/sessions", { provider: providerChoice });
      if (!created.ok) {
        setError(message(created.body));
        setDrafting(false);
        return;
      }
      id = str(created.body.sessionId);
      rememberSession(id);
      setEvents([]);
      lastSequence.current = -1;
      setSessionId(id);
      setView(created.body);
    }
    const result = await api(SERVER, "POST", `/sessions/${id}/draft`, { prompt: prompt.trim() });
    if (result.ok) {
      setView(result.body);
      setComposing(false);
    } else setError(message(result.body));
    setDrafting(false);
  }

  async function connectWallet(): Promise<void> {
    const w = injectedWallet();
    if (w === null) return;
    const r = await w.connect();
    if (!r.ok) setError(r.error.message);
    else setError("");
    await readWallet();
  }

  async function switchChain(): Promise<void> {
    const w = injectedWallet();
    if (w === null) return;
    const r = await w.switchChain();
    if (!r.ok) setError(r.error.message);
    else setError("");
    await readWallet();
  }

  /** The wallet path: a server-issued challenge, signed in the wallet, verified by the server. Never a transaction. */
  async function authorizeWithWallet(): Promise<void> {
    const w = injectedWallet();
    const address = wallet.address;
    if (w === null || address === null) return;
    setAuthorizing(true);
    setError("");
    const chain = await w.getChainId();
    if (!chain.ok || chain.value !== APPROVAL_CHAIN.chainId) {
      setAuthorizing(false);
      setError("Switch your wallet to Robinhood Chain testnet to sign. No mandate was activated.");
      await readWallet();
      return;
    }
    const challenge = await call("POST", "/wallet/challenge", { address, spine: "V2" });
    if (challenge === null) {
      setAuthorizing(false);
      return;
    }
    const signed = await w.signTypedData(address, challenge.typedData);
    if (!signed.ok) {
      setAuthorizing(false);
      setError(`${signed.error.message} No mandate was activated.`);
      return;
    }
    const body = await call("POST", "/wallet/authorize", { challenge: str(challenge.challenge), signature: signed.value });
    setAuthorizing(false);
    if (body === null) return;
    setReviewing(false);
    setAmending(false);
    setNotice("");
    await startRun(body);
  }

  async function authorize(confirmation: string): Promise<void> {
    setAuthorizing(true);
    const body = await call("POST", "/authorize", { confirmation });
    setAuthorizing(false);
    if (body === null) return;
    setReviewing(false);
    setAmending(false);
    setNotice("");
    await startRun(body);
  }

  const field = (path: string, value: Json): void => {
    void call("POST", "/draft/field", { path, value });
  };

  /** Agent selection is authority: the principal's own choice, written field by field. */
  const chooseAgents = async (chosen: readonly string[]): Promise<void> => {
    for (const role of ROLES) await call("POST", "/draft/field", { path: `agents.${role}.enabled`, value: chosen.includes(role) });
  };

  /** Ask the agents the principal left the split to for a proposal. Nothing is signed. */
  const askPlan = async (): Promise<void> => {
    setError("");
    setPlanOpen(true);
    await call("POST", "/plan", {});
  };

  /** Use the proposed split, with the principal's edits. The draft changes; nothing is signed. */
  const acceptPlan = async (edits: { readonly [role: string]: string }): Promise<void> => {
    if (plan === null) return;
    const body = await call("POST", "/draft/allocation", { plan: plan.roomId, budgets: { ...edits } });
    if (body !== null) setPlanOpen(false);
  };

  const adjust = async (): Promise<void> => {
    setSheet(null);
    const body = await call("POST", "/draft", { from: "active" });
    if (body === null) return;
    setAmending(true);
    setReviewing(false);
    setComposing(false);
  };

  /** Settlement JSON includes a session id and must not replace the session view. */
  async function postSettle(body: JsonRecord): Promise<JsonRecord | null> {
    if (SERVER === null || sessionId === null) return null;
    const result = await api(SERVER, "POST", `/sessions/${sessionId}/settle`, body);
    if (!result.ok) {
      setError(message(result.body));
      return null;
    }
    setError("");
    return result.body;
  }

  async function dryRun(): Promise<void> {
    setSigning(true);
    setError("");
    await postSettle({ mode: "DRY_RUN" });
    setSigning(false);
  }

  async function signStock(): Promise<void> {
    const gate = presentation.settlement.gateSign;
    const w = injectedWallet();
    const address = wallet.address;
    if (SERVER === null || sessionId === null || gate === null || w === null || address === null) {
      setError("Connect the wallet that signed this mandate. Nothing was broadcast.");
      return;
    }
    const chain = await w.getChainId();
    if (!chain.ok || chain.value !== APPROVAL_CHAIN.chainId) {
      setError("Switch your wallet to Robinhood Chain testnet to sign. Nothing was broadcast.");
      await readWallet();
      return;
    }
    setSigning(true);
    const signed = await w.signTypedData(address, gate.typedData);
    if (!signed.ok) {
      await api(SERVER, "POST", `/sessions/${sessionId}/settle`, { mode: gate.mode, cancel: true });
      setSigning(false);
      setError(`${signed.error.message} Nothing was broadcast.`);
      return;
    }
    await postSettle({ mode: gate.mode, gateSignature: signed.value });
    setSigning(false);
  }

  async function sendTestnet(phrase: string): Promise<void> {
    setSigning(true);
    setError("");
    await postSettle({ mode: "SEND", sendAuthorization: phrase });
    setSigning(false);
  }

  const runAgain = async (): Promise<void> => {
    setSheet(null);
    const body = await call("GET", "");
    await startRun(body ?? view);
  };

  if (SERVER === null) {
    return (
      <main className="mw" id="main-content">
        <div className="mw-stage" data-phase="PROMPT">
          <p className="mw-notice mw-notice--bad" role="alert">NEXT_PUBLIC_LIVE_AGENTS_URL must be a loopback http URL (127.0.0.1 or localhost). The browser talks only to the local Live Demo server.</p>
        </div>
      </main>
    );
  }

  const transition = reduced ? { duration: 0 } : { duration: 0.3, ease: [0.23, 1, 0.32, 1] as const };
  const showTrail = activeVersion !== null && !amending && runStart !== null && phase !== "AGENTS_WORKING" && phase !== "MANDATE_REVIEW";
  const blockedCount = presentation.agents.filter((agent) => agent.phase === "BLOCKED").length;
  const allowedCount = presentation.agents.filter((agent) => agent.phase === "ADMISSIBLE" || agent.finalOutcome === "RESERVED").length;
  const stockTrade = authorizedStockTrade(runEvents, arr(view.reservations).map(rec));
  const enabledRoles = ROLES.filter((role) => access.enabled(role) === true);

  let stage: ReactNode;
  switch (phase) {
    case "PROMPT":
      stage = <PromptStage prompt={prompt} onPrompt={setPrompt} onSend={() => void buildMandate()} connected={connected} error={compatible ? error : STALE_SERVER} />;
      break;
    case "DRAFTING":
      stage = <DraftingStage prompt={submitted} />;
      break;
    case "CONFIGURE":
      stage = (
        <ConfigureStage
          prompt={amending ? "" : submitted}
          access={access}
          notes={arr(draft.notes).map((note) => str(note))}
          blocking={blocking}
          draftIssues={draftIssues}
          ready={ready}
          busy={task !== null}
          amending={amending ? (activeVersion ?? 0) + 1 : null}
          notice={notice === "" ? error : notice}
          onField={field}
          onFill={() => void call("POST", "/draft/fill", { preset: "balanced" })}
          onResolve={(index) => void call("POST", "/draft/resolve", { index })}
          onPermissions={() => setSheet("permissions")}
          onTrade={() => {
            setNotice("");
            setError("");
            setReviewing(true);
          }}
          onStartOver={() => {
            // An amendment keeps its signed session; a fresh start leaves the old (possibly restored, evidence-only) one.
            if (!amending) {
              rememberSession(null);
              setSessionId(null);
              setView({});
              setEvents([]);
              lastSequence.current = -1;
              setResumed(false);
            }
            setPlanOpen(false);
            setReviewing(false);
            setNotice("");
            setError("");
            setComposing(true);
            setAmending(false);
            setPrompt(amending ? prompt : submitted);
          }}
          allocation={
            allocation === null ? undefined : allocation.intent === "NEEDS_AGENT_SELECTION" ? (
              <AgentSelection undecided={allocation.undecided} busy={task !== null} onChoose={(chosen) => void chooseAgents(chosen)} />
            ) : (
              <AllocationPanel state={allocation} access={access} busy={task !== null} blockedOtherwise={blocking.some((issue) => str(issue.code) !== "ALLOCATION_PLAN_REQUIRED")} onAskPlan={() => void askPlan()} onField={field} />
            )
          }
        />
      );
      break;
    case "PLANNING":
      stage = (
        <PlanningStage
          state={allocation}
          cards={planCards}
          plan={task === "PLAN" ? null : plan}
          working={task === "PLAN"}
          busy={task !== null}
          error={str(view.lastPlanError) === "—" ? error : str(view.lastPlanError)}
          ceilings={Object.fromEntries(ROLES.map((role) => [role, access.text(`agents.${role}.maxAllocation`) || null]))}
          derivativeCap={access.text("portfolio.maxDerivative") || null}
          illiquidCap={access.text("portfolio.maxIlliquid") || null}
          onUse={(edits) => void acceptPlan(edits)}
          onCancel={() => setPlanOpen(false)}
        />
      );
      break;
    case "APPROVE":
      stage = (
        <ApproveStage
          access={access}
          budgets={budgetRows(draft, enabledRoles)}
          autoReallocate={allocation?.autoReallocate ?? false}
          expected={str(view.expectedConfirmation)}
          authorizing={authorizing}
          error={error}
          wallet={wallet}
          onConnect={() => void connectWallet()}
          onSwitchChain={() => void switchChain()}
          onSignWallet={() => void authorizeWithWallet()}
          onAuthorize={(confirmation) => void authorize(confirmation)}
          onCancel={() => {
            setReviewing(false);
            setError("");
            setNotice("Approval cancelled. No mandate was activated.");
          }}
        />
      );
      break;
    case "AGENTS_WORKING":
    case "MANDATE_REVIEW":
      stage = <AgentsStage agents={presentation.agents} enabled={access.enabled} now={now} reviewing={phase === "MANDATE_REVIEW"} version={activeVersion} reduced={reduced} />;
      break;
    case "ROOM":
      stage = <RoomChat messages={chat} awaiting={awaiting} lines={presentation.room.lines} live reduced={reduced} />;
      break;
    case "VERIFYING":
      stage = <VerifyStage proposed={proposedPortfolio(runEvents)} />;
      break;
    case "AUTHORIZED":
      stage = <AuthorizedStage review={review} />;
      break;
    case "SETTLING":
      stage = (
        <SettlingStage
          settlement={presentation.settlement}
          sessionId={sessionId}
          signing={signing}
          walletReady={wallet.address !== null && wallet.chainId === APPROVAL_CHAIN.chainId}
          onSignStock={() => void signStock()}
          onPrepareWallet={() => {
            if (wallet.address === null) void connectWallet();
            else void switchChain();
          }}
        />
      );
      break;
    case "COMPLETE":
      stage = (
        <ReceiptStage
          review={review}
          settlement={presentation.settlement}
          stockTrade={stockTrade}
          sessionId={sessionId}
          offer={settlementOffer}
          busy={task !== null || signing}
          onDryRun={() => void dryRun()}
          onSend={(phrase) => void sendTestnet(phrase)}
          onDetails={() => setSheet("review")}
          onRoom={roomSeen ? () => setSheet("room") : null}
          onStress={() => setSheet("stress")}
          onRunAgain={() => void runAgain()}
          onAdjust={() => void adjust()}
        />
      );
      break;
    case "FAILED":
      stage = (
        <FailedStage failure={flow.failure ?? "RUN_ERROR"} busy={task !== null} onRunAgain={() => void runAgain()} onAdjust={() => void adjust()} onRoom={roomSeen ? () => setSheet("room") : null}>
          <AgentSummaryList agents={presentation.agents} enabled={access.enabled} />
        </FailedStage>
      );
      break;
  }

  return (
    <main id="main-content" className="mw" data-phase={phase} data-reduced={reduced ? "" : undefined}>
      <AnimatePresence>
        {phase === "PROMPT" || phase === "DRAFTING" ? (
          <motion.div key="waves" className="mw-waves" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? { duration: 0 } : { duration: 0.38 }}>
            <HeroWaves paused={phase !== "PROMPT"} opacity={0.55} />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div ref={barRef} className="mw-bar">
        <div className="mw-bar__left">
          <span className="mw-bar__title">Live demo</span>
          <span className="mw-bar__status" data-phase={phase} aria-live="polite">{stageStatus}</span>
        </div>
        <div className="mw-bar__right">
          <details className="mw-menu" onKeyDown={(event) => { if (event.key === "Escape") closeMenu(event.currentTarget); }}>
            <summary className="mw-env" aria-label={`Environment: ${providerKind === "LIVE" ? "Live model" : "Demo fixture"}`}>
              <span className="mw-env__dot" data-kind={providerKind} />
              {providerKind === "LIVE" ? `Live model${str(provider.model) === "—" ? "" : ` · ${str(provider.model)}`}` : "Demo fixture"}
            </summary>
            <div className="mw-menu__panel">
              <p className="mw-menu__label">Agent model</p>
              {sessionId === null ? (
                <>
                  <button type="button" aria-pressed={providerChoice === "stub"} onClick={(event) => { setProviderChoice("stub"); closeMenu(event.currentTarget); }}>Demo fixture <small>Deterministic stub; no model call</small></button>
                  <button type="button" aria-pressed={providerChoice === "openai"} disabled={!liveAvailable} onClick={(event) => { setProviderChoice("openai"); closeMenu(event.currentTarget); }}>Live model <small>{liveAvailable ? str(rec(rec(status?.providers).openai).model) : "No model key is configured on the local server"}</small></button>
                </>
              ) : (
                <p className="mw-fine">This session uses {providerKind === "LIVE" ? "the live model" : "the deterministic demo fixture"}. Start a new session from the Developer menu.</p>
              )}
            </div>
          </details>
          <Link className="mw-bar__link mw-bar__replay" href="/demo">Protocol Replay</Link>
          <details className="mw-menu mw-menu--end" onKeyDown={(event) => { if (event.key === "Escape") closeMenu(event.currentTarget); }}>
            <summary className="mw-bar__link">Developer</summary>
            <div className="mw-menu__panel">
              <Link className="mw-menu__item mw-menu__replay" href="/demo">Protocol Replay <small>The recorded judge transcript</small></Link>
              <button type="button" disabled={sessionId === null} onClick={(event) => { closeMenu(event.currentTarget); setSheet("events"); }}>Event log <small>{events.length} events</small></button>
              <button type="button" disabled={activeVersion === null || view.paused === true} onClick={(event) => { closeMenu(event.currentTarget); setSheet("pause"); }}>Pause mandate <small>Revoke the active mandate</small></button>
              <button type="button" disabled={sessionId === null} onClick={() => { rememberSession(null); window.location.assign(window.location.pathname); }}>New session <small>{sessionId === null ? "No session yet" : `Leave ${sessionId.slice(0, 12)}…`}</small></button>
            </div>
          </details>
        </div>
      </div>

      {showTrail ? (
        <nav className="mw-trail" aria-label="Completed steps">
          <button type="button" onClick={() => setSheet("permissions")}><span className="mw-trail__k">Mandate V{activeVersion}</span>{usd(access.text("portfolio.totalCapital"))} · {ROLES.filter((role) => access.enabled(role) === true).length} agents{authorizedBy === null ? "" : ` · ${authorizedBy}`}</button>
          <button type="button" onClick={() => setSheet("agents")}><span className="mw-trail__k">Agents</span>{blockedCount} blocked · {allowedCount} allowed</button>
          {roomSeen && phase !== "ROOM" ? <button type="button" onClick={() => setSheet("room")}><span className="mw-trail__k">Room</span>{presentation.room.noFeasible ? "unresolved" : presentation.room.proposal ? "resolved" : "negotiating"}</button> : null}
        </nav>
      ) : null}

      <motion.div ref={stageRef} className="mw-stage" data-phase={phase} layout={reduced ? false : "size"} transition={transition}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            key={stageKey}
            className={phase === "PROMPT" ? "mw-panel mw-panel--bare" : "mw-panel"}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.985, filter: "blur(2px)" }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -6, scale: 0.99, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } }}
            transition={reduced ? { duration: 0 } : { duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
            aria-label={stageStatus}
          >
            {stage}
          </motion.section>
        </AnimatePresence>
      </motion.div>

      <p className="mw-thesis">Agents propose. Agents negotiate. Mandate authorizes. Markets settle.</p>

      <Sheet open={sheet === "permissions"} onClose={() => setSheet(null)} title="Advanced permissions" kicker={activeVersion !== null && !amending && !reviewing && phase !== "CONFIGURE" ? `Mandate V${activeVersion} · signed` : "Draft"}>
        <PermissionsBody access={view.draft === null || view.draft === undefined ? null : access} guardrails={arr(validation.guardrails).map(rec)} catalog={rec(status?.catalog)} editable={phase === "CONFIGURE"} busy={task !== null} onField={field} />
      </Sheet>
      <Sheet open={sheet === "review"} onClose={() => setSheet(null)} title="Trade review" kicker="Summary · decisions · evidence" wide>
        <ReviewBody review={review} agents={presentation.agents} settlement={presentation.settlement} mandate={activeRecord} sessionId={sessionId ?? "—"} provider={`${str(provider.name)} · ${str(provider.model)}`} eventCount={events.length} onEvents={() => setSheet("events")} />
      </Sheet>
      <Sheet open={sheet === "agents"} onClose={() => setSheet(null)} title="Agent decisions" kicker="Model proposal · Mandate result">
        <AgentsStage agents={presentation.agents} enabled={access.enabled} now={now} reviewing={false} version={activeVersion} reduced={reduced} />
      </Sheet>
      <Sheet open={sheet === "room"} onClose={() => setSheet(null)} title="Room conversation" kicker="Real Room events, in order">
        <RoomChat messages={chat} awaiting={awaiting} lines={presentation.room.lines} live={false} reduced={reduced} compact />
      </Sheet>
      <Sheet open={sheet === "stress"} onClose={() => setSheet(null)} title="Security demo" kicker="Test the firewall" wide>
        <StressBody attempts={stress.attempts} started={stress.started} running={task === "POLICY_STRESS"} canRun={activeVersion !== null && task === null && view.paused !== true} onRun={() => void call("POST", "/policy-stress", {})} />
      </Sheet>
      <Sheet open={sheet === "events"} onClose={() => setSheet(null)} title="Event log" kicker="Developer details" wide>
        <EventLogBody events={events} />
      </Sheet>
      <Sheet open={sheet === "pause"} onClose={() => setSheet(null)} title="Pause mandate" kicker="Revoke authority">
        <PauseBody phrase={str(status?.pauseConfirmation)} onPause={(text) => void call("POST", "/pause", { confirmation: text }).then((body) => { if (body !== null) setSheet(null); })} />
      </Sheet>
    </main>
  );
}
