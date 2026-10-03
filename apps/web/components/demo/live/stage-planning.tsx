"use client";

import { LatticeLoader } from "@/components/react-bits/lattice-loader";
import { useState, type ReactNode } from "react";
import { budgetRows, canAskForPlan, checkBudgets, roomCopy, type AllocationState, type PlanningCard, type PlanView } from "./allocation-model";
import type { Json } from "./live-client";
import { ROLE_DESCRIPTORS, ROLE_TITLES, ROLES, usd, type RoleName } from "./live-model";
import type { DraftAccess } from "./stage-configure";
import { AgentGlyph, Pill } from "./workspace-ui";

function Row({ role, children, sub }: { readonly role: RoleName; readonly children: ReactNode; readonly sub?: string }): ReactNode {
  return (
    <li className="mw-row" data-role={role}>
      <span className="mw-glyph mw-glyph--sm"><AgentGlyph role={role} size={16} /></span>
      <span className="mw-row__who"><strong>{ROLE_TITLES[role]}</strong>{sub === undefined || sub === "" ? null : <small>{sub}</small>}</span>
      <span className="mw-row__value">{children}</span>
    </li>
  );
}

/** "Which agents may use this capital?" Agent selection is authority: nothing is enabled until the principal chooses. */
export function AgentSelection(props: { readonly undecided: readonly RoleName[]; readonly busy: boolean; readonly onChoose: (enabled: readonly RoleName[]) => void }): ReactNode {
  const [chosen, setChosen] = useState<readonly RoleName[]>([]);
  const toggle = (role: RoleName) => setChosen((c) => (c.includes(role) ? c.filter((r) => r !== role) : [...c, role]));
  return (
    <section className="mw-allocation" aria-label="Agent selection">
      <div className="mw-allocation__row"><span className="mw-allocation__label">Which agents may use this capital?</span></div>
      <p className="mw-allocation__note">Choosing an agent gives it authority. Mandate never picks agents for you.</p>
      <div className="mw-chips" role="group" aria-label="Agents">
        {ROLES.map((role) => (
          <button key={role} type="button" className="mw-chip" aria-pressed={chosen.includes(role)} disabled={props.busy} onClick={() => toggle(role)}>{ROLE_TITLES[role].replace(" Agent", "")}</button>
        ))}
        <button type="button" className="mw-chip" disabled={props.busy} onClick={() => props.onChoose(ROLES)}>All approved agents</button>
      </div>
      <button type="button" className="mw-soft-button" disabled={props.busy || chosen.length === 0} onClick={() => props.onChoose(chosen)}>Use {chosen.length === 0 ? "these agents" : chosen.map((r) => ROLE_TITLES[r].replace(" Agent", "")).join(", ")}</button>
    </section>
  );
}

/**
 * Who decides the split, shown in the Configure stage:
 * FIXED → "Your allocation"; DYNAMIC/HYBRID → ask the agents for a split; a
 * plan in place → its budgets, editable. Budgets are maxima, never targets.
 */
