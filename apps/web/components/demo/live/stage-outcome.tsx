"use client";

import { LatticeLoader } from "@/components/react-bits/lattice-loader";
import type { ReactNode } from "react";
import type { Failure } from "./live-flow";
import type { AuthorizedStockTrade } from "./allocation-model";
import { ROLE_TITLES, reasonLabel, usd, type RoleName, type SettlementView, type TradeReview } from "./live-model";
import { shortAddress } from "./wallet";
import { AgentGlyph, Pill } from "./workspace-ui";

export const FIXTURE_QUALIFICATION = "Valueless demo assets. Not an NVDA trade. Not a Robinhood Stock Token.";

/** What `GET /api/live/settlement` told the page. This milestone does not keep the operator phrase. */
export type SettlementOffer =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "ready" };

function Row({ role, children }: { readonly role: RoleName; readonly children: ReactNode }): ReactNode {
  return (
    <li className="mw-row" data-role={role}>
      <span className="mw-glyph mw-glyph--sm"><AgentGlyph role={role} size={16} /></span>
      <strong>{ROLE_TITLES[role]}</strong>
      <span className="mw-row__value">{children}</span>
    </li>
  );
}

/** Mandate re-checks the negotiated portfolio. The Room's agreement is not authority. */
export function VerifyStage({ proposed }: { readonly proposed: readonly { readonly role: RoleName; readonly amount: string }[] }): ReactNode {
  return (
    <div className="mw-verify" aria-live="polite">
      <header className="mw-stage-head">
        <p className="mw-kicker">Proposal ready · not authorized</p>
        <h2>Verifying final portfolio</h2>
        <p>Room consensus does not create authority. Mandate checks every proposal again against your signed limits.</p>
      </header>
      <div className="mw-inline-status"><LatticeLoader label="Mandate is re-verifying" status="working" pattern="sweep" showTimer={false} className="mw-lattice--lg" /></div>
      {proposed.length === 0 ? null : <ul className="mw-rows">{proposed.map((item) => <Row key={item.role} role={item.role}>{usd(item.amount)}</Row>)}</ul>}
    </div>
  );
}

function AuthorizedList({ review }: { readonly review: TradeReview }): ReactNode {
  return (
    <>
      <ul className="mw-rows">{review.authorized.map((item) => <Row key={item.role} role={item.role}>{usd(item.amount)}</Row>)}</ul>
      {review.reserved === null ? null : <p className="mw-total"><span>Total reserved</span><strong>{usd(review.reserved)}</strong></p>}
      <p className="mw-fine">Reserved is not settled.</p>
    </>
  );
}

/** Shown from the PORTFOLIO_AUTHORIZED event until the server reports the run finished. */
export function AuthorizedStage({ review }: { readonly review: TradeReview }): ReactNode {
  return (
    <div className="mw-authorized">
      <header className="mw-stage-head">
        <Pill tone="good">✓ Authorized</Pill>
        <h2>Authorized portfolio</h2>
      </header>
      <AuthorizedList review={review} />
    </div>
  );
}

const STEPS = [
  { label: "Preparing transaction", from: ["PREFLIGHT", "READY"], failed: "PREFLIGHT_FAILED" },
  { label: "Sign stock authorization", from: ["SIGN_GATE"], failed: null },
  { label: "Simulating", from: ["SIMULATION"], failed: "SIMULATION_FAILED" },
  { label: "Ready · not sent", from: ["SPINE_READY"], failed: null },
  { label: "Awaiting operator send authorization", from: ["SEND_REQUIRED", "READY_FOR_SEND"], failed: null },
  { label: "Submitted", from: ["SUBMITTED", "RECONCILING"], failed: "FAILED" },
  { label: "Confirmed", from: ["SETTLED"], failed: null },
] as const;
const ORDER: Readonly<Record<string, number>> = { NONE: -1, PREFLIGHT: 0, READY: 0, PREFLIGHT_FAILED: 0, SIGN_GATE: 1, SIMULATION: 2, SIMULATION_FAILED: 2, SPINE_READY: 3, SEND_REQUIRED: 4, READY_FOR_SEND: 4, SUBMITTED: 5, RECONCILING: 5, FAILED: 5, NEEDS_REVIEW: 5, RELEASED: 5, SETTLED: 6 };

