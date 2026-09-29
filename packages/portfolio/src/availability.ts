/**
 * Resource availability: what the ledger still has room for, as the room and
 * the verifier read it (portfolio-mandate.md §10, §11).
 *
 * A pure value. The reservation layer builds it from a ledger snapshot
 * (`availabilityFrom`); before anything is reserved it is simply the
 * mandate's own limits (`fullAvailability`). The room and verifier cap every
 * approval by it, and the ledger's compare-and-swap re-checks every leg at
 * commit anyway — availability read earlier can only make the portfolio layer
 * refuse more, never let the ledger reserve more.
 */

import type { PortfolioMandate } from './mandate.ts';
import { amountOf, type ResourceVector } from './resources.ts';

export interface ResourceAvailability {
  /** The ledger version it was read at; 0 for a mandate with nothing reserved. */
  readonly ledgerVersion: bigint;
  /** Per portfolio-limited resource: what the root's leg can still take. */
  readonly portfolio: ResourceVector;
  /** Per agent (by party value): what each listed hard maximum can still take. */
  readonly agents: ReadonlyMap<string, ResourceVector>;
  /** Per portfolio-limited resource: what is already reserved at the root's leg. */
  readonly reserved: ResourceVector;
}

export function fullAvailability(m: PortfolioMandate): ResourceAvailability {
  return {
    ledgerVersion: 0n,
    portfolio: m.limits,
    agents: new Map(m.agents.map((a) => [a.agent.value, a.hardMaxima])),
    reserved: m.limits.map((l) => ({ resource: l.resource, atoms: 0n }) as ResourceVector[number]),
  };
}

/** The most `agent` could still take of `resource`: the portfolio's headroom and, where it lists one, its own. */
export function headroom(av: ResourceAvailability, agent: string, resource: string): bigint {
  const portfolio = amountOf(av.portfolio, resource);
  const own = av.agents.get(agent)?.find((a) => a.resource === resource);
  return own === undefined || own.atoms > portfolio ? portfolio : own.atoms;
}
