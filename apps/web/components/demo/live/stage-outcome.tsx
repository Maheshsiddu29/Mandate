"use client";

import { LatticeLoader } from "@/components/react-bits/lattice-loader";
import type { ReactNode } from "react";
import type { Failure } from "./live-flow";
import type { AuthorizedStockTrade } from "./allocation-model";
import { ROLE_TITLES, reasonLabel, usd, type ReviewItem, type RoleName, type SettlementView, type TradeReview } from "./live-model";
import { holdNote, proofStatus, receiptHeading, type SettlementRefusal } from "./settlement-refusal";
import { heldCopy, reconcileOffered, type RestoredSettlement } from "./settlement-restore";
import { shortAddress } from "./wallet";
import { AgentGlyph, Pill } from "./workspace-ui";

export const FIXTURE_QUALIFICATION = "Valueless demo assets. Not an NVDA trade. Not a Robinhood Stock Token.";

/** What `GET /api/live/settlement` told the page. Browser settlement no longer uses a typed send confirmation. */
export type SettlementOffer =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "ready"; readonly spine?: "V2" | "V3" };

function RefusalNotice({ conflict }: { readonly conflict: SettlementRefusal }): ReactNode {
  const hold = holdNote(conflict, (ms) => new Date(ms).toLocaleTimeString());
  return (
    <div className="mw-notice mw-notice--bad" role="alert">
      <p>{conflict.summary}</p>
      {hold === null ? null : <p>{hold}</p>}
      <details className="mw-tech">
        <summary>Details</summary>
        <dl className="mw-evidence mw-evidence--compact">
          <div><dt>Reason</dt><dd><code>{conflict.code === "" ? "—" : conflict.code}</code></dd></div>
          <div><dt>Message</dt><dd>{conflict.message === "" ? "—" : conflict.message}</dd></div>
          <div><dt>Stage</dt><dd><code>{conflict.stage ?? "—"}</code></dd></div>
          <div><dt>Transaction</dt><dd>{conflict.txHash ?? "None"}</dd></div>
          <div><dt>Broadcasts</dt><dd>{conflict.transactions === null ? "—" : String(conflict.transactions)}</dd></div>
          {conflict.held ? <div><dt>Attempt</dt><dd>Held for reconciliation{conflict.heldUntil === null ? "" : ` until ${conflict.heldUntil} (unix seconds)`}</dd></div> : null}
        </dl>
      </details>
    </div>
  );
}

/** Asks the server to reconcile from chain evidence. It never signs or sends, and is offered only for a held attempt. */
function ReconcileButton(props: { readonly restored: RestoredSettlement | null; readonly busy: boolean; readonly onReconcile: () => void }): ReactNode {
  if (!reconcileOffered(props.restored)) return null;
  return (
    <>
      <button type="button" className="mw-soft-button" disabled={props.busy} onClick={props.onReconcile}>Check settlement status</button>
      <p className="mw-fine">Checking reads chain state only. It never signs or sends.</p>
    </>
  );
}

/** A signed attempt the server holds for reconciliation (durable state, never inferred here). Nothing was sent. */
function HeldNotice(props: { readonly settlement: SettlementView; readonly restored: RestoredSettlement | null; readonly busy: boolean; readonly onReconcile: () => void }): ReactNode {
  const { restored } = props;
  const copy = heldCopy({ reason: props.settlement.detail, heldUntil: restored?.heldUntil ?? null }, (ms) => new Date(ms).toLocaleString());
  return (
    <div className="mw-notice" role="status">
      <p><strong>{copy.title}</strong></p>
      <p>{copy.line}</p>
      <p>{copy.until}</p>
      <dl className="mw-evidence mw-evidence--compact">
        <div><dt>Transaction</dt><dd>None</dd></div>
        <div><dt>Broadcasts</dt><dd>0</dd></div>
        <div><dt>Attempt</dt><dd><code>{restored?.attemptState ?? "—"}{restored?.quarantine == null ? "" : ` · ${restored.quarantine}`}</code></dd></div>
        <div><dt>Reservation</dt><dd><code>{restored?.reservationState ?? "—"}</code></dd></div>
        {props.settlement.detail === "" ? null : <div><dt>Reason</dt><dd><code>{props.settlement.detail}</code></dd></div>}
      </dl>
      <ReconcileButton restored={restored} busy={props.busy} onReconcile={props.onReconcile} />
    </div>
  );
}

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
      <p className="mw-fine">Reserved is authorization evidence, not settlement.</p>
    </>
  );
}

