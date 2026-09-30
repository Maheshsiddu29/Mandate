"use client";

import {
  DEMO_STAGES,
  PORTFOLIO_BUDGET_USD,
  agentFixtures,
  demoReceipt,
  formatUsd,
  portfolioCandidate,
  statusLine,
  type DemoStageId,
} from "@/lib/mandate/contracts";
import { useReducedMotion } from "@/lib/motion";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import "./mandate-demo.css";

const VERIFICATION = [
  ["Stock representation", "Blocked", "representation not authorized"],
  ["Swap venue", "Blocked", "venue not authorized"],
  ["Yield issuer", "Blocked", "issuer not authorized"],
  ["NFT opportunity", "Released", "no compliant opportunity"],
  ["Perps exposure", "Authorized", "reduced from $400 to $250"],
] as const;

const RECEIPT_LINES = [
  `Mandate ${demoReceipt.mandateId}`,
  `Child authorization ${demoReceipt.childAuthorizationId}`,
  "Perps sleeve authorized at $250",
  "Stock, Swap, and Yield blocked",
  "NFT allocation released",
  demoReceipt.disclaimer,
] as const;

function StageBody({ stage }: { stage: DemoStageId }): ReactNode {
  if (stage === "mandate") {
    return (
      <>
        <h2>Portfolio Mandate</h2>
        <p>One principal sets a {formatUsd(PORTFOLIO_BUDGET_USD)} budget and the rules agents cannot cross.</p>
        <ul>
          <li>Approved issuers, venues, and representations only.</li>
          <li>Perps exposure has a size cap.</li>
          <li>A matching ticker is not enough to pass.</li>
        </ul>
      </>
    );
  }

  if (stage === "agents") {
    return (
      <>
        <h2>Five agents</h2>
        <p>Each agent searches one market. None of them can settle.</p>
        <ul>
          {agentFixtures.map((agent) => (
            <li key={agent.id}>
              <strong>{agent.agent}</strong>
              {agent.finding}
            </li>
          ))}
        </ul>
      </>
    );
  }

  if (stage === "room") {
    return (
      <>
        <h2>Mandate Room</h2>
        <p>Proposals arrive together. Mandate reads the action, not the agent’s confidence.</p>
        <ul>
          {agentFixtures.map((agent) => (
            <li key={agent.id}>
              <strong>{agent.agent}</strong>
              {statusLine(agent, agent.finalStatus)}
            </li>
          ))}
        </ul>
      </>
    );
  }

  if (stage === "negotiation") {
    return (
      <>
        <h2>Negotiation</h2>
        <p>Only the perps request can be reshaped. The blocked proposals do not become eligible by changing price.</p>
        <ul>
          <li>Perps exposure moves from $400 to $250, inside the policy cap.</li>
          <li>Stock, Swap, and Yield remain blocked.</li>
          <li>The NFT agent releases its allocation.</li>
        </ul>
      </>
    );
  }

  if (stage === "proposal") {
    return (
      <>
        <h2>{portfolioCandidate.title}</h2>
        <p>{portfolioCandidate.summary}</p>
        <ul>
          <li>{portfolioCandidate.authorizedLabel}</li>
          <li>{portfolioCandidate.blockedLabel}</li>
          <li>{portfolioCandidate.releasedLabel}</li>
        </ul>
      </>
    );
  }

  if (stage === "verification") {
    return (
      <>
        <h2>Policy verification</h2>
        <p>Each line is a separate check. A pass on identity does not waive the others.</p>
        <ul>
          {VERIFICATION.map(([check, result, detail]) => (
            <li key={check}>
              <strong>{result}</strong>
              {check}. {detail}
            </li>
          ))}
        </ul>
      </>
    );
  }

  if (stage === "execution") {
    return (
      <>
        <h2>Authorized execution</h2>
        <p>One child authorization is ready for the execution gate. This demo does not submit it to a venue.</p>
        <ul>
          <li>Child authorization {demoReceipt.childAuthorizationId}</li>
          <li>Action: perps sleeve, {formatUsd(250)}</li>
          <li>Gate: closed until a later settlement integration accepts it.</li>
        </ul>
      </>
    );
  }

  return <Receipt />;
}

