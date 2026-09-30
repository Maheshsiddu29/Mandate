"use client";

import { useState, type ReactNode } from "react";

const CHECKS = [
  {
    id: "authentication",
    label: "Authentication",
    question: "This really is the agent.",
    result: "Passed. The signature matches the enrolled Stock Agent.",
    tone: "passed",
  },
  {
    id: "authorization",
    label: "Authorization",
    question: "The agent may perform this exact action.",
    result: "Blocked. The same agent is requesting an unapproved representation.",
    tone: "blocked",
  },
] as const;

export function WhyMandate(): ReactNode {
  const [active, setActive] = useState<(typeof CHECKS)[number]["id"]>("authorization");

  return (
    <section className="mandate-section page-container" id="security" aria-labelledby="security-title">
      <div className="mandate-section__heading mandate-section__heading--wide">
        <p className="mandate-kicker">Why Mandate</p>
        <h2 id="security-title">A real agent can still make a bad request.</h2>
        <p>
          Authentication answers whether the caller is the enrolled agent.
          Authorization answers whether that agent may perform this exact
          action. Mandate exists because the first check is not the second.
        </p>
      </div>

      <div className="authority-example">
        <p className="authority-example__request">
          <span>Request</span>
          Enrolled Stock Agent buys the cheaper same-ticker representation from an unknown issuer.
        </p>
        <div className="authority-example__checks" role="group" aria-label="Inspect the request">
          {CHECKS.map((check) => {
            const selected = active === check.id;
            return (
              <button
                key={check.id}
                type="button"
                className={`authority-check authority-check--${check.tone}`}
                aria-pressed={selected}
                onClick={() => setActive(check.id)}
              >
                <span>{check.label}</span>
                <strong>{check.question}</strong>
                <p>{selected ? check.result : "Select to inspect this check."}</p>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
