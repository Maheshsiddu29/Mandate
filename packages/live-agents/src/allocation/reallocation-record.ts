/** Durable evidence of a post-sign allocation change. It grants no authority. */

import { agentPolicyOf, amountOf, initialAllocationDigest, validateInitialAllocationPlan, initialAllocationPlanInputOf, type InitialAllocationPlan, type PortfolioMandate } from '@mandate/portfolio';
import { demoParty } from '@mandate/portfolio/demo';
import type { Role } from '../types.ts';

export const REALLOCATION_RECORD_SCHEMA = 'mandate-reallocation-record/v1';

export interface ReallocationRecordV1 {
  readonly schema: typeof REALLOCATION_RECORD_SCHEMA;
  readonly reallocationId: string;
  readonly sessionId: string;
  readonly initialAllocationDigest: string;
  readonly previousPlanDigest: string;
  readonly nextPlanDigest: string;
  readonly nextPlan: InitialAllocationPlan;
  readonly released: readonly { readonly role: Role; readonly atoms: bigint }[];
  readonly assigned: readonly { readonly role: Role; readonly atoms: bigint }[];
  readonly reason: 'RELEASED_UNUSED_CAPITAL';
  readonly roomId: string;
  readonly generation: number;
  readonly mandateVersion: number;
  readonly timestamp: bigint;
  readonly evidenceDigests: readonly string[];
}

export function nextAllocationPlan(
  previous: InitialAllocationPlan,
  mandate: PortfolioMandate,
  released: readonly { readonly role: Role; readonly atoms: bigint }[],
  assigned: readonly { readonly role: Role; readonly atoms: bigint }[],
): InitialAllocationPlan | null {
  const byAgent = new Map<string, (typeof previous.entries)[number]>(previous.entries.map((entry) => [entry.agent.value as string, { ...entry }]));
  for (const item of released) {
    const key = demoParty(item.role).value;
    const entry = byAgent.get(key);
    if (entry === undefined || entry.allocatedAtoms < item.atoms) return null;
    byAgent.set(key, { ...entry, allocatedAtoms: entry.allocatedAtoms - item.atoms });
  }
  for (const item of assigned) {
    const key = demoParty(item.role).value;
    const entry = byAgent.get(key);
    if (entry === undefined) return null;
    const next = entry.allocatedAtoms + item.atoms;
    const policy = agentPolicyOf(mandate, entry.agent);
    if (policy === null || next > amountOf(policy.hardMaxima, 'portfolio-notional')) return null;
    byAgent.set(key, { ...entry, allocatedAtoms: next });
  }
  const entries = previous.entries.map((entry) => byAgent.get(entry.agent.value) as (typeof previous.entries)[number]);
  const allocated = entries.reduce((sum, entry) => sum + entry.allocatedAtoms, 0n);
  if (allocated > previous.totalCapitalAtoms) return null;
  const checked = validateInitialAllocationPlan(initialAllocationPlanInputOf({ ...previous, entries, unallocatedAtoms: previous.totalCapitalAtoms - allocated } as InitialAllocationPlan), mandate);
  return checked.ok ? checked.value : null;
}

export const planDigest = (plan: InitialAllocationPlan): string => initialAllocationDigest(plan);