export function AllocationPanel(props: {
  readonly state: AllocationState;
  readonly access: DraftAccess;
  readonly busy: boolean;
  readonly blockedOtherwise: boolean;
  readonly onAskPlan: () => void;
  readonly onField: (path: string, value: Json) => void;
}): ReactNode {
  const { state, access } = props;
  const [editing, setEditing] = useState(false);
  const rows = budgetRows(access.draft, state.enabled);
  const total = rows.reduce((s, r) => s + (r.amount === null ? 0 : Number(r.amount)), 0);
  const kept = state.deployable === null ? null : Math.max(0, Number(state.deployable) - total);
  const planned = rows.every((r) => r.amount !== null);
  const ask = canAskForPlan(state);
  return (
    <section className="mw-allocation" aria-label="Your allocation">
      <div className="mw-allocation__row">
        <span className="mw-allocation__label">{state.intent === "FIXED" ? "Your allocation" : planned ? "Allocation" : "You left the split to the agents"}</span>
        {state.deployable === null ? null : <span className="mw-allocation__value"><strong>{usd(state.deployable)}</strong> available</span>}
      </div>
      {planned || state.fixed.length > 0 ? (
        <ul className="mw-rows">
          {rows.map((r) => (
            <Row key={r.role} role={r.role} sub={r.source === "AGENTS" ? "proposed by the agents" : r.source === "YOU" && state.fixed.includes(r.role) ? "set by you" : ""}>
              {editing ? (
                <input className="mw-input mw-input--inline" aria-label={`${ROLE_TITLES[r.role]} budget in USDC`} defaultValue={r.amount ?? ""} inputMode="decimal" disabled={props.busy} onBlur={(e) => { if (e.target.value.trim() !== (r.amount ?? "")) props.onField(`agents.${r.role}.budget`, e.target.value.trim() === "" ? null : e.target.value.trim()); }} />
              ) : r.amount === null ? <span className="mw-muted">agents propose</span> : usd(r.amount)}
            </Row>
          ))}
        </ul>
      ) : (
        <p className="mw-allocation__note">{state.pool.map((r) => ROLE_TITLES[r].replace(" Agent", "")).join(", ")} will analyze their opportunities and propose a split of {state.pooled === null ? "the pool" : usd(state.pooled)}. You review and can edit it before signing.</p>
      )}
      {planned || state.fixed.length > 0 ? (
        <p className="mw-total"><span>Total</span><strong>{usd(String(total))}</strong></p>
      ) : null}
      {kept !== null && planned ? <p className="mw-allocation__note">Invested up to {usd(String(total))} · kept in wallet {usd(String(kept))}. Budgets are maxima: agents may use less, or nothing. Unused capital stays in your wallet.</p> : null}
      <div className="mw-allocation__actions">
        {planned || state.intent === "FIXED" ? <button type="button" className="mw-text-button" disabled={props.busy} onClick={() => setEditing((e) => !e)}>{editing ? "Done" : "Edit"}</button> : null}
        {ask ? <button type="button" className={planned ? "mw-text-button" : "mw-soft-button"} disabled={props.busy || props.blockedOtherwise} onClick={props.onAskPlan}>{planned ? "Ask the agents again" : "Ask agents for a split"}</button> : null}
      </div>
      {ask && props.blockedOtherwise && !planned ? <p className="mw-fine">Resolve the other open choices first; the agents analyze under the limits you are about to sign.</p> : null}
      <label className="mw-toggle">
        <input type="checkbox" checked={state.autoReallocate} disabled={props.busy} onChange={(e) => props.onField("portfolio.autoReallocate", e.target.checked)} />
        <span>Allow automatic reallocation <small>After signing, capital an agent leaves unused may move to other agents, only inside each agent&apos;s signed maximum.</small></span>
      </label>
    </section>
  );
}

