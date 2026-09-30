"use client";

import {
  agentFixtures,
  formatUsd,
  PORTFOLIO_BUDGET_USD,
  portfolioCandidate,
  statusLine,
  type AgentFixture,
  type AgentStatus,
} from "@/lib/mandate/contracts";
import { useReducedMotion } from "@/lib/motion";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

const FRAME_MS = 1700;

function frameAt(agent: AgentFixture, step: number): AgentStatus {
  const index = Math.min(step, agent.frames.length - 1);
  return agent.frames[index] ?? agent.finalStatus;
}

function statusClass(status: AgentStatus): string {
  return `agent-card__status agent-card__status--${status.toLowerCase().replaceAll(" ", "-")}`;
}

export function AgentPreview(): ReactNode {
  const prefersReducedMotion = useReducedMotion();
  const maxFrames = Math.max(...agentFixtures.map((agent) => agent.frames.length));
  const [step, setStep] = useState(prefersReducedMotion ? maxFrames : 0);
  const settled = step >= maxFrames - 1;

  useEffect(() => {
    if (prefersReducedMotion || settled) {
      return;
    }

    const timer = window.setTimeout(() => {
      setStep((current) => current + 1);
    }, FRAME_MS);

    return () => window.clearTimeout(timer);
  }, [prefersReducedMotion, settled, step]);

  return (
    <div className="agent-preview">
      <header className="agent-preview__mandate">
        <div>
          <p className="mandate-kicker">Portfolio Mandate</p>
          <strong>{formatUsd(PORTFOLIO_BUDGET_USD)}</strong>
        </div>
        <p>One principal. Five agents draw from the same authority layer.</p>
        <div className="allocation-bar" aria-hidden="true">
          {agentFixtures.map((agent) => (
            <span key={agent.id} style={{ flexGrow: agent.allocationUsd }} data-market={agent.id} />
          ))}
        </div>
      </header>

      <ol className="agent-status-legend" aria-label="Agent states">
        {["SEARCHING", "PROPOSING", "BLOCKED", "RENEGOTIATING", "AUTHORIZED", "SETTLED"].map(
          (status) => (
            <li key={status}>{status}</li>
          )
        )}
      </ol>

      <div className="agent-grid">
        {agentFixtures.map((agent) => {
          const status = frameAt(agent, step);
          return (
            <article className="agent-card" key={agent.id} aria-labelledby={`agent-${agent.id}`}>
              <p className="mandate-kicker">{agent.market}</p>
              <h3 id={`agent-${agent.id}`}>{agent.agent}</h3>
              <p className="agent-card__finding">{agent.finding}</p>
              <p className={statusClass(status)}>{statusLine(agent, status)}</p>
            </article>
          );
        })}
      </div>

      <div className="agent-bridge" aria-hidden="true">
        <svg viewBox="0 0 1000 72" preserveAspectRatio="none">
          {agentFixtures.map((agent, index) => {
            const start = 100 + index * 200;
            return (
              <path
                key={agent.id}
                d={`M${start} 0 C ${start} 36, 500 28, 500 72`}
              />
            );
          })}
        </svg>
        <span>Mandate</span>
      </div>

      <article className="portfolio-candidate" hidden={!settled} aria-live="polite">
        <p className="mandate-kicker">Final review</p>
        <h3>{portfolioCandidate.title}</h3>
        <p>{portfolioCandidate.summary}</p>
        <ul>
          <li>{portfolioCandidate.authorizedLabel}</li>
          <li>{portfolioCandidate.blockedLabel}</li>
          <li>{portfolioCandidate.releasedLabel}</li>
        </ul>
        <Link className="button button--primary focus-ring" href="/demo">
          Open the demo
        </Link>
      </article>
    </div>
  );
}
