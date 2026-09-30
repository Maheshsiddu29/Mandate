import { formatUsdc, groupDecimal, shortId, widthPercent, atomsOf } from "@/lib/mandate/formatting";
import { SCENE_COUNT } from "@/lib/mandate/timeline";
import type { AgentView, Presentation, RoomRoundView } from "@/lib/mandate/types";
import type { ReactNode } from "react";

function Status({ state }: { state: string }): ReactNode {
  const tone = state.toLowerCase().replaceAll(" ", "-");
  return <span className={`status-pill status-pill--${tone}`}>{state}</span>;
}

function AgentCard({ agent }: { agent: AgentView }): ReactNode {
  return (
    <article
      className={`agent-card${agent.inRoom ? " is-in-room" : ""}${agent.compromised ? " is-compromised" : ""}`}
      aria-label={`${agent.title}, ${agent.state}`}
    >
      <header>
        <p className="mandate-kicker">{agent.title.replace(" Agent", "")}</p>
        <Status state={agent.state} />
      </header>
      <h3>{agent.title}</h3>
      <p title={agent.id}>{shortId(agent.id)}</p>
      {agent.requested ? <p>Requested {formatUsdc(agent.requested)}</p> : null}
      {agent.reserved ? <p>Reserved {formatUsdc(agent.reserved)}</p> : null}
    </article>
  );
}

function AgentRow({ agents }: { agents: readonly AgentView[] }): ReactNode {
  return (
    <div className="agent-row">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  );
}

function ResourceBar({ presentation }: { presentation: Presentation }): ReactNode {
  const { resources } = presentation;
  if (resources.authority === null) return null;
  const authority = atomsOf(resources.authority);
  const requested = atomsOf(resources.requested);
  const reserved = atomsOf(resources.reserved);
  const over = resources.requested !== null && requested > authority;
  return (
    <section className="resource-bar" aria-label="Portfolio authority">
      <div className="resource-bar__labels">
        <span>
          Requested <strong>{formatUsdc(resources.requested)}</strong>
        </span>
        <span>
          Authority <strong>{formatUsdc(resources.authority)}</strong>
        </span>
        <span>
          Reserved <strong>{formatUsdc(resources.reserved)}</strong>
        </span>
        <span>
          Available <strong>{formatUsdc(resources.available)}</strong>
        </span>
      </div>
      <div className="resource-track" aria-hidden="true">
        <i
          className={over ? "is-over" : "is-reserved"}
          style={{ width: `${widthPercent(resources.reserved ? reserved : requested, authority)}%` }}
        />
      </div>
    </section>
  );
}

function stepLabel(kind: string): string {
  const labels: { readonly [key: string]: string } = {
    AGENT_REDUCTION_REQUESTED: "REDUCE REQUEST",
    AGENT_RELEASED_AUTHORITY: "RELEASES",
    AUTHORITY_REALLOCATED: "CLAIMS",
    AGENT_PROPOSAL_REDUCED: "REDUCED",
    PROPOSAL_ACCEPTED: "ACCEPTED",
  };
  return labels[kind] ?? kind;
}

