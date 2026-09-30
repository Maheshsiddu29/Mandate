import type { ReactNode } from "react";

const STEPS = [
  ["Principal", "The owner of the assets.", "Offchain"],
  ["Portfolio Mandate", "Budget, venues, issuers, and size limits.", "Offchain"],
  ["Agents", "Find opportunities. They do not settle.", "Offchain"],
  ["Mandate Room", "Proposals are compared and negotiated.", "Offchain"],
  ["Portfolio Verification", "The policy check before any child permission.", "Offchain"],
  ["Child Authorization", "A narrow permission for one exact action.", "Onchain"],
  ["Execution Gate", "Settlement can start only with that permission.", "Onchain"],
  ["Markets", "The venue that is allowed to settle.", "Onchain"],
  ["Receipt", "What was authorized, blocked, or released.", "Onchain"],
] as const;

export function AuthorityPipeline(): ReactNode {
  return (
    <section className="mandate-section page-container" id="how-mandate" aria-labelledby="pipeline-title">
      <div className="mandate-section__heading mandate-section__heading--wide">
        <p className="mandate-kicker">Authority pipeline</p>
        <h2 id="pipeline-title">Discovery stays offchain. Settlement does not.</h2>
        <p>
          Agents can search, reason, and negotiate without touching assets.
          Authorized settlement crosses the execution gate.
        </p>
      </div>

      <ol className="pipeline">
        {STEPS.map(([title, copy, lane], index) => (
          <li key={title} data-lane={lane.toLowerCase()}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <small>{lane}</small>
              <strong>{title}</strong>
              <p>{copy}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
