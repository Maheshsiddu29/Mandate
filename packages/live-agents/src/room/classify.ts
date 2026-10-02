/**
 * What a conflict after screening *is*, and who may resolve it
 * (docs/v2/mandate-room-v2.md §8.1). Replaces `!fit.feasible → Room`.
 *
 * | class | condition | handling |
 * | --- | --- | --- |
 * | VALID_AND_FITS | every request fits | the verifier, directly |
 * | AGENT_LOCAL_EXCESS | an agent over its own headroom, or the only agent demanding a resource that is over | that agent's own bounded re-plan; never a Room |
 * | SHARED_CONFLICT | two or more agents demanding the same over-limit resource | a Room only if the principal authorized coordination; otherwise the verifier refuses deterministically |
 *
 * Security-invalid proposals never reach here: screening blocked them.
 * Pure: it reads a fit and decides nothing.
 */

import { amountOf, headroom, type ResourceAvailability } from '@mandate/portfolio';
import type { Role } from '../types.ts';
import { assess, type DemandAt, type Fit, type Participant } from './negotiation.ts';

export interface LocalExcess {
  readonly role: Role;
  readonly resource: string;
  readonly demandAtoms: bigint;
  readonly limitAtoms: bigint;
  /** OWN_LIMIT: the agent's own headroom. SOLE_DEMANDER: a portfolio limit only this agent's request uses. */
  readonly cause: 'OWN_LIMIT' | 'SOLE_DEMANDER';
}

export interface SharedConflict {
  readonly resource: string;
  readonly demanders: readonly Role[];
  readonly demandAtoms: bigint;
  readonly authorityAtoms: bigint;
  readonly requiredReductionAtoms: bigint;
}

export type RoomPurpose = 'INITIAL_ALLOCATION' | 'HYBRID_ALLOCATION' | 'REALLOCATION' | 'SHARED_RESOURCE_COORDINATION';

export interface Classification {
  readonly kind: 'VALID_AND_FITS' | 'AGENT_LOCAL_EXCESS' | 'SHARED_CONFLICT';
  readonly local: readonly LocalExcess[];
  readonly shared: readonly SharedConflict[];
  /** The Room this conflict may open, or null: never for a local excess, never without coordination authority. */
  readonly roomPurpose: RoomPurpose | null;
  readonly handling: 'DIRECT' | 'LOCAL_REPLAN' | 'ROOM' | 'DETERMINISTIC_REFUSAL';
}

export function classifyConflict(fit: Fit, participants: readonly Participant[], requests: ReadonlyMap<Role, bigint>, demandAt: DemandAt, coordinationAuthorized: boolean): Classification {
  if (fit.feasible) return { kind: 'VALID_AND_FITS', local: [], shared: [], roomPurpose: null, handling: 'DIRECT' };
  const demands = participants.map((p) => ({ p, demand: demandAt(p, requests.get(p.role) ?? 0n) }));
  const local: LocalExcess[] = fit.agentExcess.map((x) => ({ role: x.role, resource: x.resource, demandAtoms: x.requestedAtoms, limitAtoms: x.limitAtoms, cause: 'OWN_LIMIT' as const }));
  const shared: SharedConflict[] = [];
  for (const line of fit.lines) {
    const required = BigInt(line.requiredReductionAtoms);
    if (required === 0n) continue;
    const demanders = demands.filter((d) => amountOf(d.demand, line.resource) > 0n).map((d) => d.p.role);
    if (demanders.length === 1) {
      const role = demanders[0] as Role;
      if (!local.some((l) => l.role === role && l.resource === line.resource)) local.push({ role, resource: line.resource, demandAtoms: BigInt(line.demandAtoms), limitAtoms: BigInt(line.authorityAtoms), cause: 'SOLE_DEMANDER' });
    } else {
      shared.push({ resource: line.resource, demanders, demandAtoms: BigInt(line.demandAtoms), authorityAtoms: BigInt(line.authorityAtoms), requiredReductionAtoms: required });
    }
  }
  if (local.length > 0) return { kind: 'AGENT_LOCAL_EXCESS', local, shared, roomPurpose: null, handling: 'LOCAL_REPLAN' };
  const parties = new Set(shared.flatMap((s) => s.demanders));
  const room = coordinationAuthorized && parties.size >= 2;
  return { kind: 'SHARED_CONFLICT', local, shared, roomPurpose: room ? 'SHARED_RESOURCE_COORDINATION' : null, handling: room ? 'ROOM' : 'DETERMINISTIC_REFUSAL' };
}

/**
 * The largest whole-USDC size, between the candidate's minimum and `upTo`,
 * at which this participant — everyone else unchanged — is over neither its
 * own headroom nor a portfolio limit only it demands. Exact search over the
 * binding's own demand function; `null` when even the minimum does not fit.
 */
export function largestFittingAtoms(p: Participant, participants: readonly Participant[], requests: ReadonlyMap<Role, bigint>, av: ResourceAvailability, demandAt: DemandAt, upTo: bigint): bigint | null {
  const fits = (atoms: bigint): boolean => {
    const trial = new Map(requests);
    trial.set(p.role, atoms);
    const f = assess(participants, trial, av, demandAt);
    if (f.agentExcess.some((x) => x.role === p.role)) return false;
    const own = demandAt(p, atoms);
    for (const a of own) if (a.atoms > headroom(av, p.agent.value, a.resource)) return false;
    const c = classifyConflict(f, participants, trial, demandAt, false);
    return !c.local.some((l) => l.role === p.role);
  };
  const unit = 1_000_000n;
  let lo = p.candidate.minAtoms;
  if (lo > upTo || !fits(lo)) return null;
  let hi = upTo - (upTo % unit);
  if (hi < lo) return lo;
  if (fits(hi)) return hi;
  // Invariant: fits(lo), !fits(hi). Search whole USDC between them.
  while (hi - lo > unit) {
    const mid = lo + (((hi - lo) / unit / 2n) * unit || unit);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
