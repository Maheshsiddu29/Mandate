/** Build the security-relevant initial allocation from one fully reviewed draft. */

import { initialAllocationDigest, portfolioMandateDigest, validateInitialAllocationPlan, type InitialAllocationPlan, type PortfolioMandate } from '@mandate/portfolio';
import { demoParty } from '@mandate/portfolio/demo';
import type { MandateDraft } from '../authoring/draft-types.ts';
import { classifyAllocation } from './intent.ts';

export type InitialAllocationResult =
  | { readonly ok: true; readonly plan: InitialAllocationPlan; readonly digest: string }
  | { readonly ok: false; readonly reason: 'AGENT_SELECTION_INCOMPLETE' | 'ALLOCATION_INCOMPLETE' | 'ALLOCATION_INVALID' };

/**
 * The accepted plan is derived from the same draft that compiles to
 * `mandate`. Every enabled agent is present, including abstainers at zero.
 */
export function initialAllocationOf(draft: MandateDraft, mandate: PortfolioMandate): InitialAllocationResult {
  const view = classifyAllocation(draft);
  if (view.intent === 'NEEDS_AGENT_SELECTION') return { ok: false, reason: 'AGENT_SELECTION_INCOMPLETE' };
  if (view.deployableAtoms === null || (!view.autoReallocate && view.enabled.some((role) => view.budgets[role] === null))) return { ok: false, reason: 'ALLOCATION_INCOMPLETE' };
  // An explicit live-coordination preset may intentionally sign before an
  // optional plan. Its exact starting plan is then zero for every agent and
  // the whole deployable envelope unallocated; later movement is reallocation.
  const budget = (role: (typeof view.enabled)[number]) => view.budgets[role] ?? 0n;
  const allocated = view.enabled.reduce((sum, role) => sum + budget(role), 0n);
  if (allocated > view.deployableAtoms) return { ok: false, reason: 'ALLOCATION_INVALID' };
  const validated = validateInitialAllocationPlan(
    {
      portfolioMandateDigest: portfolioMandateDigest(mandate),
      totalCapitalAtoms: view.deployableAtoms,
      mode: view.intent,
      autoReallocate: view.autoReallocate,
      entries: view.enabled.map((role) => ({ agent: demoParty(role), allocatedAtoms: budget(role), source: view.fixed.includes(role) ? 'FIXED' : 'PLANNED' })),
      unallocatedAtoms: view.deployableAtoms - allocated,
    },
    mandate,
  );
  if (!validated.ok) return { ok: false, reason: 'ALLOCATION_INVALID' };
  return { ok: true, plan: validated.value, digest: initialAllocationDigest(validated.value) };
}
