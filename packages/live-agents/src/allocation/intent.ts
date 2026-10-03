/**
 * Allocation intent: who decides how the principal's capital is split
 * (docs/v2/mandate-room-v2.md §3).
 *
 * ```text
 * some agent's enabled unset          NEEDS_AGENT_SELECTION   ask the principal; never granted by default
 * every enabled agent has a budget
 *   the principal set               FIXED                   no Planning Room
 * no enabled agent has one          DYNAMIC                 Planning Room over the whole deployable total
 * some do                           HYBRID                  Planning Room over the remainder, for the rest
 * ```
 *
 * A budget is the principal's when it came from their words or their hand
 * (`HUMAN_FIELD_SOURCES`); one accepted from a Planning Room proposal is
 * `PLANNED` and its agent stays in the delegated pool. Pure: it reads a
 * draft and decides nothing — validation and the verifier do.
 */

import { deployable } from '../authoring/conflicts.ts';
import { HUMAN_FIELD_SOURCES, type MandateDraft } from '../authoring/draft-types.ts';
import { ROLES, parseCount, parseUsdc, type Role } from '../types.ts';

export const ALLOCATION_INTENTS = ['FIXED', 'DYNAMIC', 'HYBRID', 'NEEDS_AGENT_SELECTION'] as const;
export type AllocationIntent = (typeof ALLOCATION_INTENTS)[number];

/**
 * - `NONE`: nothing to plan (FIXED, or agents still to be chosen);
 * - `REQUIRED`: delegated agents have no budget, and the signed maxima will
 *   be the budgets (no reallocation), so a split must exist before signing;
 * - `OPTIONAL`: delegated agents have no budget, but the principal authorized
 *   live coordination inside the signed maxima (`autoReallocate`);
 * - `COMPLETE`: every delegated agent has a budget.
 */
export type PlanningState = 'NONE' | 'REQUIRED' | 'OPTIONAL' | 'COMPLETE';

export interface AllocationView {
  readonly intent: AllocationIntent;
  /** Agents whose `enabled` is true, in role order. */
  readonly enabled: readonly Role[];
  /** Agents whose `enabled` is still unset: the principal must choose. */
  readonly undecided: readonly Role[];
  /** Enabled agents whose budget the principal set. The Room never changes these. */
  readonly fixed: readonly Role[];
  /** Enabled agents the principal left to the Room. */
  readonly pool: readonly Role[];
  /** Each role's budget in USDC atoms, or null when unset or malformed. */
  readonly budgets: { readonly [R in Role]: bigint | null };
  readonly autoReallocate: boolean;
  readonly planning: PlanningState;
  /** The deployable total (the signed portfolio-notional limit), when the draft's numbers are consistent. */
  readonly deployableAtoms: bigint | null;
  /** Σ of the principal's fixed budgets. */
  readonly fixedAtoms: bigint;
  /** What the Room may split: deployable − fixed (never negative); null when deployable is unknown. */
  readonly poolAtoms: bigint | null;
}

/** The deployable total a draft would sign, or null when its numbers are unset or inconsistent. */
export function draftDeployable(d: MandateDraft): bigint | null {
  const p = d.portfolio;
  const total = p.totalCapital === null ? null : parseUsdc(p.totalCapital);
  const minUnallocated = p.minUnallocated === null ? 0n : parseUsdc(p.minUnallocated);
  const maxDeployed = p.maxDeployed === null ? null : parseUsdc(p.maxDeployed);
  const validity = p.validityMinutes === null ? 1 : parseCount(p.validityMinutes, 100_000_000);
  if (total === null || minUnallocated === null || validity === null) return null;
  const deployAll = p.deployAll === true;
  if (!deployAll && maxDeployed === null) return null;
  return deployable({ total, minUnallocated, maxDeployed, deployAll, validityMinutes: validity });
}

export function classifyAllocation(d: MandateDraft): AllocationView {
  const enabled = ROLES.filter((r) => d.agents[r].enabled === true);
  const undecided = ROLES.filter((r) => d.agents[r].enabled === null);
  const budgets = Object.fromEntries(ROLES.map((r) => [r, d.agents[r].budget === null ? null : parseUsdc(d.agents[r].budget as string)])) as { [R in Role]: bigint | null };
  const human = (r: Role) => budgets[r] !== null && HUMAN_FIELD_SOURCES.has(d.provenance[`agents.${r}.budget`] ?? 'PRESET');
  const fixed = enabled.filter(human);
  const pool = enabled.filter((r) => !human(r));
  const autoReallocate = d.portfolio.autoReallocate === true;
  const intent: AllocationIntent = undecided.length > 0 ? 'NEEDS_AGENT_SELECTION' : pool.length === 0 ? 'FIXED' : fixed.length === 0 ? 'DYNAMIC' : 'HYBRID';
  const planning: PlanningState =
    intent === 'FIXED' || intent === 'NEEDS_AGENT_SELECTION' ? 'NONE' : pool.every((r) => budgets[r] !== null) ? 'COMPLETE' : autoReallocate ? 'OPTIONAL' : 'REQUIRED';
  const deployableAtoms = draftDeployable(d);
  const fixedAtoms = fixed.reduce((s, r) => s + (budgets[r] as bigint), 0n);
  const poolAtoms = deployableAtoms === null ? null : deployableAtoms > fixedAtoms ? deployableAtoms - fixedAtoms : 0n;
  return { intent, enabled, undecided, fixed, pool, budgets, autoReallocate, planning, deployableAtoms, fixedAtoms, poolAtoms };
}

/** The Room purpose a planning pass would have, or null when there is nothing to plan. */
export function planningPurpose(v: AllocationView): 'INITIAL_ALLOCATION' | 'HYBRID_ALLOCATION' | null {
  if (v.intent === 'DYNAMIC') return 'INITIAL_ALLOCATION';
  if (v.intent === 'HYBRID') return 'HYBRID_ALLOCATION';
  return null;
}