function RoomRounds({ rounds }: { rounds: readonly RoomRoundView[] }): ReactNode {
  return (
    <ol className="room-rounds">
      {rounds.map((round) => (
        <li key={`${round.run}-${round.round}`} className="room-round">
          <h3>Round {round.round}</h3>
          <ol className="room-rounds">
            {round.steps.map((step) => (
              <li key={step.sequence} className="room-step">
                <strong>
                  {step.agentLabel ?? "Room"} · {stepLabel(step.kind)}
                  {step.approved ? ` ${formatUsdc(step.approved)}` : ""}
                  {step.from ? ` from ${step.from}` : ""}
                </strong>
                <p>{step.message}</p>
                {step.reasons.length > 0 ? (
                  <p>{step.reasons.map((reason) => reason.code).join(" · ")}</p>
                ) : null}
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

function SceneBody({ presentation }: { presentation: Presentation }): ReactNode {
  const { scene } = presentation;
  if (scene <= 1) {
    return (
      <>
        <p className="mandate-kicker">One principal</p>
        <h2>One Portfolio Mandate. Five agents.</h2>
        <p>
          Allocation {presentation.summary.allocationMode}. Authority {formatUsdc(presentation.summary.authority)}.
          Principal <span title={presentation.summary.principal}>{shortId(presentation.summary.principal)}</span>.
        </p>
        <AgentRow agents={presentation.agents} />
      </>
    );
  }

  if (scene === 2) {
    return (
      <>
        <h2>Agents search on their own.</h2>
        <AgentRow agents={presentation.agents} />
        <ul className="proposal-list">
          {presentation.blocked.map((proposal) => (
            <li key={proposal.proposal} className="proposal-card is-blocked is-outside">
              <p className="mandate-kicker">Security invalid · not in the Mandate Room</p>
              <h3>{proposal.title}</h3>
              <div className="fact-row">
                {proposal.facts.map((fact) => (
                  <span key={`${proposal.proposal}-${fact.label}`} className={fact.tone === "blocked" ? "is-blocked" : fact.tone === "warning" ? "is-warning" : undefined}>
                    <strong>{fact.label}</strong> {fact.value}
                  </span>
                ))}
              </div>
              <p>{proposal.reasons.map((reason) => reason.code).join(" · ")}</p>
              {presentation.admissible.some((item) => item.agentLabel === proposal.agentLabel && !item.conflict) ? (
                <p>Valid candidate continues.</p>
              ) : null}
            </li>
          ))}
        </ul>
      </>
    );
  }

  if (scene === 3) {
    return (
      <>
        <section className="conflict-banner">
          <p className="mandate-kicker">Resource conflict</p>
          <h2>Valid individual proposals. Portfolio over authority.</h2>
          <p>
            Admissible demand {formatUsdc(presentation.resources.requested)} against authority{" "}
            {formatUsdc(presentation.resources.authority)}. This is not a security block.
          </p>
          <p>Opening Mandate Room.</p>
        </section>
        <ResourceBar presentation={presentation} />
        <AgentRow agents={presentation.agents} />
      </>
    );
  }

  if (scene === 4 && presentation.room === null) {
    return (
      <>
        <h2>Opening Mandate Room.</h2>
        <p>The Room cannot create authority.</p>
        <AgentRow agents={presentation.agents} />
      </>
    );
  }

  if (scene === 4 && presentation.room) {
    return (
      <>
        <ResourceBar presentation={presentation} />
        <section className="room-panel" aria-label="Mandate Room">
          <p className="mandate-kicker">Mandate Room</p>
          <h2>Agents negotiate allocation.</h2>
          <p>The Room cannot create authority.</p>
          <div className="room-agents">
            {presentation.agents.filter((agent) => agent.inRoom).map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
          <RoomRounds rounds={presentation.room.rounds} />
          {presentation.room.proposed ? (
            <p>Room proposal {formatUsdc(presentation.room.proposed)}. Not yet authorized.</p>
          ) : null}
        </section>
        {presentation.blocked.length > 0 ? (
          <p className="judge-footnote">
            {presentation.blocked.length} security-invalid proposals stay outside the Room.
          </p>
        ) : null}
      </>
    );
  }

  if (scene === 5) {
    return (
      <>
        <section className="verifier-panel">
          <p className="mandate-kicker">Mandate verifier</p>
          <h2>{presentation.verification?.awaitingAuthorization ? "Room proposal. Not yet authorized." : "Portfolio authorized."}</h2>
          {presentation.verification ? (
            <>
              <p>
                {presentation.verification.passed} of {presentation.verification.total} checks {presentation.verification.status}.
              </p>
              <ul className="check-list">
                {presentation.verification.items.map((item) => (
                  <li key={item.id}>
                    <span>{item.check}</span>
                    <span className={item.result === "PASS" ? "is-pass" : "is-fail"}>{item.result}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>The verifier re-derives the portfolio from signed messages.</p>
          )}
          {presentation.reservedChildren !== null ? (
            <p>
              {presentation.reservedChildren} children reserved. {formatUsdc(presentation.resources.reserved)} /{" "}
              {formatUsdc(presentation.resources.authority)}.
            </p>
          ) : null}
        </section>
        {presentation.forgery ? (
          <details className="technical-receipt">
            <summary>Why can&apos;t the Room cheat?</summary>
            <p>{presentation.forgery.message}</p>
            <p>{presentation.forgery.reasons.map((reason) => reason.code).join(" · ")}</p>
          </details>
        ) : null}
        <ResourceBar presentation={presentation} />
      </>
    );
  }

  if (scene === 6 && presentation.attack === null) {
    return (
      <>
        <h2>Valid agent ≠ valid action</h2>
        <p>Same agent. Same key. The action is a different question.</p>
        <AgentRow agents={presentation.agents} />
      </>
    );
  }

  if (scene === 6 && presentation.attack) {
    const attack = presentation.attack;
    return (
      <>
        <section className="attack-panel">
          <p className="mandate-kicker">{presentation.agents.find((agent) => agent.id === attack.agentId)?.title} compromised</p>
          <h2>Valid agent ≠ valid action</h2>
          <p>Same agent. Same key. Valid signature. The action is a different question.</p>
          <div className="mutation">
            {attack.changes.map((change) => (
              <p key={change.field}>
                <span>{change.field}</span>
                <br />
                <s title={change.expected}>{shortId(change.expected)}</s>
                <br />
                <strong title={change.attempted}>{shortId(change.attempted)}</strong>
              </p>
            ))}
          </div>
          <dl className="attack-grid">
            <div>
              <dt>Agent signature</dt>
              <dd>{attack.signatureValid ? "VALID" : "INVALID"}</dd>
            </div>
            <div>
              <dt>Portfolio membership</dt>
              <dd>{attack.sameIdentity ? "VALID" : "INVALID"}</dd>
            </div>
            <div>
              <dt>Delegation</dt>
              <dd>{attack.capability}</dd>
            </div>
            <div>
              <dt>Recipient</dt>
              <dd>{attack.reasons.some((reason) => reason.code === "RECIPIENT_NOT_ALLOWED") ? "INVALID" : attack.action}</dd>
            </div>
            <div>
              <dt>Action</dt>
              <dd>{attack.action}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{attack.reasons.map((reason) => reason.code).join(" · ")}</dd>
            </div>
            <div>
              <dt>Reservations created</dt>
              <dd>{attack.reservationsWritten}</dd>
            </div>
            <div>
              <dt>Ledger attempts</dt>
              <dd>{attack.attemptsWritten}</dd>
            </div>
            <div>
              <dt>Executor calls</dt>
              <dd>{attack.executorCalls}</dd>
            </div>
            <div>
              <dt>Transactions</dt>
              <dd>{attack.transactions}</dd>
            </div>
          </dl>
          <p>Action blocked.</p>
        </section>
        <AgentRow agents={presentation.agents} />
      </>
    );
  }

  if (scene === 7 && presentation.isolation === null) {
    return (
      <>
        <h2>Portfolio remains active.</h2>
        <AgentRow agents={presentation.agents} />
      </>
    );
  }

  if (scene === 7 && presentation.isolation) {
    return (
      <>
        <section className="conflict-banner">
          <p className="mandate-kicker">Fault isolation</p>
          <h2>Portfolio remains active.</h2>
          <p>Bad action blocked. Healthy authority preserved. The compromised agent was not revoked.</p>
        </section>
        <ul className="reservation-list">
          {presentation.isolation.reservations.map((reservation) => (
            <li key={`${reservation.agent}-${reservation.phase}`}>
              <span>
                {reservation.agent} · {reservation.phase}
                {reservation.evidence ? ` · ${reservation.evidence}` : ""}
              </span>
              <span>{reservation.execution ?? ""}</span>
            </li>
          ))}
        </ul>
        <ResourceBar presentation={presentation} />
        <AgentRow agents={presentation.agents} />
      </>
    );
  }

  if (scene === 8 && presentation.compliant === null) {
    return (
      <>
        <h2>Same agent. Same key.</h2>
        <AgentRow agents={presentation.agents} />
      </>
    );
  }

  if (scene === 8 && presentation.compliant) {
    const compliant = presentation.compliant;
    return (
      <>
        <section className="attack-panel">
          <p className="mandate-kicker">Same agent. Same key.</p>
          <h2>{presentation.agents.find((agent) => agent.id === compliant.agentId)?.title}</h2>
          <dl className="attack-grid">
            <div>
              <dt>Recipient</dt>
              <dd title={compliant.recipient ?? ""}>{compliant.recipient ? shortId(compliant.recipient) : "—"}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>{formatUsdc(compliant.requested)}</dd>
            </div>
            <div>
              <dt>Result</dt>
              <dd>
                {compliant.executionStatus === "SETTLED"
                  ? `VERIFIED · RESERVED · SETTLED${compliant.evidence === "SIMULATED" ? " — SIMULATED" : ""}`
                  : compliant.executionStatus}
              </dd>
            </div>
            <div>
              <dt>Evidence</dt>
              <dd>
                {compliant.integrationEvidence ?? "—"} / {compliant.evidence ?? "—"}
              </dd>
            </div>
            <div>
              <dt>Portfolio</dt>
              <dd>
                {formatUsdc(compliant.reserved)} / {formatUsdc(presentation.summary.authority)}
              </dd>
            </div>
            <div>
              <dt>Transactions</dt>
              <dd>{compliant.transactions}</dd>
            </div>
          </dl>
        </section>
        <ResourceBar presentation={presentation} />
      </>
    );
  }

  if (scene === 9 && presentation.portfolioConflict === null) {
    return (
      <>
        <h2>Individually valid. Portfolio invalid.</h2>
        <AgentRow agents={presentation.agents} />
      </>
    );
  }

  if (scene === 9 && presentation.portfolioConflict) {
    const conflict = presentation.portfolioConflict;
    return (
      <>
        <section className="conflict-banner">
          <p className="mandate-kicker">Global portfolio conflict</p>
          <h2>{conflict.authorized ? "Portfolio valid." : "Individually valid. Portfolio invalid."}</h2>
          <dl className="attack-grid">
            <div>
              <dt>Agent screening</dt>
              <dd>{conflict.individuallyValid ? "PASS" : "FAIL"}</dd>
            </div>
            <div>
              <dt>Agent headroom</dt>
              <dd>{formatUsdc(conflict.headroom)}</dd>
            </div>
            <div>
              <dt>Individual action</dt>
              <dd>{conflict.individuallyValid ? "VALID" : "INVALID"}</dd>
            </div>
            <div>
              <dt>Portfolio available</dt>
              <dd>{formatUsdc(conflict.available)}</dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>{formatUsdc(conflict.requested)}</dd>
            </div>
            <div>
              <dt>Room target</dt>
              <dd>{formatUsdc(conflict.target)}</dd>
            </div>
          </dl>
          <p>{conflict.reasons.map((reason) => reason.code).join(" · ")}</p>
          {conflict.authorized ? (
            <p>
              Authorized {formatUsdc(conflict.reservedAfter)} / {formatUsdc(presentation.summary.authority)}.
            </p>
          ) : (
            <p>Back to the Mandate Room.</p>
          )}
        </section>
        {presentation.room ? <RoomRounds rounds={presentation.room.rounds} /> : null}
        {presentation.verification ? (
          <p>
            Verifier {presentation.verification.passed}/{presentation.verification.total} {presentation.verification.status}.
          </p>
        ) : null}
        <ResourceBar presentation={presentation} />
      </>
    );
  }

  if (scene < 10) {
    return (
      <>
        <h2>{presentation.sceneTitle}</h2>
        <AgentRow agents={presentation.agents} />
      </>
    );
  }

  return (
    <section className="receipt-panel">
      <p className="mandate-kicker">Portfolio receipt</p>
      <h2>What the mandate did.</h2>
      <p title={presentation.summary.principal}>Principal {shortId(presentation.summary.principal)}</p>
      <p title={presentation.summary.mandateDigest}>Portfolio Mandate {shortId(presentation.summary.mandateDigest)}</p>
      <dl className="receipt-grid">
        <div>
          <dt>Initial request</dt>
          <dd>{formatUsdc(presentation.summary.initialRequested)}</dd>
        </div>
        <div>
          <dt>Initial admissible demand</dt>
          <dd>{formatUsdc(presentation.summary.admissibleDemand)}</dd>
        </div>
        <div>
          <dt>First authorized portfolio</dt>
          <dd>{formatUsdc(presentation.firstReserved)}</dd>
        </div>
        <div>
          <dt>After compliant continuation</dt>
          <dd>{formatUsdc(presentation.compliantReserved)}</dd>
        </div>
        <div>
          <dt>Final</dt>
          <dd>
            {formatUsdc(presentation.resources.reserved)} / {formatUsdc(presentation.summary.authority)}
          </dd>
        </div>
        <div>
          <dt>Agents</dt>
          <dd>{presentation.summary.agentCount}</dd>
        </div>
        <div>
          <dt>Security-invalid proposals</dt>
          <dd>{presentation.securityInvalidCount}</dd>
        </div>
        <div>
          <dt>Adjustments</dt>
          <dd>{presentation.adjustmentCount}</dd>
        </div>
        <div>
          <dt>Transactions from malicious rejection</dt>
          <dd>{presentation.maliciousTransactions}</dd>
        </div>
      </dl>
      <p>Agents propose. Agents negotiate. Mandate authorizes. Markets settle.</p>
      <details className="technical-receipt">
        <summary>View technical receipt</summary>
        <ul className="receipt-facts">
          {presentation.receipts.map((receipt) => (
            <li key={receipt.digest}>
              <span>{receipt.run}</span>
              <span title={receipt.digest}>{shortId(receipt.digest)}</span>
            </li>
          ))}
        </ul>
        <pre>
          {presentation.receipts.map((receipt) => `${receipt.run}\n${receipt.digest}\n${receipt.mandateDigest}\n`).join("\n")}
        </pre>
      </details>
    </section>
  );
}

export function JudgeStage({ presentation }: { presentation: Presentation }): ReactNode {
  return (
    <div className="judge-stage">
      <p className="judge-now" aria-live="polite">
        {presentation.latest?.message ?? "Judge mode. The transcript is ready. Start the demo when you are."}
      </p>
      <SceneBody presentation={presentation} />
      <p className="judge-footnote">
        Scene {presentation.scene} / {SCENE_COUNT}. Event {presentation.position} / {presentation.eventCount}. Playback does not
        re-run Mandate.
      </p>
    </div>
  );
}

export function EvidencePanel({ presentation }: { presentation: Presentation }): ReactNode {
  return (
    <aside className="evidence-panel" aria-label="Evidence">
      <h2>Evidence</h2>
      <p>Historical LIVE_TESTNET stays on the recorded Robinhood execution. Fixture evidence is not a live market.</p>
      {presentation.evidence.length === 0 ? (
        <p>Evidence labels appear from the transcript as the demo reaches them.</p>
      ) : (
        presentation.evidence.map((item) => (
          <article key={item.domain} className={`evidence-card${item.historicalLive ? " is-historical" : " is-fixture"}`}>
            <header>
              <strong>{item.title}</strong>
              <span>{item.integrationEvidence}</span>
            </header>
            <p>This run {item.thisRun.length === 0 ? "—" : item.thisRun.join(" · ")}</p>
            {item.historicalLive ? (
              <ul>
                <li>Historical evidence LIVE_TESTNET</li>
                <li>Current judge-demo child OFFCHAIN_ONLY</li>
                <li>{item.chainName}</li>
                <li>Chain ID {item.chainId}</li>
                <li title={item.gate ?? ""}>Gate {item.gate ? shortId(item.gate) : "—"}</li>
                <li>BUY {item.buyQuantity}</li>
                <li>Gas {item.buyGas ? groupDecimal(item.buyGas) : "—"}</li>
                <li>Replay {item.replayRevert}</li>
                <li>Amount mutation {item.mutationRevert}</li>
                <li>Over-budget transactions {item.overBudgetTransactions}</li>
                {item.explorer ? (
                  <li>
                    <a href={item.explorer} target="_blank" rel="noreferrer">
                      Explorer
                    </a>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </article>
        ))
      )}
    </aside>
  );
}
