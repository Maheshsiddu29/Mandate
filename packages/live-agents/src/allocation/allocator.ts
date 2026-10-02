/**
 * The deterministic allocator (docs/v2/mandate-room-v2.md §7).
 *
 * Dollars are decided here, and only here: never by a model's number, never
 * by Jev's. Pure: bigint arithmetic, no clock, no randomness, no I/O.
 *
 * ```text
 * weight   0 for ABSTAIN, dataConfidence 0, or model utility below MIN_UTILITY
 *          utility = opportunityQuality + liquidity + executionQuality + (4 − downsideRisk) + dataConfidence   (0–20)
 *          weight  = utility × (no score: 10,000 | score: 5,000 + bps / 2)                               (Jev: 0.5×–1.5×)
 * cap      min(maximumUseful, hard cap), whole USDC; a cap below minimumUseful takes nothing
 * loop     share = ⌊remaining × weight / Σ weight⌋ (whole USDC) over the active agents, in role order
 *          a share at or over its cap is fixed at the cap; the rest is shared again   (water-filling)
 *          a share below minimumUseful drops the lowest-weight such agent (tie: the later role) and starts over
 * result   budgets; whatever is left — including rounding — stays unallocated
 * ```
 *
 * Input order never matters: agents are processed in canonical role order
 * and ties break on it. Leftover capital is never pushed into a weak card.
 */

import type { OpportunityCard } from './card.ts';
import { METRIC_MAX } from '../runtime/schemas.ts';
import { ROLES, type Role } from '../types.ts';

/** Budgets are whole USDC. */
export const GRANULARITY = 1_000_000n;
/** Below this model utility (of 20) a card is not strong enough to be given capital. */
export const MIN_UTILITY = 8;
const NEUTRAL_FACTOR = 10_000n;

export interface AllocationEntry {
  readonly card: OpportunityCard;
  /** A validated Jev score in basis points (jev/scorer.ts `scoreBps`), or null. */
  readonly jevBps: number | null;
  /** The most the agent may hold under the principal's authority: its ceiling, a domain cap, the candidate's depth. */
  readonly hardCapAtoms: bigint;
}

export type ZeroReason = 'ABSTAINED' | 'NO_DATA_CONFIDENCE' | 'BELOW_UTILITY_THRESHOLD' | 'NO_CAPACITY' | 'BELOW_MINIMUM_USEFUL';

export interface AgentAllocation {
  readonly role: Role;
  readonly atoms: bigint;
  readonly weight: bigint;
  readonly utility: number;
  readonly capAtoms: bigint;
  /** Why it received nothing; null when it received capital. */
  readonly zero: ZeroReason | null;
  /** It received its full cap. */
  readonly capped: boolean;
}

export type AllocationResult =
  | { readonly ok: true; readonly poolAtoms: bigint; readonly allocations: readonly AgentAllocation[]; readonly allocatedAtoms: bigint; readonly unallocatedAtoms: bigint }
  | { readonly ok: false; readonly reason: 'DUPLICATE_ROLE' | 'PLAN_OBSERVATIONS_INCOHERENT' | 'NEGATIVE_INPUT' | 'INVALID_SCORE' };

export function modelUtility(c: OpportunityCard): number {
  const m = c.metrics;
  return m.opportunityQuality + m.liquidity + m.executionQuality + (METRIC_MAX - m.downsideRisk) + m.dataConfidence;
}

function zeroReason(c: OpportunityCard): ZeroReason | null {
  if (c.action === 'ABSTAIN') return 'ABSTAINED';
  if (c.metrics.dataConfidence === 0) return 'NO_DATA_CONFIDENCE';
  if (modelUtility(c) < MIN_UTILITY) return 'BELOW_UTILITY_THRESHOLD';
  return null;
}

export function weightOf(c: OpportunityCard, jevBps: number | null): bigint {
  if (zeroReason(c) !== null) return 0n;
  const factor = jevBps === null ? NEUTRAL_FACTOR : 5_000n + BigInt(jevBps) / 2n;
  return BigInt(modelUtility(c)) * factor;
}

