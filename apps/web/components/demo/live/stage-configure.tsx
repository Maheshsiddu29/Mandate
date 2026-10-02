"use client";

import { LatticeLoader } from "@/components/react-bits/lattice-loader";
import { useState, type ReactNode } from "react";
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
  return (
    <li className="mw-agent-config" data-role={role} data-enabled={enabled === true ? "on" : enabled === false ? "off" : "unset"}>
      <span className="mw-glyph"><AgentGlyph role={role} /></span>
      <span className="mw-agent-config__name">
        <strong>{ROLE_TITLES[role]}</strong>
        <span>{enabled === false ? "No authority · cannot propose" : ROLE_DESCRIPTORS[role]}</span>
      </span>
      {enabled === false ? (
        <span className="mw-agent-config__off">—</span>
      ) : (
        <span className="mw-agent-config__amount">
          <span className="mw-agent-config__hint" aria-hidden="true">Up to</span>
          <FieldInput key={max} value={max} label={`${ROLE_TITLES[role]} agent maximum allocation in USDC`} prefix="$" disabled={busy} onCommit={(value) => onField(`agents.${role}.maxAllocation`, value)} />
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
          ? `Ceilings add up to more than the ${deployable} you deploy. Mandate holds that line; overlapping requests go to the Room.`
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
          <p>Each agent gets a ceiling. Mandate decides what actually executes.</p>
        </div>
        <button type="button" className="mw-ghost-button" onClick={props.onPermissions}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
          Advanced permissions
        </button>
      </header>

      <ul className="mw-agent-config-list" aria-label="Agents">
        {ROLES.map((role) => <AgentConfigRow key={role} role={role} access={props.access} busy={props.busy} onField={props.onField} />)}
      </ul>

      <Allocation access={props.access} />

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
  readonly access: DraftAccess;
  readonly expected: string;
  readonly authorizing: boolean;
  readonly error: string;
  readonly wallet: WalletState;
  readonly onConnect: () => void;
  readonly onSwitchChain: () => void;
  readonly onSignWallet: () => void;
  readonly onAuthorize: (confirmation: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [confirmation, setConfirmation] = useState("");
  const [method, setMethod] = useState<"wallet" | "demo">(props.wallet.available ? "wallet" : "demo");
  const version = props.expected.replace("AUTHORIZE MANDATE ", "");
  const enabled = ROLES.filter((role) => props.access.enabled(role) === true);
  const venues = props.access.ids("market.venues");
  const matches = confirmation === props.expected && props.expected !== "—";
  const wallet = props.wallet;
  const connected = wallet.address !== null;
  const rightChain = wallet.chainId === APPROVAL_CHAIN.chainId;
  const walletReady = method === "wallet" && connected && rightChain;
  return (
    <div className="mw-approve">
      <header className="mw-stage-head">
        <p className="mw-kicker">Mandate {version}</p>
        <h2>Review your mandate</h2>
        <p>Approve once. Agents then work inside these limits without asking again. The Room can never add to them.</p>
      </header>
      <dl className="mw-summary">
        <div><dt>Capital</dt><dd>{usd(props.access.text("portfolio.totalCapital"))}</dd></div>
        <div><dt>Derivative exposure</dt><dd>≤ {usd(props.access.text("portfolio.maxDerivative"))}</dd></div>
        <div className="mw-summary__wide"><dt>Agents</dt><dd>{enabled.length === 0 ? "None" : enabled.map((role) => ROLE_TITLES[role]).join(" · ")}</dd></div>
        <div><dt>Markets</dt><dd>{venues === null ? "Not set" : `${venues.length} approved venues only`}</dd></div>
        <div><dt>Valid for</dt><dd>{props.access.text("portfolio.validityMinutes") === "" ? "Not set" : `${props.access.text("portfolio.validityMinutes")} minutes`}</dd></div>
      </dl>

      <section className="mw-signer" aria-label="How this mandate is signed" role="radiogroup">
        <button type="button" role="radio" aria-checked={method === "wallet"} className="mw-signer__option" data-selected={method === "wallet" ? "" : undefined} data-disabled={wallet.available ? undefined : ""} disabled={!wallet.available || props.authorizing} onClick={() => setMethod("wallet")}>
          <span className="mw-signer__icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="6" width="18" height="13" rx="3" /><path d="M16 12.5h2M3 9h15a3 3 0 0 0-3-3" /></svg>
          </span>
          <span>
            <strong>Approve in wallet</strong>
            <small>{!wallet.available ? "No browser wallet detected. Use the demo principal key below." : connected ? `${shortAddress(wallet.address ?? "")}${rightChain ? " · Robinhood Chain testnet" : " · switch to Robinhood Chain testnet to sign"}` : "Your wallet will sign this Mandate. This does not submit a blockchain transaction."}</small>
          </span>
          <Pill tone={connected && rightChain ? "good" : "neutral"}>{!wallet.available ? "Not detected" : !connected ? "Not connected" : rightChain ? "Connected" : "Wrong network"}</Pill>
        </button>
        <button type="button" role="radio" aria-checked={method === "demo"} className="mw-signer__option" data-selected={method === "demo" ? "" : undefined} disabled={props.authorizing} onClick={() => setMethod("demo")}>
          <span className="mw-signer__icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M16 7l2 2M14 9l2 2" /></svg>
          </span>
          <span><strong>Demo principal key</strong><small>Held by the local server. Publicly derived: it secures nothing and is not a wallet signature.</small></span>
          <Pill tone={method === "demo" ? "accent" : "neutral"}>Fallback</Pill>
        </button>
        {method === "wallet" && wallet.available ? (
          <div className="mw-signer__actions">
            {!connected ? <button type="button" className="mw-soft-button" disabled={props.authorizing} onClick={props.onConnect}>Connect wallet</button> : null}
            {connected && !rightChain ? <button type="button" className="mw-soft-button" disabled={props.authorizing} onClick={props.onSwitchChain}>Switch to Robinhood Chain testnet</button> : null}
            <details className="mw-disclosure mw-disclosure--inline">
              <summary>What this signature does</summary>
              <p className="mw-fine">An offchain EIP-712 PortfolioMandateV2 approval of this exact mandate, for this session, once. Your wallet becomes the protocol principal. No gas, no transaction. Stock settlement asks for a separate MandateAuthorization. The deployer pays gas, and your signature does not delegate onchain execution authority.</p>
            </details>
          </div>
        ) : null}
        {method === "demo" ? (
          <label className="mw-confirm">
            <span>Type <code>{props.expected}</code> to sign</span>
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} disabled={props.authorizing} aria-label="Authorization confirmation" />
          </label>
        ) : null}
      </section>

      {props.authorizing ? <div className="mw-inline-status" aria-live="polite"><LatticeLoader label={method === "wallet" ? "Waiting for your wallet" : `Signing mandate ${version}`} status="working" pattern="orbit" showTimer={false} /></div> : null}
      {props.error === "" ? null : <p className="mw-notice mw-notice--bad" role="alert">{props.error}</p>}

      <footer className="mw-stage-foot">
        {method === "wallet" ? (
          <button type="button" className="mw-cta" disabled={!walletReady || props.authorizing} onClick={props.onSignWallet}>Sign Mandate</button>
        ) : (
          <button type="button" className="mw-cta" disabled={!matches || props.authorizing} onClick={() => props.onAuthorize(confirmation)}>Sign &amp; start agents</button>
        )}
        <button type="button" className="mw-text-button" disabled={props.authorizing} onClick={props.onCancel}>Cancel</button>
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
    { path: "portfolio.totalCapital", label: "Total capital", prefix: "$" },
    { path: "portfolio.maxDeployed", label: "Maximum deployed", prefix: "$" },
    { path: "portfolio.minUnallocated", label: "Minimum unallocated", prefix: "$" },
  ] },
  { title: "Risk", levels: ["PORTFOLIO"], names: ["Derivative exposure", "Illiquid exposure", "Validity"], fields: [
    { path: "portfolio.maxDerivative", label: "Derivative exposure cap", prefix: "$" },
    { path: "portfolio.maxIlliquid", label: "Illiquid exposure cap", prefix: "$" },
    { path: "portfolio.validityMinutes", label: "Validity", suffix: "min" },
    { path: "market.maxLeverage", label: "Maximum leverage", suffix: "×" },
  ] },
  { title: "Markets", levels: ["MARKET"], fields: [] },
  { title: "Execution", levels: ["EXECUTION"], fields: [
    { path: "market.maxSlippageBps", label: "Maximum slippage", suffix: "bps" },
    { path: "market.maxQuoteAgeSeconds", label: "Quote freshness", suffix: "s" },
  ] },
  { title: "Agent limits", levels: ["AGENT"], fields: ROLES.flatMap((role) => [
    { path: `agents.${role}.maxAllocation`, label: `${ROLE_TITLES[role]} ceiling`, prefix: "$" },
    { path: `agents.${role}.maxExposure`, label: `${ROLE_TITLES[role]} exposure`, prefix: "$" },
  ]) },
];

const SOURCE_LABEL: Readonly<Record<string, string>> = { INTERPRETED: "From your prompt", PRESET: "Default", USER: "Edited" };

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
            {section.title === "Markets" && access !== null ? SET_FIELDS.map((field) => <SetField key={field.path} field={field} access={access} catalog={props.catalog} editable={props.editable} busy={props.busy} onField={props.onField} />) : null}
            {section.title === "Execution" && access !== null ? <SetField field={{ path: "execution.recipients", set: "recipients", label: "Recipients" }} access={access} catalog={props.catalog} editable={props.editable} busy={props.busy} onField={props.onField} /> : null}
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
