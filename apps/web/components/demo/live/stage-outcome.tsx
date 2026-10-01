"use client";

import { LatticeLoader } from "@/components/react-bits/lattice-loader";
import type { ReactNode } from "react";
import { code } from "./live-client";
import type { Failure } from "./live-flow";
import { ROLE_TITLES, usd, type AgentCard, type RoleName, type SettlementView, type TradeReview } from "./live-model";
import { shortAddress } from "./wallet";
import { AgentGlyph, Pill } from "./workspace-ui";

export const FIXTURE_QUALIFICATION = "Valueless demo assets. Not an NVDA trade. Not a Robinhood Stock Token.";

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
  { label: "Simulating", from: ["SIMULATION"], failed: "SIMULATION_FAILED" },
  { label: "Awaiting operator send authorization", from: ["SEND_REQUIRED", "READY_FOR_SEND"], failed: null },
  { label: "Submitted", from: ["SUBMITTED", "RECONCILING"], failed: "FAILED" },
  { label: "Confirmed", from: ["SETTLED"], failed: null },
] as const;
const ORDER: Readonly<Record<string, number>> = { NONE: -1, PREFLIGHT: 0, READY: 0, PREFLIGHT_FAILED: 0, SIMULATION: 1, SIMULATION_FAILED: 1, SEND_REQUIRED: 2, READY_FOR_SEND: 2, SUBMITTED: 3, RECONCILING: 3, FAILED: 3, NEEDS_REVIEW: 3, RELEASED: 3, SETTLED: 4 };

