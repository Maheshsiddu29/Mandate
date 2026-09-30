/**
 * The arithmetic of the live Room — pure, exact, and authority-free.
 *
 * `assess` answers one question: would these requests, as they stand, fit
 * what the ledger says the portfolio and each agent can still take? Demand
 * is priced per request by the portfolio's own binding code, so a perps
 * request is charged in portfolio notional, derivative notional and margin
 * exactly as Mandate will charge it. A "fit" here is only a reason to hand
 * the requests to Mandate; the real Room, verifier and ledger decide.
 */

import { amountOf, headroom, type ResourceAvailability, type ResourceVector } from '@mandate/portfolio';
import type { TrustedCandidate } from '../agents/spec.ts';
import type { Party } from '../mandate/signer.ts';
import type { NegotiationAction, ResourceLine } from '../runtime/provider.ts';
import { usdcText, type Role } from '../types.ts';

export interface Participant {
  readonly role: Role;
  readonly agent: Party;
  readonly candidate: TrustedCandidate;
  /** When the candidate's quote was observed; a resized proposal keeps it. */
  readonly observedAt: bigint;
  /** The request the agent signed at discovery. */
  readonly originalAtoms: bigint;
  readonly minimumAtoms: bigint;
}

/** The demand of a participant's candidate at a size; empty at zero. */
export type DemandAt = (p: Participant, atoms: bigint) => ResourceVector;

export interface AgentExcess {
  readonly role: Role;
  readonly resource: string;
  readonly requestedAtoms: bigint;
  readonly limitAtoms: bigint;
}

export interface Fit {
  readonly feasible: boolean;
  /** One line per portfolio resource anyone demands. */
  readonly lines: readonly ResourceLine[];
  readonly agentExcess: readonly AgentExcess[];
  /** Portfolio notional only — not a total: other resources are in `lines`. */
  readonly demandAtoms: bigint;
  readonly authorityAtoms: bigint;
  readonly requiredAtoms: bigint;
}

export function assess(participants: readonly Participant[], requests: ReadonlyMap<Role, bigint>, av: ResourceAvailability, demandAt: DemandAt): Fit {
  const demands = participants.map((p) => ({ p, demand: demandAt(p, requests.get(p.role) ?? 0n) }));
  const lines: ResourceLine[] = [];
  let feasible = true;
  for (const limit of av.portfolio) {
    const demand = demands.reduce((s, d) => s + amountOf(d.demand, limit.resource), 0n);
    if (demand === 0n) continue;
    const required = demand > limit.atoms ? demand - limit.atoms : 0n;
    if (required > 0n) feasible = false;
    lines.push({ resource: limit.resource, authorityAtoms: limit.atoms.toString(), demandAtoms: demand.toString(), requiredReductionAtoms: required.toString() });
  }
  const agentExcess: AgentExcess[] = [];
  for (const { p, demand } of demands) {
    for (const a of demand) {
      const own = headroom(av, p.agent.value, a.resource);
      if (a.atoms > own) {
        feasible = false;
        agentExcess.push({ role: p.role, resource: a.resource, requestedAtoms: a.atoms, limitAtoms: own });
      }
    }
  }
  const pn = lines.find((l) => l.resource === 'portfolio-notional');
  return {
    feasible,
    lines,
    agentExcess,
    demandAtoms: pn === undefined ? 0n : BigInt(pn.demandAtoms),
    authorityAtoms: amountOf(av.portfolio, 'portfolio-notional'),
    requiredAtoms: pn === undefined ? 0n : BigInt(pn.requiredReductionAtoms),
  };
}

const view = (atoms: string) => ({ atoms, amount: usdcText(BigInt(atoms)) });

/**
 * The typed-resource conflicts of a fit, one per resource, for telemetry:
 * the constraint lines that need a reduction, as they are. Never summed —
 * a USDC of derivative notional and a USDC of portfolio notional are
 * different limits, and reducing one request can satisfy both.
 */
export function conflictsOf(fit: Fit) {
  return fit.lines.filter((l) => l.requiredReductionAtoms !== '0').map((l) => ({ resource: l.resource, authority: view(l.authorityAtoms), demand: view(l.demandAtoms), requiredReduction: view(l.requiredReductionAtoms) }));
}

/** Each conflict the Room opened with, and what is left of it under the requests now in hand. */
export function resolutionOf(opened: Fit, now: Fit) {
  return conflictsOf(opened).map((c) => {
    const line = now.lines.find((l) => l.resource === c.resource);
    const remaining = line?.requiredReductionAtoms ?? '0';
    return { ...c, demandAfter: view(line?.demandAtoms ?? '0'), remainingReduction: view(remaining), status: remaining === '0' ? 'SATISFIED' : 'UNRESOLVED' };
  });
}

export function permittedActions(p: Participant): readonly NegotiationAction[] {
  return p.candidate.resizable ? ['KEEP', 'REDUCE', 'RELEASE', 'ABSTAIN'] : ['KEEP', 'RELEASE', 'ABSTAIN'];
}