function OutcomeRow({ item }: { readonly item: ReviewItem }): ReactNode {
  return (
    <Row role={item.role}>
      <span className="mw-outcome-stack">
        <strong>{item.outcome}</strong>
        {item.amount === "—" ? null : <span>{usd(item.amount)}</span>}
        {item.settlementEvidence === "NONE" ? null : <span className="mw-muted">Settlement evidence: {item.settlementEvidence}</span>}
        {item.settlementNote === null ? (item.reason === "" ? null : <span className="mw-muted">{item.reason}</span>) : <span className="mw-muted">{item.settlementNote}</span>}
      </span>
    </Row>
  );
}

/** Shown from the PORTFOLIO_AUTHORIZED event until the server reports the run finished. */
export function AuthorizedStage({ review }: { readonly review: TradeReview }): ReactNode {
  return (
    <div className="mw-authorized">
      <header className="mw-stage-head">
        <Pill tone="good">Mandate active</Pill>
        <h2>Mandate active</h2>
        <p>Agents can act only within the authority you approved.</p>
      </header>
      <AuthorizedList review={review} />
    </div>
  );
}

const STEPS = [
  { label: "Checking authorization", from: ["PREFLIGHT", "READY"], failed: "PREFLIGHT_FAILED" },
  { label: "Sign execution", from: ["SIGN_GATE"], failed: null },
  { label: "Simulating", from: ["SIMULATION", "SPINE_READY"], failed: "SIMULATION_FAILED" },
  { label: "Submitting", from: ["SEND_REQUIRED", "READY_FOR_SEND"], failed: null },
  { label: "Submitted", from: ["SUBMITTED", "RECONCILING"], failed: "FAILED" },
  { label: "Confirmed", from: ["SETTLED"], failed: null },
] as const;
const ORDER: Readonly<Record<string, number>> = { NONE: -1, PREFLIGHT: 0, READY: 0, PREFLIGHT_FAILED: 0, SIGN_GATE: 1, SIMULATION: 2, SIMULATION_FAILED: 2, SPINE_READY: 2, SEND_REQUIRED: 3, READY_FOR_SEND: 3, SUBMITTED: 4, RECONCILING: 4, FAILED: 4, NEEDS_REVIEW: 4, RELEASED: 4, SETTLED: 5 };