function Receipt(): ReactNode {
  const prefersReducedMotion = useReducedMotion();
  const [count, setCount] = useState(prefersReducedMotion ? RECEIPT_LINES.length : 1);

  useEffect(() => {
    if (prefersReducedMotion || count >= RECEIPT_LINES.length) {
      return;
    }
    const timer = window.setTimeout(() => setCount((current) => current + 1), 700);
    return () => window.clearTimeout(timer);
  }, [count, prefersReducedMotion]);

  return (
    <>
      <h2>Receipt {demoReceipt.id}</h2>
      <ol className="demo-receipt">
        {RECEIPT_LINES.slice(0, count).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
    </>
  );
}

export function MandateDemo(): ReactNode {
  const prefersReducedMotion = useReducedMotion();
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);
  const stage = DEMO_STAGES[active];

  const finished = active >= DEMO_STAGES.length - 1;

  useEffect(() => {
    if (!playing || prefersReducedMotion || finished) {
      return;
    }
    const timer = window.setTimeout(() => {
      setActive((current) => Math.min(current + 1, DEMO_STAGES.length - 1));
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [active, finished, playing, prefersReducedMotion]);

  if (!stage) {
    return null;
  }

  function select(index: number): void {
    setPlaying(false);
    setActive(index);
  }

  function onTabsKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const last = DEMO_STAGES.length - 1;
    let next = active;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      next = Math.min(last, active + 1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = Math.max(0, active - 1);
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = last;
    } else {
      return;
    }
    event.preventDefault();
    select(next);
    document.getElementById(`demo-tab-${DEMO_STAGES[next]?.id ?? "mandate"}`)?.focus();
  }

  return (
    <main id="main-content" className="route-main mandate-demo">
      <div className="page-container">
        <header className="mandate-demo__intro">
          <p className="mandate-kicker">Demo</p>
          <h1>One mandate. Five proposals. One receipt.</h1>
          <p>
            Scripted walkthrough of a single portfolio review. No wallet prompt
            and no live order. Robinhood Chain is a testnet integration. NFT
            Market and Yield are fixtures, not live markets.
          </p>
        </header>

        <div className="mandate-demo__layout">
          <div
            className="mandate-demo__tabs"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Demo stages"
            onKeyDown={onTabsKeyDown}
          >
            {DEMO_STAGES.map((item, index) => (
              <button
                key={item.id}
                id={`demo-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={index === active}
                aria-controls={`demo-panel-${item.id}`}
                tabIndex={index === active ? 0 : -1}
                className="focus-ring"
                onClick={() => select(index)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                {item.label}
              </button>
            ))}
          </div>

          <section
            id={`demo-panel-${stage.id}`}
            className="mandate-demo__panel"
            role="tabpanel"
            aria-labelledby={`demo-tab-${stage.id}`}
            tabIndex={0}
          >
            <div className="mandate-demo__controls">
              <button
                type="button"
                className="button button--secondary focus-ring"
                onClick={() => {
                  if (finished) {
                    setActive(0);
                    setPlaying(true);
                    return;
                  }
                  setPlaying((current) => !current);
                }}
                disabled={prefersReducedMotion}
              >
                {playing && !finished ? "Pause" : "Play review"}
              </button>
              <button
                type="button"
                className="button button--secondary focus-ring"
                onClick={() => select(Math.max(0, active - 1))}
                disabled={active === 0}
              >
                Back
              </button>
              <button
                type="button"
                className="button button--primary focus-ring"
                onClick={() => select(Math.min(DEMO_STAGES.length - 1, active + 1))}
                disabled={active === DEMO_STAGES.length - 1}
              >
                Next
              </button>
            </div>
            <StageBody stage={stage.id} />
          </section>
        </div>
      </div>
    </main>
  );
}