/** The Planning Room: agents propose a split; the principal edits or accepts it. Nothing here is signed. */
export function PlanningStage(props: {
  readonly state: AllocationState | null;
  readonly cards: readonly PlanningCard[];
  readonly plan: PlanView | null;
  readonly working: boolean;
  readonly busy: boolean;
  readonly error: string;
  readonly ceilings: { readonly [role: string]: string | null };
  readonly derivativeCap: string | null;
  readonly illiquidCap: string | null;
  readonly onUse: (edits: { readonly [role: string]: string }) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const { plan } = props;
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<{ readonly [role: string]: string }>({});
  const singleAgent = (plan !== null && plan.purpose === null) || (plan === null && props.state?.pool.length === 1);
  const purpose = singleAgent ? null : (plan?.purpose ?? (props.state?.intent === "HYBRID" ? "HYBRID_ALLOCATION" : "INITIAL_ALLOCATION"));
  const pending = (props.state?.pool ?? []).filter((r) => !props.cards.some((c) => c.role === r));
  const values = plan === null ? {} : Object.fromEntries(plan.budgets.map((b) => [b.role, edits[b.role] ?? b.amount ?? "0"]));
  const check = checkBudgets({
    budgets: { ...Object.fromEntries((plan?.fixed ?? []).map((f) => [f.role, f.amount ?? "0"])), ...values },
    enabled: props.state?.enabled ?? [],
    deployable: props.state?.deployable ?? null,
    ceilings: props.ceilings,
    derivativeCap: props.derivativeCap,
    illiquidCap: props.illiquidCap,
  });
  return (
    <div className="mw-planning">
      <header className="mw-stage-head">
        <p className="mw-kicker">{singleAgent ? "Agent plan" : "Planning Room"} · before you sign</p>
        <h2>
          {plan === null
            ? singleAgent
              ? `${props.state?.pool[0] ? ROLE_TITLES[props.state.pool[0]].replace(" Agent", "") : "Agent"} is analyzing`
              : "Agents are analyzing"
            : singleAgent
              ? "Agent proposes this allocation"
              : "Proposed allocation"}
        </h2>
        <p>
          {singleAgent
            ? "One agent is proposing how much of its available capital it can use. There is no Mandate Room for a single agent."
            : `${roomCopy(purpose)} Independent agents. Shared capital. One bounded authority.`}{" "}
          Nothing is signed or spent here.
        </p>
      </header>
      {props.state?.pooled === null || props.state === null ? null : (
        <p className="mw-total">
          <span>{singleAgent ? "Available authority" : "Available capital"}</span>
          <strong>{usd(props.state.pooled)}</strong>
        </p>
      )}
      <ul className="mw-rows">
        {props.cards.map((c) => {
          const b = plan?.budgets.find((x) => x.role === c.role);
          return (
            <Row key={c.role} role={c.role} sub={c.rationale === "" ? ROLE_DESCRIPTORS[c.role] : c.rationale}>
              {b === undefined ? (
                c.action === "ABSTAIN" ? (
                  <Pill tone="neutral">Abstained</Pill>
                ) : (
                  <Pill tone="accent">Analyzed</Pill>
                )
              ) : editing ? (
                <input className="mw-input mw-input--inline" aria-label={`${ROLE_TITLES[c.role]} proposed budget in USDC`} value={values[c.role] ?? ""} inputMode="decimal" disabled={props.busy} onChange={(e) => setEdits((x) => ({ ...x, [c.role]: e.target.value }))} />
              ) : (
                <>
                  {singleAgent ? <span className="mw-muted">Agent proposes </span> : null}
                  {usd(b.amount)}
                  {b.zero === null ? null : <small className="mw-muted"> · {c.action === "ABSTAIN" ? "abstained" : "not funded"}</small>}
                </>
              )}
            </Row>
          );
        })}
        {pending.map((role) => (
          <Row key={role} role={role} sub="Looking for opportunities…">
            <LatticeLoader label={`${ROLE_TITLES[role]} analyzing`} status="working" pattern="ripple" showTimer={false} />
          </Row>
        ))}
      </ul>
      {plan === null ? null : (
        <>
          {plan.fixed.length === 0 ? null : (
            <p className="mw-fine">Fixed by you, unchanged: {plan.fixed.map((f) => `${ROLE_TITLES[f.role].replace(" Agent", "")} ${usd(f.amount)}`).join(" · ")}</p>
          )}
          <p className="mw-total">
            <span>{singleAgent ? "Agent proposes" : "Final proposed allocation"}</span>
            <strong>{usd(editing ? String(check.total) : plan.allocated)}</strong>
          </p>
          <p className="mw-total">
            <span>{singleAgent ? "Keep available" : "Available"}</span>
            <strong>{editing ? (check.kept === null ? "—" : usd(String(check.kept))) : usd(plan.unallocated)}</strong>
          </p>
          {plan.explanation === "" ? null : (
            <section className="mw-why" aria-label="Why">
              <h3>Why</h3>
              <p>{plan.explanation}</p>
            </section>
          )}
          {editing && !check.ok ? (
            <ul className="mw-notice mw-notice--bad" role="alert">
              {check.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      {props.error === "" ? null : (
        <p className="mw-notice mw-notice--bad" role="alert">
          {props.error}
        </p>
      )}
      <footer className="mw-stage-foot">
        {plan === null ? null : (
          <button type="button" className="mw-cta" disabled={props.busy || props.working || (editing && !check.ok)} onClick={() => props.onUse(edits)}>
            Use this plan
          </button>
        )}
        {plan === null ? null : (
          <button type="button" className="mw-soft-button" disabled={props.busy || props.working} onClick={() => setEditing((e) => !e)}>
            {editing ? "Done editing" : singleAgent ? "Edit" : "Edit allocation"}
          </button>
        )}
        <button type="button" className="mw-text-button" disabled={props.working} onClick={props.onCancel}>
          Back
        </button>
      </footer>
      <p className="mw-fine">The split is advisory. Only your signature authorizes it, and Mandate re-checks every action against your signed limits.</p>
    </div>
  );
}