/** The proof's one-word state: never CONFIRMED without LIVE_TESTNET, never FAILED for an outcome still being checked. */
function proofLabel(s: SettlementView): string {
  if (s.settled) return "CONFIRMED";
  switch (s.stage) {
    case "READY_FOR_SEND":
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
      <div><dt>Portfolio authorization</dt><dd>{p.portfolioMethod === "WALLET_PRINCIPAL_V2" ? `Wallet principal · ${shortAddress(p.portfolioAddress)}` : p.portfolioMethod === "WALLET_EIP712" ? `Wallet signature · ${shortAddress(p.portfolioAddress)}` : "Demo principal key"}</dd></div>
      <div><dt>Domain settlement authority</dt><dd>{p.domainKind === "SAME_PRINCIPAL" ? `Same address as the wallet · ${shortAddress(p.domainAddress)}` : `Separate testnet custody · ${shortAddress(p.domainAddress)}`}</dd></div>
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
        const state = failed ? "failed" : index < at || (index === at && settlement.stage === "SETTLED") ? "done" : index === at ? "active" : "todo";
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

export function SettlingStage({ settlement }: { readonly settlement: SettlementView }): ReactNode {
  return (
    <div className="mw-settling">
      <header className="mw-stage-head">
        <p className="mw-kicker">{settlement.network || "Robinhood Chain Testnet"} · fixture execution</p>
        <h2>Executing</h2>
        <p>Only the authorized Stock action has a testnet settlement path.</p>
      </header>
      <SettlementSteps settlement={settlement} />
      {settlement.stage === "SUBMITTED" ? <p className="mw-notice">A transaction hash is not settlement. Waiting for a confirmed receipt and verified postconditions.</p> : null}
      {settlement.stage === "RECONCILING" ? <p className="mw-notice" aria-live="polite">Checking settlement status… The reservation stays held and nothing is resent.</p> : null}
      <p className="mw-fine">{FIXTURE_QUALIFICATION}</p>
    </div>
  );
}

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

function SettlementProof({ settlement, stock }: { readonly settlement: SettlementView; readonly stock: AgentCard | undefined }): ReactNode {
  return (
    <section className="mw-proof" aria-label="Settlement">
      <div className="mw-proof__decision">
        <p className="mw-kicker">Trade decision</p>
        <p className="mw-proof__main">{stock !== undefined && stock.candidate !== "—" ? stock.candidate : "Stock"}</p>
        <p className="mw-fine">Authorized allocation {stock?.finalOutcome === "RESERVED" ? usd(stock.finalAmount) : "—"}</p>
      </div>
      <div className="mw-proof__chain">
        <p className="mw-kicker">Settlement proof</p>
        {settlement.present ? (
          <>
            <p className="mw-proof__main">{settlement.network || "Robinhood Chain Testnet"} <Pill tone={settlement.settled ? "good" : settlement.stage === "FAILED" || settlement.stage === "NEEDS_REVIEW" || settlement.stage === "RELEASED" ? "bad" : "warn"}>{proofLabel(settlement)}</Pill></p>
            <p className="mw-fine">Fixture execution{settlement.fixtureIn === null ? "" : ` · ${settlement.fixtureIn} → ${settlement.fixtureOut ?? "—"}`}</p>
            {settlement.txHash === null ? null : <p className="mw-hash"><code title={settlement.txHash}>{shortHash(settlement.txHash)}</code>{settlement.block === null ? null : <span>Block {settlement.block}</span>}</p>}
            {settlement.explorerUrl === null ? null : <a className="mw-soft-button" href={settlement.explorerUrl} target="_blank" rel="noreferrer noopener">View transaction ↗</a>}
            {settlement.stage === "SUBMITTED" ? <p className="mw-fine">A transaction hash is not settlement. LIVE_TESTNET requires a confirmed receipt.</p> : null}
            {settlement.stage === "FAILED" ? <p className="mw-fine">Failed receipt. Never presented as LIVE_TESTNET.</p> : null}
            {settlement.stage === "READY_FOR_SEND" ? <p className="mw-fine">Dry run passed for this session&rsquo;s reservation. Broadcast is disabled in this milestone: nothing was sent.</p> : null}
            {settlement.stage === "RECONCILING" ? <p className="mw-fine">Checking settlement status… Nothing is resent.</p> : null}
            {settlement.stage === "NEEDS_REVIEW" ? <p className="mw-fine">Settlement needs review. No retry was sent.</p> : null}
            {settlement.stage === "RELEASED" ? <p className="mw-fine">Transaction failed or never executed. The reservation was released only after the gate deadline passed with nothing recorded onchain.</p> : null}
            {settlement.consumed ? <p className="mw-fine">Reservation consumed in the durable ledger: it can never authorize another execution.</p> : null}
            <AuthorityLines settlement={settlement} />
          </>
        ) : (
          <>
            <p className="mw-proof__main">Not settled in this session</p>
            <p className="mw-fine">The browser never sends transactions. The operator runs the session-bound testnet settlement for this session; its events appear here.</p>
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
  readonly stock: AgentCard | undefined;
  readonly onDetails: () => void;
  readonly onRoom: (() => void) | null;
  readonly onStress: () => void;
  readonly onRunAgain: () => void;
  readonly onAdjust: () => void;
  readonly busy: boolean;
}): ReactNode {
  const { review, settlement } = props;
  const title = settlement.settled ? "Trade complete" : settlement.stage === "FAILED" || settlement.stage === "SIMULATION_FAILED" || settlement.stage === "PREFLIGHT_FAILED" || settlement.stage === "RELEASED" ? "Settlement failed" : settlement.stage === "NEEDS_REVIEW" ? "Settlement needs review" : "Portfolio authorized";
  return (
    <div className="mw-receipt">
      <header className="mw-stage-head">
        <Pill tone={title === "Settlement failed" || title === "Settlement needs review" ? "bad" : "good"}>{title === "Settlement failed" ? "✕ Not settled" : title === "Settlement needs review" ? "! Needs review" : settlement.settled ? "✓ Settled" : "✓ Authorized"}</Pill>
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
            <ul className="mw-rows mw-rows--bad">{review.blockedItems.map((item) => <Row key={item.role} role={item.role}><span title={item.codes.map(code).join(", ")}>{item.reason}</span></Row>)}</ul>
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

      <SettlementProof settlement={settlement} stock={props.stock} />

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
