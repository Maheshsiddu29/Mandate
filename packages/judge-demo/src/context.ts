/** What every scene builder needs: the protocol run, the event log and presentation helpers. */

import { bindingFor, type ActionKind, type PortfolioMandate, type ResourceVector } from '@mandate/portfolio';
import { amountViews, decimalText, type AgentRef, type AmountView, type EventLog } from './events.ts';
import type { JudgeProtocol } from './protocol.ts';

export interface SceneContext {
  readonly log: EventLog;
  readonly p: JudgeProtocol;
  readonly m: PortfolioMandate;
  agent(id: string): AgentRef;
  label(id: string): string;
  amounts(v: ResourceVector): AmountView[];
  /** `"1,900 USDC"`: one resource of a vector, for messages. */
  money(v: ResourceVector, resource?: string): string;
  domainOf(kind: ActionKind): string | null;
}

/** Thousands separators on exact decimal text. */
export function grouped(text: string): string {
  const [whole = '', fraction] = text.split('.');
  const g = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? g : `${g}.${fraction}`;
}

export function sceneContext(log: EventLog, p: JudgeProtocol): SceneContext {
  const m = p.mandate;
  const labels = new Map<string, string>(m.agents.map((a) => [a.agent.value, a.label]));
  const label = (id: string) => labels.get(id) ?? 'unknown';
  return {
    log,
    p,
    m,
    agent: (id) => ({ id, label: label(id) }),
    label,
    amounts: (v) => amountViews(v, m.resources),
    money: (v, resource = 'portfolio-notional') => {
      const d = m.resources.find((r) => r.resource === resource);
      const atoms = v.find((a) => a.resource === resource)?.atoms ?? 0n;
      return `${grouped(decimalText(atoms, d?.decimals ?? 0))} ${d?.unit ?? ''}`.trim();
    },
    domainOf: (kind) => {
      const b = bindingFor(p.core.compiled.bindings, kind);
      return 'refused' in b ? null : b.domain;
    },
  };
}