/** The proof's one-word state: never CONFIRMED without LIVE_TESTNET, never FAILED for an outcome still being checked. */
function proofLabel(s: SettlementView): string {
  if (s.settled) return "CONFIRMED";
  switch (s.stage) {
    case "READY_FOR_SEND":
    case "SPINE_READY":
      return "READY · NOT SENT";
    case "RECONCILING":
      return "CHECKING";
    case "NEEDS_REVIEW":
      return "NEEDS REVIEW";
    case "RELEASED":
      return "NOT EXECUTED";
    default:
      return s.stage.replaceAll("_", " ");
  }
}

/** Portfolio authorization and domain settlement authority, when they differ in kind: shown, never implied. */
export function AuthorityLines({ settlement }: { readonly settlement: SettlementView }): ReactNode {
  const p = settlement.principals;
  if (p === null) return null;
  return (
    <dl className="mw-evidence mw-evidence--compact">
      <div><dt>Portfolio authorization</dt><dd>{p.portfolioMethod === "WALLET_PRINCIPAL_V2" || p.portfolioMethod === "WALLET_PRINCIPAL_V2_PLAN" ? `Wallet principal · ${shortAddress(p.portfolioAddress)}` : p.portfolioMethod === "WALLET_EIP712" ? `Wallet signature · ${shortAddress(p.portfolioAddress)}` : "Demo principal key"}</dd></div>
      <div><dt>Domain settlement authority</dt><dd>{p.domainKind === "SAME_PRINCIPAL" ? `Same address as the wallet · ${shortAddress(p.domainAddress)}` : p.domainKind === "WALLET_GATE_EIP712" ? `Wallet gate signature, per execution · ${shortAddress(p.domainAddress)}` : `Separate testnet custody · ${shortAddress(p.domainAddress)}`}</dd></div>
    </dl>
  );
}

