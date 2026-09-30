/**
 * One line of text per `MANDATE_LIVE_AI.V1` event, for the command-line
 * runner. It prints only fields the event already carries — every one of
 * which was chosen by its emitter as safe to show.
 */

import type { JsonObject, JsonValue } from '../runtime/strict-json.ts';
import type { LiveEvent } from './events.ts';

const str = (v: JsonValue | undefined): string => (v === undefined || v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
const amount = (v: JsonValue | undefined): string => {
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && 'amount' in v) return `${str((v as JsonObject)['amount'])} USDC`;
  return str(v);
};
const list = (v: JsonValue | undefined): string => (Array.isArray(v) ? (v.length === 0 ? 'none' : v.map((x) => str(x)).join(', ')) : str(v));
const ms = (v: JsonValue | undefined): string => (typeof v === 'number' ? `${v} ms` : '—');
const quote = (v: JsonValue | undefined): string => (typeof v === 'string' ? `“${v}”` : '');
const usdc = (atoms: JsonValue | undefined): string => (typeof atoms === 'string' && /^\d+$/.test(atoms) ? `${(BigInt(atoms) / 1_000_000n).toString()}${BigInt(atoms) % 1_000_000n === 0n ? '' : `.${(BigInt(atoms) % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')}`}` : str(atoms));
/** The constraints that need reducing, e.g. `derivative-notional 600 > 400`. */
const binding = (lines: JsonValue | undefined): string => {
  if (!Array.isArray(lines)) return '';
  const over = lines.map((x) => x as JsonObject).filter((l) => l['requiredReductionAtoms'] !== '0');
  return over.map((l) => `${str(l['resource'])} ${usdc(l['demandAtoms'])} > ${usdc(l['authorityAtoms'])} USDC (reduce ${usdc(l['requiredReductionAtoms'])})`).join('; ');
};
/** What became of each opened conflict, e.g. `derivative-notional 600 → 400 ≤ 400 USDC SATISFIED`. */
const resolved = (conflicts: JsonValue | undefined): string => {
  if (!Array.isArray(conflicts)) return '';
  return conflicts
    .map((x) => x as JsonObject)
    .map((c) => {
      const atoms = (v: JsonValue | undefined) => usdc(((v ?? {}) as JsonObject)['atoms']);
      return `${str(c['resource'])} ${atoms(c['demand'])} → ${atoms(c['demandAfter'])} ${c['status'] === 'SATISFIED' ? '≤' : '>'} ${atoms(c['authority'])} USDC ${str(c['status'])}`;
    })
    .join('; ');
};

function detail(e: LiveEvent): string {
  const d = e.data;
  switch (e.kind) {
    case 'SESSION_STARTED':
      return `provider ${str(d['provider'])} (${str(d['providerKind'])}) · model ${str(d['model'])} · JEV ${str(d['jev'])}${d['chaos'] === null ? '' : ` · LATENCY CHAOS ${str(d['chaos'])} (artificial)`}`;
    case 'MANDATE_VERSION_AUTHORIZED':
      return `V${str(d['version'])} ACTIVE · digest ${str(d['digest'])}${d['supersedes'] === null ? '' : ` · supersedes V${str(d['supersedes'])}`}`;
    case 'MANDATE_VERSION_SUPERSEDED':
      return `V${str(d['version'])} superseded by V${str(d['supersededBy'])}: ${str(d['effect'])}`;
    case 'MANDATE_AMENDMENT_REFUSED':
      return `${str(d['code'])}: ${str(d['message'])}`;
    case 'AGENT_REQUEST_STARTED':
      return `asked ${str(d['model'])} · candidates ${list(d['candidates'])}`;
    case 'AGENT_FIRST_RESPONSE':
      return 'first streamed chunk';
    case 'AGENT_DECISION_COMPLETED':
      return `${str(d['candidateId'])} · ${amount(d['requested'])} · provider ${ms(d['providerLatencyMs'])}${d['injectedLatencyMs'] === 0 ? '' : ` (+${ms(d['injectedLatencyMs'])} injected)`} ${quote(d['rationale'])}`;
    case 'AGENT_ABSTAINED':
      return `abstained · provider ${ms(d['providerLatencyMs'])} ${quote(d['rationale'])}`;
    case 'AGENT_TIMED_OUT':
      return `no answer within ${ms(d['timeoutMs'])}: runtime state, not a refusal`;
    case 'AGENT_FAILED':
    case 'AGENT_INVALID_RESPONSE':
      return `${str(d['error'])}: nothing signed`;
    case 'PROPOSAL_SIGNED':
      return `${d['phase'] === undefined ? '' : `${str(d['phase'])} `}sequence ${str(d['sequence'])} · ${str(d['proposal'])}`;
    case 'PROPOSAL_BLOCKED':
      return `BLOCKED by Mandate: ${list(d['reasons'])}`;
    case 'PROPOSAL_ADMISSIBLE':
      return `admissible · ${d['portfolioValid'] === true ? 'individually and portfolio valid' : `individually valid, portfolio invalid (${list(d['reasons'])})`}`;
    case 'PROPOSAL_STALE':
      return `${str(d['cause'])} → ${str(d['next'])}${Array.isArray(d['reasons']) && d['reasons'].length > 0 ? ` (${list(d['reasons'])})` : ''}`;
    case 'PORTFOLIO_CONFLICT':
      return `admissible demand ${amount(d['admissibleDemand'])} of ${amount(d['authority'])} deployable · over: ${binding(d['constraints']) || 'agent limits'}`;
    case 'ROOM_OPENED':
      return `autonomous room, no human · over: ${binding(d['constraints']) || 'agent limits'}`;
    case 'ROOM_GENERATION_STARTED':
      return `participants ${list(d['participants'])} · over: ${binding(d['constraints']) || 'agent limits'}`;
    case 'ROOM_AGENT_RESPONSE':
      return d['status'] === undefined ? `${str(d['action'])} ${amount(d['from'])} → ${amount(d['to'])} · provider ${ms(d['providerLatencyMs'])} ${quote(d['rationale'])}` : `${str(d['status'])}: ${str(d['error'])} · ${str(d['effect'])}`;
    case 'ROOM_KEEP':
    case 'ROOM_REDUCTION':
    case 'ROOM_RELEASE':
      return `${amount(d['from'])} → ${amount(d['to'])}`;
    case 'ROOM_AGENT_TIMEOUT':
      return str(d['effect']);
    case 'ROOM_AGENT_STALE_RESPONSE':
      return `generation ${str(d['answeredGeneration'])} answered ${str(d['action'])} (${str(d['reason'])}) · ${str(d['effect'])}`;
    case 'ROOM_PROPOSAL_CREATED':
      return `proposed: ${Array.isArray(d['requests']) ? d['requests'].map((x) => { const o = x as JsonObject; return `${str(o['role'])} ${amount(o['from'])}→${amount(o['to'])}`; }).join(', ') : ''}${resolved(d['conflicts']) === '' ? '' : ` · ${resolved(d['conflicts'])}`}`;
    case 'ROOM_NO_FEASIBLE_PORTFOLIO':
      return `offers ${amount(d['offeredReduction'])} · still over: ${binding(d['remaining']) || 'agent limits'} · execution ${str(d['execution'])}`;
    case 'ROOM_FINALIZED':
      return `${str(d['result'])} after ${str(d['generations'])} generation(s), ${ms(d['durationMs'])} · timeouts ${str(d['timeouts'])} · failures ${str(d['failures'])}`;
    case 'MANDATE_REVERIFY_STARTED':
      return `${str(d['phase'])}: ${str(d['path'])}`;
    case 'PORTFOLIO_AUTHORIZED':
    case 'PORTFOLIO_REFUSED':
      return `${str(d['phase'])} · verifier ${str(d['verification'])} · reserved ${amount(d['reserved'])} · ${Array.isArray(d['proposals']) ? d['proposals'].map((x) => { const o = x as JsonObject; return `${str(o['role'])} ${str(o['outcome'])}`; }).join(', ') : ''} · transactions ${str(d['transactions'])}`;
    case 'POLICY_STRESS_STARTED':
      return `${str(d['title'])} — ${str(d['headline'])} · identity ${str(d['identity'])} · same signer as Swap Agent: ${str(d['sameSignerAsSwapAgent'])} · up to ${str(d['maxAttempts'])} attempts`;
    case 'POLICY_STRESS_CASE_SELECTED':
      return `attempt ${str(d['attempt'])}: model selected ${str(d['caseId'])} · provider ${ms(d['providerLatencyMs'])} ${quote(d['rationale'])}`;
    case 'POLICY_STRESS_PROPOSAL_SIGNED': {
      const id = (d['identity'] ?? {}) as JsonObject;
      return `attempt ${str(d['attempt'])} ${str(d['caseId'])} · identity ${str(id['agentIdentity'])} · membership ${str(id['membership'])} · delegation ${str(id['delegation'])} · signature ${str(id['signature'])}`;
    }
    case 'POLICY_STRESS_PROPOSAL_BLOCKED':
      return `attempt ${str(d['attempt'])} ${str(d['caseId'])} → REFUSED by Mandate: ${list(d['reasons'])} · ledger unchanged: ${str(d['ledgerUnchanged'])}`;
    case 'POLICY_STRESS_PROPOSAL_AUTHORIZED':
      return `attempt ${str(d['attempt'])} ${str(d['caseId'])} → AUTHORIZED · reserved ${amount(d['reserved'])} · ${str(d['note'])}`;
    case 'POLICY_STRESS_COMPLETED':
      return `ended: ${str(d['endedBy'])}${d['authorized'] === undefined ? `${d['error'] === undefined ? '' : ` (${str(d['error'])})`}` : ` · refused ${str(d['refused'])} · authorized ${str(d['authorized'])}`}`;
    default:
      return '';
  }
}

export function renderEvent(e: LiveEvent): string {
  const who = e.agent === null ? '' : `[${e.agent}] `;
  const where = e.roomId === null ? '' : ` ${e.roomId}${e.generation === null ? '' : ` g${e.generation}`}`;
  const d = detail(e);
  return `${`+${e.elapsedMs}ms`.padStart(9)}  ${who}${e.kind}${where}${d === '' ? '' : `  ${d}`}`;
}
