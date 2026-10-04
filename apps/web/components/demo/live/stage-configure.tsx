"use client";

import { LatticeLoader } from "@/components/react-bits/lattice-loader";
import { useState, type ReactNode } from "react";
import { type AuthorityReviewModel } from "./authority-review";
import { arr, rec, str, type Json, type JsonRecord } from "./live-client";
import { allocationSummary, ROLE_DESCRIPTORS, ROLE_TITLES, ROLES, usd, type RoleName } from "./live-model";
import { APPROVAL_CHAIN, shortAddress } from "./wallet";
import { AgentGlyph, Pill } from "./workspace-ui";

export interface DraftAccess {
  readonly draft: JsonRecord;
  readonly text: (path: string) => string;
  readonly ids: (path: string) => readonly string[] | null;
  readonly enabled: (role: RoleName) => boolean | null;
  readonly source: (path: string) => string | null;
}

/** The signed or draft capital, labelled so a portfolio total is not read as one agent's ceiling. */
export function mandateSummary(access: DraftAccess, signed: boolean): string {
  const total = access.text("portfolio.totalCapital");
  const enabled = ROLES.filter((role) => access.enabled(role) === true);
  const head = `${total === "" ? "—" : usd(total)} ${signed ? "authorized" : "draft"} · ${enabled.length} ${enabled.length === 1 ? "agent" : "agents"}`;
  // Prefer the current plan (budget) over the envelope ceiling so the trail never calls a maximum "allocated".
  const distinct = enabled
    .map((role) => {
      const plan = access.text(`agents.${role}.budget`);
      const max = access.text(`agents.${role}.maxAllocation`);
      if (plan !== "") return { role, amount: plan, kind: "planned" as const };
      if (max !== "") return { role, amount: max, kind: "max" as const };
      return null;
    })
    .filter((item): item is { role: RoleName; amount: string; kind: "planned" | "max" } => item !== null && item.amount !== total);
  if (distinct.length === 0) return head;
  return `${head} · ${distinct.map((item) => `${ROLE_TITLES[item.role]} ${usd(item.amount)} ${item.kind === "planned" ? "planned" : "max"}`).join(", ")}`;
}

export function draftAccess(draft: JsonRecord): DraftAccess {
  const at = (path: string): Json | undefined => {
    const [section, first, second] = path.split(".");
    const level = rec(draft[section ?? ""]);
    return second === undefined ? level[first ?? ""] : rec(level[first ?? ""])[second];
  };
  return {
    draft,
    text: (path) => {
      const value = at(path);
      return typeof value === "string" ? value : "";
    },
    ids: (path) => {
      const value = at(path);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
    },
    enabled: (role) => {
      const value = rec(rec(draft.agents)[role]).enabled;
      return typeof value === "boolean" ? value : null;
    },
    source: (path) => {
      const value = rec(draft.provenance)[path];
      return typeof value === "string" ? value : null;
    },
  };
}