/** Execution progress, one step per real settlement event. No percentages and no timers. */
export function SettlementSteps({ settlement }: { readonly settlement: SettlementView }): ReactNode {
  const at = ORDER[settlement.stage] ?? -1;
  return (
    <ol className="mw-steps" aria-label="Settlement progress">
      {STEPS.map((step, index) => {
        const failed = step.failed !== null && settlement.stage === step.failed;
        const finished = settlement.stage === "SETTLED" || settlement.stage === "SPINE_READY" || settlement.stage === "READY_FOR_SEND";
        const state = failed ? "failed" : index < at || (index === at && finished) ? "done" : index === at ? "active" : "todo";
        return (
          <li key={step.label} data-state={state}>
            <span className="mw-steps__dot" aria-hidden="true">{state === "done" ? "✓" : state === "failed" ? "✕" : ""}</span>
            {state === "active" ? <LatticeLoader label={step.label} status="working" pattern="ripple" showTimer={false} /> : <span>{step.label}</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function SettlingStage(props: {
  readonly settlement: SettlementView;
  readonly sessionId: string | null;
  readonly signing: boolean;
  readonly walletReady: boolean;
  readonly onSignStock: () => void;
  readonly onPrepareWallet: () => void;
}): ReactNode {
  const { settlement } = props;
  return (
    <div className="mw-settling">
      <header className="mw-stage-head">
        <p className="mw-kicker">{settlement.network || "Robinhood Chain Testnet"} · fixture execution</p>
        <h2>Executing</h2>
        <p>{settlementStatus(settlement.stage)}</p>
      </header>
      <SettlementSteps settlement={settlement} />
      {props.sessionId === null ? null : <p className="mw-fine">Session <code>{props.sessionId}</code></p>}
      {settlement.stage === "SIGN_GATE" ? (
        <>
          <p className="mw-notice">This signs execution authority. It is not a transaction. Nothing is broadcast.</p>
          {props.walletReady ? (
            <button type="button" className="mw-cta" disabled={props.signing} onClick={props.onSignStock}>Sign execution authorization</button>
          ) : (
            <button type="button" className="mw-soft-button" disabled={props.signing} onClick={props.onPrepareWallet}>Connect wallet on Robinhood Chain testnet</button>
          )}
        </>
      ) : null}
      {settlement.stage === "SIMULATION" ? <p className="mw-notice">Simulation ends with a dry-run result or a refusal. Nothing is broadcast.</p> : null}
      {settlement.stage === "SUBMITTED" ? <p className="mw-notice">A transaction hash is not settlement. Waiting for a confirmed receipt and verified postconditions.</p> : null}
      {settlement.stage === "RECONCILING" ? <p className="mw-notice" aria-live="polite">Checking settlement status… The reservation stays held and nothing is resent.</p> : null}
      <p className="mw-fine">{FIXTURE_QUALIFICATION}</p>
    </div>
  );
}

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

function SessionLine({ sessionId }: { readonly sessionId: string | null }): ReactNode {
  if (sessionId === null) return null;
  return <p className="mw-fine">Session <code>{sessionId}</code></p>;
}

function canExecute(settlement: SettlementView): boolean {
  if (settlement.settled || settlement.consumed) return false;
  if (settlement.stage === "SUBMITTED" || settlement.stage === "RECONCILING" || settlement.stage === "READY_FOR_SEND" || settlement.stage === "SIGN_GATE" || settlement.stage === "SIMULATION" || settlement.stage === "PREFLIGHT") return false;
  return true;
}

function settlementStatus(stage: SettlementView["stage"]): string {
  switch (stage) {
    case "PREFLIGHT":
    case "READY":
      return "Checking mandate…";
    case "SIGN_GATE":
      return "Waiting for wallet signature…";
    case "SIMULATION":
      return "Simulating exact execution…";
    case "SUBMITTED":
      return "Transaction submitted. Confirming…";
    case "RECONCILING":
      return "Confirming…";
    case "SETTLED":
      return "Settled";
    default:
      return "Only the authorized Stock action has a testnet settlement path.";
  }
}

function failureLine(detail: string): string {
  if (detail.includes("SPINE_EXPIRED")) return "Authorization expired. Review and authorize a fresh mandate.";
  if (detail.includes("GATE_EXECUTION_AUTHORITY_REQUIRED")) return "Wallet authorization required. Nothing was sent.";
  if (detail.includes("NO_PENDING_SIGNATURE")) return "Choose Execute again. Nothing was sent.";
  if (detail.includes("LIVE_MODEL_REQUIRED")) return "A live model session is required before a testnet send. Nothing was sent.";
  if (detail.includes("SPINE_METHOD_REQUIRED")) return "Connect the wallet that authorized this mandate. A demo principal cannot settle.";
  if (detail.includes("RPC") || detail.includes("CHAIN_")) return "Robinhood Chain testnet is temporarily unavailable. Nothing was sent.";
  if (detail === "") return "";
  return "Nothing was sent.";
}

function SettleActions(props: {
  readonly settlement: SettlementView;
  readonly offer: SettlementOffer;
  readonly busy: boolean;
  readonly capable: boolean;
  readonly walletOk: boolean;
  readonly onExecute: () => void;
}): ReactNode {
  const { settlement, offer } = props;
  if (!props.capable || !canExecute(settlement)) return null;
  if (!props.walletOk) return <p className="mw-fine">Connect the wallet that authorized this mandate.</p>;
  if (offer.kind === "loading") return <p className="mw-fine">Checking whether this server can settle.</p>;
  if (offer.kind === "unavailable") return <p className="mw-fine">{offer.message}</p>;
  return (
    <div className="mw-execute">
      <p className="mw-fine">Mandate has authorized this Stock action. Execute its testnet settlement proof.</p>
      <button type="button" className="mw-cta" disabled={props.busy} onClick={props.onExecute}>Execute on Robinhood Testnet</button>
    </div>
  );
}

function TechnicalDetails({ settlement }: { readonly settlement: SettlementView }): ReactNode {
  const rows: readonly (readonly [string, string])[] = [
    ["Candidate", settlement.candidateId ?? "—"],
    ["Wallet principal", settlement.walletPrincipal ?? "—"],
    ["Gate", settlement.gate || "—"],
    ["Gate mandate digest", settlement.mandateDigest ?? "—"],
    ["Reservation", settlement.reservationId ?? "—"],
    ["Initial allocation", settlement.initialAllocationDigest ?? "—"],
    ["Current allocation", settlement.currentPlanDigest ?? "—"],
    ["Gas estimate", settlement.gasEstimate ?? "—"],
    ["Broadcast", settlement.settled ? "Yes" : "No"],
    ["Receipt digest", settlement.receiptDigest ?? "—"],
  ];
  return (
    <details className="mw-tech">
      <summary>Technical proof</summary>
      <dl className="mw-evidence mw-evidence--compact">
        {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}
      </dl>
    </details>
  );
}

function SettlementProof(props: {
  readonly settlement: SettlementView;
  readonly stockTrade: AuthorizedStockTrade;
  readonly sessionId: string | null;
  readonly offer: SettlementOffer;
  readonly busy: boolean;
  readonly walletOk: boolean;
  readonly onExecute: () => void;
}): ReactNode {
  const { settlement, stockTrade } = props;
  // No Stock reservation, no Stock trade: the model's choice alone is never a trade decision, and offers no settlement control.
  if (!stockTrade.authorized && !settlement.present) {
    const blocked = stockTrade.hold === "BLOCKED";
    return (
      <section className="mw-proof" aria-label="Settlement">
        <div className="mw-proof__decision">
          <p className="mw-kicker">{blocked ? "Blocked" : "Trade decision"}</p>
          <p className="mw-proof__main">{blocked ? "Blocked" : "No authorized Stock trade"}</p>
          <p className="mw-fine">{stockTrade.hold === "ABSTAINED" ? "Stock did not propose a trade. " : stockTrade.hold === "RELEASED" ? "Stock allocation was released. " : blocked ? "Stock Agent proposed an action outside this mandate. " : null}The Stock proposal did not receive execution authority. Only an authorized, reserved Stock action has a testnet settlement path.</p>
          {blocked && stockTrade.blockCode !== null ? <p className="mw-fine">Reason: {reasonLabel(stockTrade.blockCode)}</p> : null}
          {blocked ? <p className="mw-fine">Wallet request: none. Transaction: none.</p> : null}
        </div>
      </section>
    );
  }
  if (stockTrade.authorized && !stockTrade.settlementCapable && !settlement.present) {
    return (
      <section className="mw-proof" aria-label="Settlement">
        <div className="mw-proof__decision">
          <p className="mw-kicker">Trade decision</p>
          <p className="mw-proof__main">{stockTrade.candidate ?? "Stock"}</p>
          <p className="mw-fine">Stock was authorized, but this testnet connector cannot execute this candidate.</p>
        </div>
      </section>
    );
  }
  const detail = settlement.detail !== "" && (settlement.stage === "FAILED" || settlement.stage === "SPINE_READY" || settlement.stage === "SIMULATION_FAILED" || settlement.stage === "PREFLIGHT_FAILED") ? settlement.detail : "";
  const failed = failureLine(detail);
  const noteName = stockTrade.candidate ?? "Stock";
  return (
    <section className="mw-proof" aria-label="Settlement">
      <div className="mw-proof__decision">
        <p className="mw-kicker">{settlement.settled ? "Settled" : "Trade decision"}</p>
        <p className="mw-proof__main">{noteName}</p>
        {stockTrade.candidateId === null ? null : <p className="mw-fine">Agent selected <code>{stockTrade.candidateId}</code></p>}
        <p className="mw-fine">Authorized capital {stockTrade.amount === null ? settlement.decisionNotional === null ? "—" : `${settlement.decisionNotional} USDC` : usd(stockTrade.amount)}</p>
      </div>
      <div className="mw-proof__chain">
        <p className="mw-kicker">Settlement proof</p>
        <p className="mw-fine">Testnet settlement proof</p>
        {settlement.present ? (
          <>
            <p className="mw-proof__main">{settlement.network || "Robinhood Chain Testnet"} <Pill tone={settlement.settled ? "good" : settlement.stage === "FAILED" || settlement.stage === "NEEDS_REVIEW" || settlement.stage === "RELEASED" ? "bad" : "warn"}>{proofLabel(settlement)}</Pill></p>
            <SessionLine sessionId={props.sessionId} />
            {settlement.fixtureIn === null ? null : <p className="mw-fine">{settlement.fixtureIn} → {settlement.fixtureOut ?? "—"}</p>}
            {settlement.txHash === null ? null : <p className="mw-hash">Transaction <code title={settlement.txHash}>{shortHash(settlement.txHash)}</code>{settlement.block === null ? null : <span>Confirmed in block {settlement.block}</span>}</p>}
            {settlement.gasUsed === null ? null : <p className="mw-fine">Gas {settlement.gasUsed}</p>}
            {settlement.explorerUrl === null ? null : <a className="mw-soft-button" href={settlement.explorerUrl} target="_blank" rel="noreferrer noopener">View transaction ↗</a>}
            {settlement.stage === "SUBMITTED" ? <p className="mw-fine">Transaction submitted. A transaction hash is not settlement. Confirming…</p> : null}
            {settlement.stage === "SIMULATION_FAILED" ? <p className="mw-fine">Simulation failed. Nothing was sent.</p> : null}
            {settlement.stage === "FAILED" ? <p className="mw-fine">Failed receipt. Never presented as LIVE_TESTNET. {failed || "Nothing was sent."}</p> : null}
            {settlement.stage === "READY_FOR_SEND" ? <p className="mw-fine">Broadcast is disabled in this milestone: nothing was sent.</p> : null}
            {settlement.stage === "PREFLIGHT_FAILED" ? <p className="mw-fine">{failed || "Nothing was sent."}</p> : null}
            {detail !== "" && settlement.stage !== "FAILED" && settlement.stage !== "PREFLIGHT_FAILED" ? <p className="mw-fine">{detail}</p> : null}
            {settlement.stage === "RECONCILING" ? <p className="mw-fine">Confirming… Nothing is resent.</p> : null}
            {settlement.stage === "NEEDS_REVIEW" ? <p className="mw-fine">Settlement needs review. No retry was sent.</p> : null}
            {settlement.stage === "RELEASED" ? <p className="mw-fine">Transaction failed or never executed. The reservation was released only after the gate deadline passed with nothing recorded onchain.</p> : null}
            {settlement.settled ? (
              <ul className="mw-rows">
                <li>Mandate verified</li>
                <li>Exact execution authorized</li>
                {settlement.commitmentRecorded ? <li>Execution commitment recorded onchain</li> : null}
                {settlement.consumed ? <li>Reservation consumed</li> : null}
                <li>Evidence {settlement.evidence ?? "recorded"}</li>
              </ul>
            ) : null}
            {settlement.consumed && !settlement.settled ? <p className="mw-fine">Already settled. Nothing is resent.</p> : null}
            <AuthorityLines settlement={settlement} />
            {settlement.stage === "SPINE_READY" || settlement.settled ? <TechnicalDetails settlement={settlement} /> : null}
            <SettleActions settlement={settlement} offer={props.offer} busy={props.busy} capable={stockTrade.settlementCapable} walletOk={props.walletOk} onExecute={props.onExecute} />
          </>
        ) : (
          <>
            <p className="mw-proof__main">Not settled in this session</p>
            <SessionLine sessionId={props.sessionId} />
            <p className="mw-fine">The browser never sends transactions. Execution stays on the local server. This page does not build the transaction.</p>
            <SettleActions settlement={settlement} offer={props.offer} busy={props.busy} capable={stockTrade.settlementCapable} walletOk={props.walletOk} onExecute={props.onExecute} />
          </>
        )}
        <p className="mw-proof__qualify">{FIXTURE_QUALIFICATION}</p>
      </div>
    </section>
  );
}

export function ReceiptStage(props: {
  readonly review: TradeReview;
  readonly settlement: SettlementView;
  readonly stockTrade: AuthorizedStockTrade;
  readonly sessionId: string | null;
  readonly offer: SettlementOffer;
  readonly walletOk: boolean;
  readonly onExecute: () => void;
  readonly onDetails: () => void;
  readonly onRoom: (() => void) | null;
  readonly onStress: () => void;
  readonly onRunAgain: () => void;
  readonly onAdjust: () => void;
  readonly busy: boolean;
}): ReactNode {
  const { review, settlement } = props;
  const title = settlement.settled ? "Settled" : settlement.stage === "FAILED" || settlement.stage === "SIMULATION_FAILED" || settlement.stage === "PREFLIGHT_FAILED" || settlement.stage === "RELEASED" ? "Settlement failed" : settlement.stage === "NEEDS_REVIEW" ? "Settlement needs review" : settlement.stage === "SUBMITTED" || settlement.stage === "RECONCILING" ? "Confirming" : "Portfolio authorized";
  return (
    <div className="mw-receipt">
      <header className="mw-stage-head">
        <Pill tone={title === "Settlement failed" || title === "Settlement needs review" ? "bad" : title === "Confirming" ? "warn" : "good"}>{title === "Settlement failed" ? "✕ Not settled" : title === "Settlement needs review" ? "! Needs review" : settlement.settled ? "✓ Settled" : title === "Confirming" ? "Confirming" : "✓ Authorized"}</Pill>
        <h2>{title}</h2>
        <p>{review.authorizedCount} of {review.evaluated} agents authorized{review.reserved === null ? "" : ` · ${usd(review.reserved)} reserved`}.{settlement.settled ? "" : " Reserved is not settled."}</p>
      </header>

      <div className="mw-receipt__grid">
        <section aria-label="Authorized">
          <h3>Authorized</h3>
          {review.authorized.length === 0 ? <p className="mw-fine">Nothing.</p> : <ul className="mw-rows">{review.authorized.map((item) => <Row key={item.role} role={item.role}>{usd(item.amount)}</Row>)}</ul>}
        </section>
        {review.blockedItems.length === 0 ? null : (
          <section aria-label="Blocked">
            <h3>Blocked</h3>
            <ul className="mw-rows mw-rows--bad">{review.blockedItems.map((item) => <Row key={item.role} role={item.role}><span title={item.codes.join(", ")}>{item.reason}</span></Row>)}</ul>
          </section>
        )}
        {review.negotiated.length === 0 ? null : (
          <section aria-label="Negotiated">
            <h3>Negotiated</h3>
            <ul className="mw-rows">{review.negotiated.map((item) => <Row key={item.role} role={item.role}>{usd(item.from)} → {usd(item.amount)}</Row>)}</ul>
          </section>
        )}
        {review.quiet.length === 0 ? null : (
          <section aria-label="No proposal">
            <h3>No proposal</h3>
            <ul className="mw-rows mw-rows--muted">{review.quiet.map((item) => <Row key={item.role} role={item.role}>{item.reason}</Row>)}</ul>
          </section>
        )}
      </div>

      <SettlementProof settlement={settlement} stockTrade={props.stockTrade} sessionId={props.sessionId} offer={props.offer} busy={props.busy} walletOk={props.walletOk} onExecute={props.onExecute} />

      <footer className="mw-stage-foot mw-stage-foot--receipt">
        <button type="button" className="mw-cta" onClick={props.onDetails}>Review details</button>
        <button type="button" className="mw-soft-button" disabled={props.busy} onClick={props.onStress}>Test the firewall</button>
        <span className="mw-links">
          {props.onRoom === null ? null : <button type="button" className="mw-text-button" onClick={props.onRoom}>Room conversation</button>}
          <button type="button" className="mw-text-button" disabled={props.busy} onClick={props.onRunAgain}>Run again</button>
          <button type="button" className="mw-text-button" disabled={props.busy} onClick={props.onAdjust}>Adjust mandate</button>
        </span>
      </footer>
    </div>
  );
}

const FAILURE_COPY: Record<Failure, { readonly title: string; readonly line: string }> = {
  NO_FEASIBLE: { title: "No feasible portfolio", line: "Agents couldn't resolve the conflict within your mandate. Nothing was authorized." },
  REFUSED: { title: "Mandate refused the portfolio", line: "The negotiated portfolio did not pass re-verification. Nothing was authorized." },
  NOTHING_TO_AUTHORIZE: { title: "Nothing to authorize", line: "No agent made an allowed proposal. Nothing was authorized." },
  RUN_ERROR: { title: "The run stopped", line: "The local server reported an error. Nothing further was authorized." },
  PAUSED: { title: "Mandate paused", line: "The mandate was revoked. Existing reservations stay recorded; nothing new can be authorized." },
};

export function FailedStage(props: { readonly failure: Failure; readonly onRunAgain: () => void; readonly onAdjust: () => void; readonly onRoom: (() => void) | null; readonly busy: boolean; readonly children?: ReactNode }): ReactNode {
  const copy = FAILURE_COPY[props.failure];
  return (
    <div className="mw-failed" role="status">
      <header className="mw-stage-head">
        <Pill tone="bad">✕ Stopped</Pill>
        <h2>{copy.title}</h2>
        <p>{copy.line}</p>
      </header>
      {props.children}
      <footer className="mw-stage-foot">
        {props.failure === "PAUSED" ? null : <button type="button" className="mw-cta" disabled={props.busy} onClick={props.onRunAgain}>Run again</button>}
        <button type="button" className="mw-soft-button" disabled={props.busy} onClick={props.onAdjust}>Adjust mandate</button>
        {props.onRoom === null ? null : <button type="button" className="mw-text-button" onClick={props.onRoom}>Room conversation</button>}
      </footer>
    </div>
  );
}
