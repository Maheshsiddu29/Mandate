import { judgeDemoProvider } from "@/lib/mandate/browser-provider";
import { formatUsdc } from "@/lib/mandate/formatting";
import { finalEvidence } from "@/lib/mandate/normalize";
import Link from "next/link";
import type { ReactNode } from "react";

export function AgentPreview(): ReactNode {
  const presentation = judgeDemoProvider.present(judgeDemoProvider.transcript.events.length);
  const beats = [
    ["Requested", formatUsdc(presentation.summary.initialRequested)],
    ["Mandate Room", "Agents negotiate"],
    ["Authorized", formatUsdc(presentation.firstReserved)],
    ["Malicious action", "Blocked"],
    ["Healthy agents", "Continue"],
    ["Final", `${formatUsdc(presentation.resources.reserved)} / ${formatUsdc(presentation.summary.authority)}`],
  ] as const;

  return (
    <div className="agent-preview">
      <header className="agent-preview__mandate">
        <div>
          <p className="mandate-kicker">Portfolio Mandate</p>
          <strong>{formatUsdc(presentation.summary.authority)}</strong>
        </div>
        <p>
          One principal. {presentation.summary.agentCount} agents. Allocation {presentation.summary.allocationMode}.
        </p>
      </header>
      <ol className="story-beats">
        {beats.map(([label, value]) => (
          <li key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </li>
        ))}
      </ol>
      <div className="agent-grid">
        {presentation.agents.map((agent) => (
          <article className="agent-card" key={agent.id}>
            <p className="mandate-kicker">{agent.title.replace(" Agent", "")}</p>
            <h3>{agent.title}</h3>
          </article>
        ))}
      </div>
      <Link className="button button--primary focus-ring" href="/demo">
        Launch Demo
      </Link>
    </div>
  );
}

export function IntegrationRoster(): ReactNode {
  const evidence = finalEvidence(judgeDemoProvider.transcript);
  return (
    <div className="integration-grid">
      {evidence.map((item) => (
        <article key={item.domain} className="integration-card" data-live={item.historicalLive ? "true" : "false"}>
          <p className="integration-card__status">
            {item.historicalLive ? `Historical ${item.integrationEvidence}` : item.integrationEvidence}
            {item.thisRun.length > 0 ? ` · this run ${item.thisRun.join(", ")}` : ""}
          </p>
          <h3>{item.title}</h3>
          <p>{item.integration}</p>
        </article>
      ))}
    </div>
  );
}