const whole = (atoms: bigint): bigint => atoms - (atoms % GRANULARITY);
const roleIndex = (r: Role): number => ROLES.indexOf(r);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * Cards are comparable only if they describe one moment: every proposing
 * card was observed before every other one went stale.
 */
export function coherent(cards: readonly OpportunityCard[]): boolean {
  const live = cards.filter((c) => c.action === 'PROPOSE');
  if (live.length === 0) return true;
  const latest = live.reduce((m, c) => (c.observedAt > m ? c.observedAt : m), live[0]?.observedAt ?? 0n);
  return live.every((c) => c.freshUntil >= latest);
}

export function allocate(poolAtoms: bigint, entries: readonly AllocationEntry[]): AllocationResult {
  if (poolAtoms < 0n || entries.some((e) => e.hardCapAtoms < 0n)) return { ok: false, reason: 'NEGATIVE_INPUT' };
  if (new Set(entries.map((e) => e.card.role)).size !== entries.length) return { ok: false, reason: 'DUPLICATE_ROLE' };
  if (entries.some((e) => e.jevBps !== null && (!Number.isInteger(e.jevBps) || e.jevBps < 0 || e.jevBps > 10_000))) return { ok: false, reason: 'INVALID_SCORE' };
  if (!coherent(entries.map((e) => e.card))) return { ok: false, reason: 'PLAN_OBSERVATIONS_INCOHERENT' };

  const sorted = [...entries].sort((a, b) => roleIndex(a.card.role) - roleIndex(b.card.role));
  const rows = sorted.map((e) => {
    const capAtoms = whole(min(e.card.maximumUsefulAtoms, e.hardCapAtoms));
    const weight = weightOf(e.card, e.jevBps);
    let zero = zeroReason(e.card);
    if (zero === null && (capAtoms === 0n || capAtoms < e.card.minimumUsefulAtoms)) zero = 'NO_CAPACITY';
    return { role: e.card.role, minimum: e.card.minimumUsefulAtoms, capAtoms, weight: zero === null ? weight : 0n, utility: modelUtility(e.card), zero };
  });

  const result = new Map<Role, bigint>();
  const dropped = new Set<Role>();
  for (;;) {
    const fixed = new Map<Role, bigint>();
    let active = rows.filter((r) => r.zero === null && !dropped.has(r.role));
    let shares = new Map<Role, bigint>();
    for (;;) {
      const remaining = poolAtoms - [...fixed.values()].reduce((s, v) => s + v, 0n);
      const total = active.reduce((s, r) => s + r.weight, 0n);
      shares = new Map(active.map((r) => [r.role, remaining <= 0n || total === 0n ? 0n : whole((remaining * r.weight) / total)]));
      const capped = active.filter((r) => (shares.get(r.role) as bigint) >= r.capAtoms);
      if (capped.length === 0) break;
      for (const r of capped) fixed.set(r.role, r.capAtoms);
      active = active.filter((r) => !capped.includes(r));
    }
    const all = new Map<Role, bigint>([...fixed, ...shares]);
    const short = rows.filter((r) => all.has(r.role) && (all.get(r.role) as bigint) < r.minimum);
    if (short.length === 0) {
      for (const [r, v] of all) result.set(r, v);
      break;
    }
    // Drop the weakest agent that cannot reach its minimum useful size (ties: the later role), and share again.
    const weakest = short.reduce((w, r) => (r.weight < w.weight || (r.weight === w.weight && roleIndex(r.role) > roleIndex(w.role)) ? r : w));
    dropped.add(weakest.role);
  }

  const allocations: AgentAllocation[] = rows.map((r) => {
    const atoms = result.get(r.role) ?? 0n;
    const zero = r.zero ?? (dropped.has(r.role) ? 'BELOW_MINIMUM_USEFUL' : atoms === 0n ? 'NO_CAPACITY' : null);
    return { role: r.role, atoms: zero === null ? atoms : 0n, weight: r.weight, utility: r.utility, capAtoms: r.capAtoms, zero, capped: zero === null && atoms === r.capAtoms };
  });
  const allocatedAtoms = allocations.reduce((s, a) => s + a.atoms, 0n);
  return { ok: true, poolAtoms, allocations, allocatedAtoms, unallocatedAtoms: poolAtoms - allocatedAtoms };
}