/** Commit a text field on blur or Enter. Keyed by the server value, so a server change resets it. */
function FieldInput({ value, label, prefix, placeholder, disabled, onCommit, inputMode = "decimal" }: { readonly value: string; readonly label: string; readonly prefix?: string | undefined; readonly placeholder?: string; readonly disabled: boolean; readonly onCommit: (value: string | null) => void; readonly inputMode?: "decimal" | "numeric" }): ReactNode {
  const [draft, setDraft] = useState(value);
  const commit = (): void => {
    if (draft.trim() !== value) onCommit(draft.trim() === "" ? null : draft.trim());
  };
  return (
    <label className="mw-input">
      <span className="mw-sr">{label}</span>
      {prefix === undefined ? null : <span className="mw-input__prefix" aria-hidden="true">{prefix}</span>}
      <input
        value={draft}
        inputMode={inputMode}
        placeholder={placeholder ?? "Not set"}
        disabled={disabled}
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

function AgentConfigRow({ role, access, busy, onField }: { readonly role: RoleName; readonly access: DraftAccess; readonly busy: boolean; readonly onField: (path: string, value: Json) => void }): ReactNode {
  const enabled = access.enabled(role);
  const max = access.text(`agents.${role}.maxAllocation`);
  const plan = access.text(`agents.${role}.budget`);
  const showPlan = plan !== "" && plan !== max;
  return (
    <li className="mw-agent-config" data-role={role} data-enabled={enabled === true ? "on" : enabled === false ? "off" : "unset"}>
      <span className="mw-glyph"><AgentGlyph role={role} /></span>
      <span className="mw-agent-config__name">
        <strong>{ROLE_TITLES[role]}</strong>
        <span>{enabled === false ? "No authority · cannot propose" : ROLE_DESCRIPTORS[role]}</span>
        {enabled === true && showPlan ? <span className="mw-agent-config__plan">{usd(plan)} planned</span> : null}
      </span>
      {enabled === false ? (
        <span className="mw-agent-config__off">—</span>
      ) : (
        <span className="mw-agent-config__amount">
          <span className="mw-agent-config__hint" aria-hidden="true">Up to</span>
          <FieldInput key={max} value={max} label={`${ROLE_TITLES[role]} maximum authority in USDC`} prefix="$" disabled={busy} onCommit={(value) => onField(`agents.${role}.maxAllocation`, value)} />
        </span>
      )}
      <button
        type="button"
        role="switch"
        className="mw-switch"
        aria-checked={enabled === true}
        aria-label={`${ROLE_TITLES[role]} agent ${enabled === null ? "(not set)" : ""}`.trim()}
        data-unset={enabled === null ? "" : undefined}
        disabled={busy}
        onClick={() => onField(`agents.${role}.enabled`, enabled !== true)}
      >
        <span />
      </button>
    </li>
  );
}

function Allocation({ access }: { readonly access: DraftAccess }): ReactNode {
  const enabled = ROLES.filter((role) => access.enabled(role) === true);
  const summary = allocationSummary({
    capital: access.text("portfolio.totalCapital") || null,
    maxDeployed: access.text("portfolio.maxDeployed") || null,
    ceilings: enabled.map((role) => access.text(`agents.${role}.maxAllocation`) || null),
  });
  const reserve = access.text("portfolio.minUnallocated");
  const capital = access.text("portfolio.totalCapital");
  const deployable = summary.deployable === null ? null : usd(String(summary.deployable));
  return (
    <section className="mw-allocation" aria-label="Capital allocation">
      <div className="mw-allocation__row">
        <span className="mw-allocation__label">Allocation</span>
        <span className="mw-allocation__value">
          {summary.ceilings !== null && deployable !== null ? <><strong>{usd(String(summary.ceilings))}</strong> {summary.oversubscribed ? "of agent ceilings" : `of ${deployable}`}</> : <span className="mw-muted">Set each enabled agent&apos;s ceiling</span>}
        </span>
      </div>
      <div className="mw-meter" data-over={summary.oversubscribed ? "" : undefined} role="img" aria-label={summary.oversubscribed ? "Agent ceilings exceed deployable capital" : `${Math.round(summary.fill * 100)} percent of deployable capital assigned`}>
        <span style={{ width: `${(summary.oversubscribed ? 1 : summary.fill) * 100}%` }} />
      </div>
      <p className="mw-allocation__note">
        {deployable === null ? "Capital is not set yet." : summary.oversubscribed
          ? `Ceilings add up to more than the ${deployable} you deploy. Mandate holds that line; agents re-divide capital only if you allow it.`
          : summary.unassigned !== null ? `${usd(String(summary.unassigned))} not assigned to any agent.` : `${deployable} deployable.`}
        {reserve !== "" && reserve !== "0" ? ` Keeps ${usd(reserve)} unallocated.` : ""}
      </p>
      <p className="mw-allocation__meta">
        <span>Capital {capital === "" ? "not set" : usd(capital)}</span>
        <span>Derivatives {access.text("portfolio.maxDerivative") === "" ? "not set" : `≤ ${usd(access.text("portfolio.maxDerivative"))}`}</span>
      </p>
    </section>
  );
}

export function ConfigureStage(props: {
  readonly prompt: string;
  readonly access: DraftAccess;
  readonly notes: readonly string[];
  readonly blocking: readonly JsonRecord[];
  readonly draftIssues: readonly JsonRecord[];
  readonly ready: boolean;
  readonly busy: boolean;
  readonly amending: number | null;
  readonly notice: string;
  readonly onField: (path: string, value: Json) => void;
  readonly onFill: () => void;
  readonly onResolve: (index: number) => void;
  readonly onPermissions: () => void;
  readonly onTrade: () => void;
  readonly onStartOver: () => void;
  /** Mandate Room V2: agent selection, "Your allocation", or "Ask agents for a split". Replaces the ceiling summary. */
  readonly allocation?: ReactNode;
}): ReactNode {
  const missing = props.blocking.filter((issue) => str(issue.code) === "MISSING_VALUE");
  const other = props.blocking.filter((issue) => str(issue.code) !== "MISSING_VALUE");
  const open = props.blocking.length + props.draftIssues.length;
  return (
    <div className="mw-config">
      {props.prompt === "" ? null : <p className="mw-you"><span className="mw-you__label">You</span>{props.prompt}</p>}
      <header className="mw-stage-head mw-stage-head--split">
        <div>
          <p className="mw-kicker">{props.amending === null ? "Draft mandate" : `Amending · draft V${props.amending}`}</p>
          <h2>Your agent team</h2>
          <p>You decide which agents may act and how much each may use. Mandate decides what actually executes.</p>
        </div>
        <button type="button" className="mw-ghost-button" onClick={props.onPermissions}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
          Advanced permissions
        </button>
      </header>

      <ul className="mw-agent-config-list" aria-label="Agents">
        {ROLES.map((role) => <AgentConfigRow key={role} role={role} access={props.access} busy={props.busy} onField={props.onField} />)}
      </ul>

      {props.allocation ?? <Allocation access={props.access} />}

      {open > 0 ? (
        <section className="mw-open" aria-label="Open choices">
          <div className="mw-open__head">
            <div>
              <strong>{open} {open === 1 ? "choice" : "choices"} still open</strong>
              <span>Mandate never fills a missing limit on its own.</span>
            </div>
            {missing.length > 0 ? <button type="button" className="mw-soft-button" disabled={props.busy} onClick={props.onFill}>Use balanced defaults</button> : null}
          </div>
          {other.length > 0 || props.draftIssues.length > 0 ? (
            <ul className="mw-open__list">
              {other.map((issue, index) => <li key={`v${index}`}>{str(issue.message)}</li>)}
              {props.draftIssues.map((issue, index) => (
                <li key={`d${index}`}>
                  {str(issue.text)}
                  <button type="button" className="mw-text-button" onClick={() => props.onResolve(index)}>Mark resolved</button>
                </li>
              ))}
            </ul>
          ) : null}
          {missing.length > 0 ? (
            <details className="mw-disclosure">
              <summary>See what&apos;s missing</summary>
              <ul className="mw-open__list">{missing.map((issue, index) => <li key={index}>{str(issue.message)}</li>)}</ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {props.notes.length > 0 ? <p className="mw-fine">{props.notes.join(" ")}</p> : null}
      {props.notice === "" ? null : <p className="mw-notice" role="status">{props.notice}</p>}

      <footer className="mw-stage-foot">
        <button type="button" className="mw-cta" disabled={!props.ready || props.busy} onClick={props.onTrade}>Review &amp; Trade</button>
        <p className="mw-fine">{props.ready ? "You approve once. Agents then work inside these limits." : "Resolve the open choices to continue."}</p>
        <button type="button" className="mw-text-button" onClick={props.onStartOver}>Start over</button>
      </footer>
    </div>
  );
}

/** The browser wallet as the review step sees it; null address: not connected. */
export interface WalletState {
  readonly available: boolean;
  readonly address: string | null;
  readonly chainId: number | null;
}

export function ApproveStage(props: {
  readonly review: AuthorityReviewModel;
  readonly expected: string;
  readonly authorizing: boolean;
  readonly error: string;
  readonly wallet: WalletState;
  /** When "V3", disclose autonomous settlement before the one Mandate signature. */
  readonly spine?: "V2" | "V3";
  readonly onConnect: () => void;
  readonly onSwitchChain: () => void;
  readonly onSignWallet: () => void;
  readonly onAuthorize: (confirmation: string) => void;
  readonly onCancel: () => void;
  readonly onEditPermissions: () => void;
  readonly onChooseTotal: (total: string) => void;
  readonly onAcknowledgeUnsupported: (index: number) => void;
}): ReactNode {
  const [confirmation, setConfirmation] = useState("");
  const v3 = props.spine === "V3";
  const [method, setMethod] = useState<"wallet" | "demo">(props.wallet.available || v3 ? "wallet" : "demo");
  const version = props.expected.replace("AUTHORIZE MANDATE ", "");
  const matches = confirmation === props.expected && props.expected !== "—";
  const wallet = props.wallet;
  const connected = wallet.address !== null;
  const rightChain = wallet.chainId === APPROVAL_CHAIN.chainId;
  const reviewClean = props.review.canAuthorize;
  const signingMethod = v3 ? "wallet" : method;
  const walletReady = signingMethod === "wallet" && connected && rightChain && reviewClean;
  const demoReady = matches && reviewClean;
  const r = props.review;
  const groups = [...new Set(r.advanced.map((row) => row.group))];
  return (
    <div className="mw-approve">
      <header className="mw-stage-head">
        <p className="mw-kicker">{v3 ? "AUTHORIZE AUTONOMOUS MANDATE" : "You're authorizing"}</p>
        <h2>{v3 ? "Authorize autonomous mandate" : "Mandate review"}</h2>
        <p>
          {v3
            ? "Your wallet signs this authority once. Mandate independently verifies each action. Allowed Stock actions may settle without another wallet approval."
            : "This is the exact authority your wallet will sign. Agents cannot exceed it."}
        </p>
      </header>

      {r.blockers.length > 0 ? (
        <section className="mw-review-blockers" aria-labelledby="review-blockers-title" role="status">
          <h3 id="review-blockers-title">{r.blockerSummary}</h3>
          <ul>
            {r.blockers.map((b) => (
              <li key={b.id}>{b.text}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {r.conflicts.length > 0 ? (
        <section className="mw-review-needs" data-kind="needs" aria-labelledby="review-conflicts-title">
          <h3 id="review-conflicts-title">Needs input</h3>
          {r.conflicts.map((c) => (
            <div key={c.index} className="mw-review-needs__card">
              <p className="mw-review-needs__kind">Conflict</p>
              <p>{c.text}</p>
              {c.capitalChoices === null ? null : (
                <div className="mw-review-needs__actions">
                  <span className="mw-fine">Which total should Mandate authorize?</span>
                  {c.capitalChoices.map((choice) => (
                    <button key={choice} type="button" className="mw-soft-button" disabled={props.authorizing} onClick={() => props.onChooseTotal(choice)}>
                      ${choice}
                    </button>
                  ))}
                  <button type="button" className="mw-text-button" disabled={props.authorizing} onClick={props.onEditPermissions}>
                    Edit manually
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      ) : null}

      {r.ambiguities.length > 0 || r.clarifications.length > 0 ? (
        <section className="mw-review-needs" data-kind="needs" aria-labelledby="review-ambiguity-title">
          <h3 id="review-ambiguity-title">Needs input</h3>
          {[...r.ambiguities, ...r.clarifications].map((c) => (
            <div key={c.index} className="mw-review-needs__card">
              <p className="mw-review-needs__kind">{c.kind === "AMBIGUOUS" ? "Ambiguous" : "Needs clarification"}</p>
              <p>{c.text}</p>
              <button type="button" className="mw-soft-button" disabled={props.authorizing} onClick={props.onEditPermissions}>
                Edit permissions
              </button>
            </div>
          ))}
        </section>
      ) : null}

      {r.unsupported.length > 0 ? (
        <section className="mw-review-unsupported" aria-labelledby="review-unsupported-title">
          <h3 id="review-unsupported-title">Requested but not enforceable in this mandate version</h3>
          <ul>
            {r.unsupported.map((u) => (
              <li key={u.index} data-kind={u.dangerous ? "refused" : "unsupported"}>
                <div>
                  <strong>{u.dangerous ? "Refused" : "Not supported"}</strong>
                  <p>{u.text}</p>
                  <p className="mw-fine">
                    {u.dangerous
                      ? "Execution recipient and trusted settlement details cannot be set from natural-language mandate text."
                      : "This restriction is not included in the signed mandate."}
                  </p>
                </div>
                {u.dangerous ? (
                  <p className="mw-fine">Cannot authorize. Change the prompt.</p>
                ) : (
                  <button type="button" className="mw-soft-button" disabled={props.authorizing} onClick={() => props.onAcknowledgeUnsupported(u.index)}>
                    I understand — continue without this
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mw-authority-review" aria-label="Authority that will be signed">
        <h3 className="mw-authority-review__title">Portfolio authority</h3>
        <p className="mw-authority-review__capital">
          {r.total === "" ? "—" : usd(r.total)} <span className="mw-authority-review__currency">{r.currency}</span>
        </p>
        {r.totalProvenance === null ? null : <p className="mw-provenance">{r.totalProvenance}</p>}
        <dl className="mw-authority-review__meta">
          {r.maxDeployable === null || r.maxDeployable === "" ? null : (
            <div>
              <dt>Maximum initially deployable</dt>
              <dd>{usd(r.maxDeployable)}</dd>
            </div>
          )}
          {r.minUnallocated === null || r.minUnallocated === "" ? null : (
            <div>
              <dt>Minimum kept available</dt>
              <dd>{usd(r.minUnallocated)}</dd>
            </div>
          )}
        </dl>

        <h3 className="mw-authority-review__title">Agents</h3>
        <ul className="mw-authority-review__agents">
          {r.agents.map((agent) => (
            <li key={agent.role} data-enabled={agent.state === "ENABLED" ? "on" : agent.state === "DISABLED" ? "off" : "unset"}>
              <strong>{agent.title}</strong>
              <span>{agent.stateLabel}</span>
              <span>{agent.authorityLabel}</span>
              {agent.provenanceLabel === null ? null : <span className="mw-provenance">{agent.provenanceLabel}</span>}
            </li>
          ))}
        </ul>

        <h3 className="mw-authority-review__title">{r.allocation.headline === "Current plan" ? "Current plan" : "Allocation"}</h3>
        <p className="mw-authority-review__alloc">
          <strong>{r.allocation.headline}</strong>
          <span>{r.allocation.detail}</span>
        </p>
        {r.allocation.lines.length === 0 ? null : (
          <ul className="mw-authority-review__alloc-lines">
            {r.allocation.lines.map((line) => (
              <li key={`plan-${line.label}`}>
                <span>{line.label}</span>
                <strong>{line.value}</strong>
              </li>
            ))}
          </ul>
        )}
        {r.allocation.maxLines.length === 0 ? null : (
          <>
            <h3 className="mw-authority-review__title">Maximum authority</h3>
            <ul className="mw-authority-review__alloc-lines">
              {r.allocation.maxLines.map((line) => (
                <li key={`max-${line.label}`}>
                  <span>{line.label}</span>
                  <strong>{line.value}</strong>
                </li>
              ))}
            </ul>
          </>
        )}
        {r.allocation.planningNote === null ? null : <p className="mw-fine">{r.allocation.planningNote}</p>}

        {r.riskPreference === null ? null : (
          <p className="mw-authority-review__risk">
            Risk preference <strong>{r.riskPreference.label}</strong> <span className="mw-provenance">Advisory</span>
          </p>
        )}

        {r.changes.length === 0 ? null : (
          <details className="mw-disclosure">
            <summary>Changed from prompt</summary>
            <ul className="mw-authority-review__changes">
              {r.changes.map((c) => (
                <li key={c.field}>
                  <span>{c.label}</span>
                  <strong>
                    {c.from} → {c.to}
                  </strong>
                </li>
              ))}
            </ul>
          </details>
        )}

        <details className="mw-disclosure">
          <summary>Risk controls &amp; advanced permissions</summary>
          {groups.map((group) => (
            <div key={group} className="mw-authority-review__group">
              <h4>{group}</h4>
              <dl className="mw-summary">
                {r.advanced
                  .filter((row) => row.group === group)
                  .map((row) => (
                    <div key={`${row.group}:${row.label}`}>
                      <dt>
                        {row.label}
                        {row.advisory === true ? <span className="mw-provenance">Advisory</span> : null}
                      </dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          ))}
        </details>

        <details className="mw-disclosure">
          <summary>How this was interpreted</summary>
          <ul className="mw-authority-review__provenance">
            {r.total === "" ? null : (
              <li>
                <span>Portfolio total</span>
                <strong>{usd(r.total)}</strong>
                <span className="mw-provenance">{r.totalProvenance ?? "Unset"}</span>
              </li>
            )}
            {r.agents
              .filter((a) => a.state === "ENABLED")
              .map((a) => (
                <li key={a.role}>
                  <span>{a.title}</span>
                  <strong>{a.authorityLabel}</strong>
                  <span className="mw-provenance">{a.provenanceLabel ?? "—"}</span>
                </li>
              ))}
          </ul>
        </details>
      </section>

      <div className="mw-approve__edit">
        <button type="button" className="mw-soft-button" disabled={props.authorizing} onClick={props.onEditPermissions}>
          Edit permissions
        </button>
      </div>

      <section className="mw-signer" aria-label="How this mandate is signed" role="radiogroup">
        <button type="button" role="radio" aria-checked={signingMethod === "wallet"} className="mw-signer__option" data-selected={signingMethod === "wallet" ? "" : undefined} data-disabled={wallet.available ? undefined : ""} disabled={!wallet.available || props.authorizing} onClick={() => setMethod("wallet")}>
          <span className="mw-signer__icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="6" width="18" height="13" rx="3" /><path d="M16 12.5h2M3 9h15a3 3 0 0 0-3-3" /></svg>
          </span>
          <span>
            <strong>Approve in wallet</strong>
            <small>{!wallet.available ? (v3 ? "A browser wallet is required for V3 autonomous mandate authorization." : "No browser wallet detected. Use the demo principal key below.") : connected ? `${shortAddress(wallet.address ?? "")}${rightChain ? " · Robinhood Chain testnet" : " · switch to Robinhood Chain testnet to sign"}` : "Your wallet will sign this Mandate. This does not submit a blockchain transaction."}</small>
          </span>
          <Pill tone={connected && rightChain ? "good" : "neutral"}>{!wallet.available ? "Not detected" : !connected ? "Not connected" : rightChain ? "Connected" : "Wrong network"}</Pill>
        </button>
        {v3 ? null : (
          <button type="button" role="radio" aria-checked={method === "demo"} className="mw-signer__option" data-selected={method === "demo" ? "" : undefined} disabled={props.authorizing} onClick={() => setMethod("demo")}>
            <span className="mw-signer__icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M16 7l2 2M14 9l2 2" /></svg>
            </span>
            <span><strong>Demo principal key</strong><small>Held by the local server. Publicly derived: it secures nothing and is not a wallet signature.</small></span>
            <Pill tone={method === "demo" ? "accent" : "neutral"}>Fallback</Pill>
          </button>
        )}
        {signingMethod === "wallet" && wallet.available ? (
          <div className="mw-signer__actions">
            {!connected ? <button type="button" className="mw-soft-button" disabled={props.authorizing} onClick={props.onConnect}>Connect wallet</button> : null}
            {connected && !rightChain ? <button type="button" className="mw-soft-button" disabled={props.authorizing} onClick={props.onSwitchChain}>Switch to Robinhood Chain testnet</button> : null}
            <details className="mw-disclosure mw-disclosure--inline">
              <summary>What this signature does</summary>
              <p className="mw-fine">
                {v3
                  ? "An offchain EIP-712 DelegatedPortfolioAuthorizationV3. One signature binds portfolio authority and bounded autonomous Stock testnet execution. No gas. No per-trade wallet approval after this. Mandate verifies each exact action; the ephemeral Mandate execution delegate signs settlement."
                  : "An offchain EIP-712 PortfolioMandateAuthorizationV2 approval of this exact mandate and the initial allocation shown above, for this session, once. Your wallet becomes the protocol principal. No gas, no transaction. Stock settlement asks for a separate MandateAuthorization. This page does not broadcast, and your signature does not delegate onchain execution authority."}
              </p>
            </details>
            {v3 ? (
              <section className="mw-authority-review__group" aria-label="Automatic execution">
                <h4>Automatic execution</h4>
                <p className="mw-fine">Enabled for the Stock testnet settlement path. Recipient is your wallet. Bounded by the derived MDUSD fixture debit cap disclosed in technical details after signing.</p>
              </section>
            ) : null}
          </div>
        ) : null}
        {signingMethod === "demo" ? (
          <label className="mw-confirm">
            <span>Type <code>{props.expected}</code> to sign</span>
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} disabled={props.authorizing || !reviewClean} aria-label="Authorization confirmation" />
          </label>
        ) : null}
      </section>

      {props.authorizing ? <div className="mw-inline-status" aria-live="polite"><LatticeLoader label={signingMethod === "wallet" ? "Waiting for your wallet" : `Signing mandate ${version}`} status="working" pattern="orbit" showTimer={false} /></div> : null}
      {props.error === "" ? null : <p className="mw-notice mw-notice--bad" role="alert">{props.error}</p>}
      {reviewClean ? (
        <p className="mw-fine mw-approve__promise">Your wallet signs this authority. Agents cannot exceed it.</p>
      ) : (
        <p className="mw-notice mw-notice--warn" role="status">
          Authorize is disabled until every item above is resolved. The wallet will not be asked to sign a blocked draft.
        </p>
      )}

      <footer className="mw-stage-foot">
        {signingMethod === "wallet" ? (
          <button type="button" className="mw-cta" disabled={!walletReady || props.authorizing} onClick={props.onSignWallet}>
            Authorize mandate
          </button>
        ) : (
          <button type="button" className="mw-cta" disabled={!demoReady || props.authorizing} onClick={() => props.onAuthorize(confirmation)}>
            Authorize mandate
          </button>
        )}
        <button type="button" className="mw-text-button" disabled={props.authorizing} onClick={props.onCancel}>
          Cancel
        </button>
      </footer>
    </div>
  );
}

const SET_FIELDS = [
  { path: "market.assets", set: "assets", label: "Assets" },
  { path: "market.issuers", set: "issuers", label: "Issuers" },
  { path: "market.representations", set: "representations", label: "Representations" },
  { path: "market.venues", set: "venues", label: "Venues" },
  { path: "market.chains", set: "chains", label: "Chains" },
] as const;

const SECTIONS: readonly { readonly title: string; readonly levels: readonly string[]; readonly names?: readonly string[]; readonly fields: readonly { readonly path: string; readonly label: string; readonly prefix?: string; readonly suffix?: string }[] }[] = [
  { title: "Capital", levels: ["PORTFOLIO"], names: ["Total capital", "Maximum deployed", "Allocation", "Stock spot capital"], fields: [
    { path: "portfolio.totalCapital", label: "Portfolio authority", prefix: "$" },
    { path: "portfolio.maxDeployed", label: "Maximum initially deployable", prefix: "$" },
    { path: "portfolio.minUnallocated", label: "Minimum kept available", prefix: "$" },
  ] },
  { title: "Exposure", levels: ["PORTFOLIO"], names: ["Derivative exposure", "Illiquid exposure", "Validity"], fields: [
    { path: "portfolio.maxDerivative", label: "Derivative exposure", prefix: "$" },
    { path: "portfolio.maxIlliquid", label: "Illiquid exposure", prefix: "$" },
    { path: "portfolio.validityMinutes", label: "Mandate duration", suffix: "min" },
    { path: "market.maxLeverage", label: "Maximum leverage", suffix: "×" },
  ] },
  { title: "Assets & venues", levels: ["MARKET"], fields: [] },
  { title: "Execution limits", levels: ["EXECUTION"], fields: [
    { path: "market.maxSlippageBps", label: "Maximum slippage", suffix: "bps" },
    { path: "market.maxQuoteAgeSeconds", label: "Quote freshness", suffix: "s" },
  ] },
  { title: "Agents", levels: ["AGENT"], fields: ROLES.flatMap((role) => [
    { path: `agents.${role}.maxAllocation`, label: `${ROLE_TITLES[role].replace(" Agent", "")} maximum`, prefix: "$" },
    { path: `agents.${role}.maxExposure`, label: `${ROLE_TITLES[role].replace(" Agent", "")} exposure`, prefix: "$" },
  ]) },
];

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  INTERPRETED: "From your prompt",
  EXPLICIT_PROMPT: "From your prompt",
  MODEL_EXTRACTED: "Suggested",
  DETERMINISTIC_DERIVED: "Derived from your prompt",
  PRESET: "Default",
  USER: "Edited",
  PLANNED: "From Planning Room",
};

function Guardrails({ rows }: { readonly rows: readonly JsonRecord[] }): ReactNode {
  if (rows.length === 0) return null;
  return (
    <details className="mw-disclosure mw-guardrails">
      <summary>What Mandate enforces</summary>
      <dl>
        {rows.map((row, index) => (
          <div key={`${str(row.guardrail)}:${index}`}>
            <dt>{str(row.guardrail)} <span className="mw-provenance" title={str(row.term)}>{str(row.status)}</span></dt>
            <dd>{str(row.enforced)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** Every real draft control, organized. Editing changes the draft only; a signed version is never edited in place. */
export function PermissionsBody(props: {
  readonly access: DraftAccess | null;
  readonly guardrails: readonly JsonRecord[];
  readonly catalog: JsonRecord;
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onField: (path: string, value: Json) => void;
}): ReactNode {
  const access = props.access;
  return (
    <div className="mw-permissions">
      <p className="mw-fine">{props.editable ? "Changes apply to this draft. Nothing is authorized until you sign." : "This is the signed mandate in force. Adjust it to create a new draft version."}</p>
      {SECTIONS.map((section) => {
        const rows = props.guardrails.filter((row) => section.levels.includes(str(row.level)) && (section.names === undefined || section.names.includes(str(row.guardrail))));
        return (
          <section key={section.title} className="mw-permissions__section">
            <h3>{section.title}</h3>
            {access !== null && section.fields.length > 0 ? (
              <div className="mw-permissions__grid">
                {section.fields.map((field) => {
                  const value = access.text(field.path);
                  const source = access.source(field.path);
                  return (
                    <div key={field.path} className="mw-permissions__field">
                      <span className="mw-permissions__label">{field.label}{source === null ? null : <span className="mw-provenance">{SOURCE_LABEL[source] ?? source}</span>}</span>
                      {props.editable ? (
                        <span className="mw-permissions__control">
                          <FieldInput key={value} value={value} label={field.label} prefix={field.prefix} disabled={props.busy} onCommit={(next) => props.onField(field.path, next)} />
                          {field.suffix === undefined ? null : <span className="mw-permissions__suffix">{field.suffix}</span>}
                        </span>
                      ) : (
                        <strong>{value === "" ? "Not set" : `${field.prefix ?? ""}${value}${field.suffix === undefined ? "" : ` ${field.suffix}`}`}</strong>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {section.title === "Assets & venues" && access !== null ? SET_FIELDS.map((field) => <SetField key={field.path} field={field} access={access} catalog={props.catalog} editable={props.editable} busy={props.busy} onField={props.onField} />) : null}
            {section.title === "Execution limits" && access !== null ? (
              <p className="mw-fine">Trusted execution details (recipients, Gate, adapter, chain, calldata) are not editable here.</p>
            ) : null}
            <Guardrails rows={rows} />
          </section>
        );
      })}
    </div>
  );
}

function SetField({ field, access, catalog, editable, busy, onField }: { readonly field: { readonly path: string; readonly set: string; readonly label: string }; readonly access: DraftAccess; readonly catalog: JsonRecord; readonly editable: boolean; readonly busy: boolean; readonly onField: (path: string, value: Json) => void }): ReactNode {
  const options = arr(catalog[field.set]).map(rec);
  const chosen = access.ids(field.path);
  const source = access.source(field.path);
  return (
    <fieldset className="mw-set">
      <legend>{field.label}{chosen === null ? <span className="mw-provenance mw-provenance--warn">Not set</span> : source === null ? null : <span className="mw-provenance">{SOURCE_LABEL[source] ?? source}</span>}</legend>
      {options.map((option) => {
        const id = str(option.id);
        const on = chosen?.includes(id) ?? false;
        return (
          <label key={id} className="mw-check">
            <input
              type="checkbox"
              checked={on}
              disabled={!editable || busy}
              onChange={() => onField(field.path, on ? (chosen ?? []).filter((item) => item !== id) : [...(chosen ?? []), id])}
            />
            <span>{str(option.label)}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