/** The proof's one-word state: never CONFIRMED without LIVE_TESTNET, never FAILED before a transaction exists. */
function proofLabel(s: SettlementView): string {
  return proofStatus({ settled: s.settled, stage: s.stage, txHash: s.txHash });
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
  readonly conflict: SettlementRefusal | null;
  readonly restored: RestoredSettlement | null;
  readonly onReconcile: () => void;
  readonly autonomousV3?: boolean;
}): ReactNode {
  const { settlement } = props;
  const v3 = props.autonomousV3 === true;
  return (
    <div className="mw-settling">
      <header className="mw-stage-head">
        <p className="mw-kicker">{settlement.network || "Robinhood Chain Testnet"} · fixture execution</p>
        <h2>{v3 ? "Autonomous settlement" : "Executing"}</h2>
        <p>{v3 ? v3SettlementStatus(settlement.stage) : settlementStatus(settlement.stage)}</p>
      </header>
      {v3 ? (
        <p className="mw-notice" role="status">AUTHORIZED — No additional wallet approval required</p>
      ) : null}
      <SettlementSteps settlement={settlement} />
      {!v3 && settlement.stage === "SIGN_GATE" ? (
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
      {settlement.stage === "SUBMITTED" || settlement.stage === "RECONCILING" ? <ReconcileButton restored={props.restored} busy={props.signing} onReconcile={props.onReconcile} /> : null}
      {props.conflict === null ? null : <RefusalNotice conflict={props.conflict} />}
      <p className="mw-fine">{FIXTURE_QUALIFICATION}</p>
    </div>
  );
}

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

function canExecute(settlement: SettlementView): boolean {
  if (settlement.settled || settlement.consumed) return false;
  if (settlement.stage === "HELD" || settlement.stage === "SUBMITTED" || settlement.stage === "RECONCILING" || settlement.stage === "READY_FOR_SEND" || settlement.stage === "SIGN_GATE" || settlement.stage === "SIMULATION" || settlement.stage === "PREFLIGHT") return false;
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
      return "Executing the authorized Stock action on Robinhood Chain Testnet.";
  }
}

function v3SettlementStatus(stage: SettlementView["stage"]): string {
  switch (stage) {
    case "PREFLIGHT":
    case "READY":
      return "Checking chain state…";
    case "SIMULATION":
      return "Simulating…";
    case "SUBMITTED":
      return "Submitting…";
    case "SETTLED":
      return "Confirmed";
    case "RECONCILING":
      return "Confirming…";
    default:
      return "Bounded autonomous settlement under your signed V3 authority.";
  }
}

function failureLine(detail: string): string {
  if (detail === "SETTLEMENT_INTERRUPTED") return "Execution was interrupted. Nothing was sent.";
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
  readonly retry: boolean;
  readonly onExecute: () => void;
}): ReactNode {
  const { settlement, offer } = props;
  if (!props.capable || !props.retry || !canExecute(settlement)) return null;
  if (!props.walletOk) return <p className="mw-fine">Connect the wallet that authorized this mandate.</p>;
  if (offer.kind === "loading") return <p className="mw-fine">Checking whether this server can settle.</p>;
  if (offer.kind === "unavailable") return <p className="mw-fine">{offer.message}</p>;
  if (offer.spine === "V3") {
    return (
      <div className="mw-execute">
        <p className="mw-fine">V3 autonomous settlement — no Execute button. Settlement proceeds under your signed delegated authority.</p>
      </div>
    );
  }
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
  readonly retry: boolean;
  readonly onExecute: () => void;
  readonly restored: RestoredSettlement | null;
  readonly onReconcile: () => void;
}): ReactNode {
  const { settlement, stockTrade } = props;
  // No Stock reservation, no Stock trade: the model's choice alone is never a trade decision, and offers no settlement control.
  if (!stockTrade.authorized && !settlement.present) {
    const blocked = stockTrade.hold === "BLOCKED";
    const abstained = stockTrade.hold === "ABSTAINED";
    return (
      <section className="mw-proof" aria-label="Settlement">
        <div className="mw-proof__decision" data-outcome={blocked ? "blocked" : abstained ? "abstain" : "none"}>
          <p className="mw-kicker">{blocked ? "Blocked" : abstained ? "No action" : "Trade decision"}</p>
          <p className="mw-proof__main">{blocked ? "Blocked" : abstained ? "Stock Agent · No action" : "No authorized Stock trade"}</p>
          <p className="mw-fine">
            {abstained
              ? "The agent did not find an opportunity worth using its authority. Capital remains available."
              : stockTrade.hold === "RELEASED"
                ? "Stock allocation was released. "
                : blocked
                  ? "Mandate stopped this before execution. "
                  : null}
            {blocked || abstained ? null : "The Stock proposal did not receive execution authority. Only an authorized Stock action has a testnet settlement path."}
            {blocked ? "Nothing was broadcast." : null}
          </p>
          {blocked && stockTrade.blockCode !== null ? <p className="mw-fine">Reason: {reasonLabel(stockTrade.blockCode)}</p> : null}
          {blocked ? <p className="mw-fine">Wallet request: None · Transaction: None</p> : null}
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
        <p className="mw-kicker">{settlement.settled ? "Settled" : "Authorized action"}</p>
        <p className="mw-proof__main">{noteName}</p>
        <p className="mw-fine">Agent · Stock</p>
        {stockTrade.candidateId === null ? null : <p className="mw-fine">Agent selected <code>{stockTrade.candidateId}</code></p>}
        <p className="mw-fine">
          Authorized capital{" "}
          {stockTrade.amount === null ? (settlement.decisionNotional === null ? "—" : `${settlement.decisionNotional} USDC`) : usd(stockTrade.amount)}
        </p>
        {settlement.settled && settlement.fixtureIn !== null ? (
          <p className="mw-fine">Executed test amount shown in the settlement proof below.</p>
        ) : null}
      </div>
      <div className="mw-proof__chain">
        <p className="mw-kicker">Testnet settlement proof</p>
        {settlement.present ? (
          <>
            <p className="mw-proof__main">
              {settlement.network || "Robinhood Chain Testnet"}{" "}
              <Pill tone={settlement.settled ? "good" : settlement.txHash !== null && (settlement.stage === "FAILED" || settlement.stage === "RELEASED") ? "bad" : "warn"}>
                {proofLabel(settlement)}
              </Pill>
            </p>
            {settlement.fixtureIn === null ? null : (
              <p className="mw-proof__fixture">
                {settlement.fixtureIn} → {settlement.fixtureOut ?? "—"}
              </p>
            )}
            {settlement.txHash === null ? null : (
              <p className="mw-hash">
                Transaction <code title={settlement.txHash}>{shortHash(settlement.txHash)}</code>
                {settlement.block === null ? null : <span> · Block {settlement.block}</span>}
              </p>
            )}
            {settlement.gasUsed === null ? null : <p className="mw-fine">Gas used {settlement.gasUsed}</p>}
            {settlement.explorerUrl === null ? null : (
              <a className="mw-soft-button" href={settlement.explorerUrl} target="_blank" rel="noreferrer noopener">
                View transaction ↗
              </a>
            )}
            {settlement.stage === "SUBMITTED" ? <p className="mw-fine">Transaction submitted. A transaction hash is not settlement. Confirming…</p> : null}
            {settlement.stage === "SIMULATION_FAILED" ? <p className="mw-fine">Simulation failed. Nothing was sent.</p> : null}
            {settlement.stage === "FAILED" && settlement.txHash !== null ? <p className="mw-fine">Failed receipt. Never presented as LIVE_TESTNET. {failed || "Nothing was sent."}</p> : null}
            {settlement.stage === "FAILED" && settlement.txHash === null ? <p className="mw-fine">No transaction was submitted.</p> : null}
            {settlement.stage === "READY_FOR_SEND" ? <p className="mw-fine">Broadcast is disabled in this milestone: nothing was sent.</p> : null}
            {settlement.stage === "PREFLIGHT_FAILED" ? <p className="mw-fine">{failed || "Nothing was sent."}</p> : null}
            {detail !== "" && settlement.stage !== "FAILED" && settlement.stage !== "PREFLIGHT_FAILED" ? <p className="mw-fine">{failed || detail}</p> : null}
            {settlement.stage === "RECONCILING" ? <p className="mw-fine">Confirming… Nothing is resent.</p> : null}
            {settlement.stage === "HELD" ? <HeldNotice settlement={settlement} restored={props.restored} busy={props.busy} onReconcile={props.onReconcile} /> : null}
            {settlement.stage === "NEEDS_REVIEW" ? <p className="mw-fine">Settlement needs review. No retry was sent.</p> : null}
            {settlement.stage === "RELEASED" && settlement.txHash !== null ? <p className="mw-fine">Transaction failed or never executed. Nothing further was sent.</p> : null}
            {settlement.stage === "RELEASED" && settlement.txHash === null ? (
              <p className="mw-fine">Not executed. Authorization expired with nothing recorded onchain. It is never resent; start a new mandate to try again.</p>
            ) : null}
            {settlement.stage === "SUBMITTED" || settlement.stage === "RECONCILING" || settlement.stage === "FAILED" || settlement.stage === "NEEDS_REVIEW" ? (
              <ReconcileButton restored={props.restored} busy={props.busy} onReconcile={props.onReconcile} />
            ) : null}
            {settlement.settled ? (
              <ul className="mw-verify-list" aria-label="Verification">
                <li>Mandate verified</li>
                <li>Exact execution authorized</li>
                {settlement.commitmentRecorded ? <li>Execution commitment recorded onchain</li> : null}
                {settlement.consumed ? <li>Reservation consumed</li> : null}
                {settlement.evidence === null ? null : <li>Evidence {settlement.evidence}</li>}
              </ul>
            ) : null}
            {settlement.consumed && !settlement.settled ? <p className="mw-fine">Already settled. Nothing is resent.</p> : null}
            <AuthorityLines settlement={settlement} />
            {settlement.stage === "SPINE_READY" || settlement.settled || settlement.stage === "READY_FOR_SEND" ? <TechnicalDetails settlement={settlement} /> : null}
            <SettleActions settlement={settlement} offer={props.offer} busy={props.busy} capable={stockTrade.settlementCapable} walletOk={props.walletOk} retry={props.retry} onExecute={props.onExecute} />
          </>
        ) : (
          <>
            <p className="mw-proof__main">Not settled in this session</p>
            <p className="mw-fine">Mandate authorized this Stock action. Execute its testnet settlement proof when ready. The browser never sends transactions on its own.</p>
            <SettleActions settlement={settlement} offer={props.offer} busy={props.busy} capable={stockTrade.settlementCapable} walletOk={props.walletOk} retry={props.retry} onExecute={props.onExecute} />
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
  readonly conflict: SettlementRefusal | null;
  readonly retry: boolean;
  readonly onDetails: () => void;
  readonly onStartNew: () => void;
  readonly busy: boolean;
  readonly restored: RestoredSettlement | null;
  readonly onReconcile: () => void;
  readonly autonomousV3?: boolean;
}): ReactNode {
  const { review, settlement } = props;
  const v3 = props.autonomousV3 === true || props.offer.kind === "ready" && props.offer.spine === "V3";
  const heading = receiptHeading({ settled: settlement.settled, txHash: settlement.txHash, stage: settlement.stage, refused: props.conflict !== null });
  const tone =
    heading.title === "Settlement failed" || heading.title === "Settlement needs review" || heading.title === "Not sent" || heading.title === "Not executed"
      ? "bad"
      : heading.title === "Confirming" || heading.title === "Execution held"
        ? "warn"
        : "good";
  return (
    <div className="mw-receipt">
      <header className="mw-stage-head">
        <Pill tone={tone}>{heading.pill}</Pill>
        <h2>{heading.title === "Settled" ? "Settled" : heading.title}</h2>
        <p>
          {heading.title === "Not sent"
            ? "Mandate authorized the Stock action, but settlement was not started. Nothing was broadcast."
            : heading.title === "Execution held"
              ? "Mandate signed the exact execution, but chain state could not be verified. Nothing was sent."
              : settlement.settled
                ? "Authorization evidence above. Stock testnet settlement proof below when present."
                : `${review.authorizedCount} of ${review.evaluated} agents authorized${review.reserved === null ? "" : ` · ${usd(review.reserved)} authorized`}.`}
        </p>
      </header>

      <details className="mw-disclosure mw-receipt__agents" open={review.authorized.length + review.blockedItems.length + review.quiet.length > 1}>
        <summary>Agent outcomes</summary>
        <div className="mw-receipt__grid">
          <section aria-label="Agent outcomes list">
            <h3>Outcomes</h3>
            {review.authorized.length + review.blockedItems.length + review.quiet.length === 0 ? (
              <p className="mw-fine">Nothing.</p>
            ) : (
              <ul className="mw-rows">
                {review.authorized.map((item) => <OutcomeRow key={`auth-${item.role}`} item={item} />)}
                {review.blockedItems.map((item) => <OutcomeRow key={`block-${item.role}`} item={item} />)}
                {review.quiet.map((item) => <OutcomeRow key={`quiet-${item.role}`} item={item} />)}
              </ul>
            )}
            <p className="mw-fine">Authorization evidence is not settlement evidence. Only Stock has a live testnet settlement connector in this build.</p>
          </section>
        </div>
      </details>

      {v3 && settlement.settled ? (
        <section className="mw-authority-review" aria-label="V3 execution authority">
          <h3 className="mw-authority-review__title">Execution authority</h3>
          <p>Bounded V3 delegation</p>
          <p className="mw-fine">Wallet approval for this trade: None</p>
          <p className="mw-fine">Principal authorization: One reusable bounded mandate signature</p>
          <p className="mw-fine">Evidence: LIVE_TESTNET · Stock fixture only</p>
        </section>
      ) : null}
      {props.conflict === null || settlement.stage === "HELD" ? null : <RefusalNotice conflict={props.conflict} />}
      <SettlementProof
        settlement={settlement}
        stockTrade={props.stockTrade}
        sessionId={props.sessionId}
        offer={props.offer}
        busy={props.busy}
        walletOk={props.walletOk}
        retry={props.retry}
        onExecute={props.onExecute}
        restored={props.restored}
        onReconcile={props.onReconcile}
      />

      <footer className="mw-stage-foot mw-stage-foot--receipt">
        {settlement.explorerUrl === null ? null : (
          <a className="mw-soft-button" href={settlement.explorerUrl} target="_blank" rel="noreferrer noopener">
            View transaction
          </a>
        )}
        <button type="button" className="mw-cta" disabled={props.busy} onClick={props.onStartNew}>
          Start new mandate
        </button>
        <button type="button" className="mw-text-button" onClick={props.onDetails}>
          Review details
        </button>
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

export function FailedStage(props: {
  readonly failure: Failure;
  readonly onStartNew: () => void;
  readonly onAdjust: () => void;
  readonly busy: boolean;
  readonly children?: ReactNode;
}): ReactNode {
  const copy = FAILURE_COPY[props.failure];
  return (
    <div className="mw-failed" role="status">
      <header className="mw-stage-head">
        <Pill tone="bad">Stopped</Pill>
        <h2>{copy.title}</h2>
        <p>{copy.line}</p>
      </header>
      {props.children}
      <footer className="mw-stage-foot">
        <button type="button" className="mw-cta" disabled={props.busy} onClick={props.onStartNew}>
          Start new mandate
        </button>
        {props.failure === "PAUSED" ? null : (
          <button type="button" className="mw-soft-button" disabled={props.busy} onClick={props.onAdjust}>
            Edit mandate
          </button>
        )}
      </footer>
    </div>
  );
}
