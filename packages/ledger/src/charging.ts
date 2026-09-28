/**
 * Charging paths and the availability check (authority-ledger.md §3, §6, §8).
 *
 * The charging path of an action under leaf `N` is `N`'s lineage, leaf to
 * root, followed by the principal policy. A contribution has one **leg** at
 * every `(node, dimension)` on the path whose dimension matches it: equal kind
 * and unit, and every scope attribute the dimension names present in the
 * contribution and equal. A dimension with an empty scope receives every
 * contribution of its kind and unit — in any domain, under any module — which
 * is how a root's capital is shared by spot and perp agents, and how a
 * principal-global dimension is shared by every root.
 *
 * The path is derived here and nowhere else, from the ledger state and the
 * plan. A caller never names a target, so none can be omitted.
 *
 * Rules the derivation enforces (each a refusal, never a skip):
 *
 * - **LEDGER-5, closed world.** A required contribution must match a
 *   dimension *granted on the lineage*. A principal-global dimension alone
 *   does not satisfy it: the policy grants nothing (decision 24), so a policy
 *   ceiling on capital must not become a capital grant to a root that has
 *   none (`UNBOUNDED_CONTRIBUTION`). See implementation-7c.md §10 item 1.
 * - **Exact scale.** A leg's amount is the contribution's rescaled exactly to
 *   the dimension's decimals; an inexact rescale refuses, because no rounding
 *   direction is defined yet (UNIT-4).
 * - **Sign.** `NET` dimensions are not implemented; a contribution that
 *   matches one refuses rather than bypassing it.
 * - **Epoch.** An `EPOCH` leg records the window of the evaluation time; a
 *   budget whose first window has not started refuses.
 *
 * Availability is then checked per target on the aggregate of every leg of
 * the plan at that target, and every failing target is reported.
 */

import { ok } from '@mandate/kernel';
import {
  UINT256_MAX,
  policyDimensions,
  resourceIdsEqual,
  type AuthorityId,
  type DomainId,
  type LedgerDimensionTerm,
  type PrincipalPolicyId,
  type ResourceId,
} from '@mandate/core';
import type { Contribution } from './charge-plan.ts';
import { rescaleExact } from './encoding.ts';
import { refuse, type LedgerResult, type LimitFailure, type TargetRef } from './errors.ts';
import {
  availableOf,
  epochIndex,
  nodeTargetKey,
  policyDimensionIdentity,
  policyTargetKey,
  type LedgerState,
  type LegRecord,
  type NodeRecord,
  type TargetBalance,
} from './state.ts';

function scopeMatches<R extends ResourceId>(want: R | null, have: R | null): boolean {
  return want === null || (have !== null && resourceIdsEqual(want, have));
}

/** authority-ledger.md §3, "Matching". */
export function contributionMatches(c: Contribution, domain: DomainId, d: LedgerDimensionTerm): boolean {
  const q = c.quantity;
  return (
    q.kind === d.limit.kind &&
    q.unit === d.limit.unit &&
    scopeMatches(d.scope.asset, q.asset) &&
    scopeMatches(d.scope.market, c.market) &&
    (d.scope.domain === null || d.scope.domain === domain) &&
    scopeMatches(d.scope.account, c.account)
  );
}

export interface LegDraft {
  readonly key: string;
  readonly ref: TargetRef;
  readonly dimension: LedgerDimensionTerm;
  /** At the dimension's decimals. */
  readonly amount: bigint;
  readonly epoch: bigint | null;
}

function legFor(key: string, ref: TargetRef, d: LedgerDimensionTerm, c: Contribution, at: bigint, path: string, node: AuthorityId | null): LedgerResult<LegDraft> {
  if (d.sign === 'NET') return refuse('NET_DIMENSION_UNSUPPORTED', path, node);
  const amount = rescaleExact(c.quantity.atoms, c.quantity.decimals, d.limit.decimals);
  if (amount === null) return refuse('INEXACT_RESCALE', path, node);
  let epoch: bigint | null = null;
  if (d.restoration === 'EPOCH') {
    epoch = epochIndex(d, at);
    if (epoch === null) return refuse('EPOCH_NOT_STARTED', path, node);
  }
  return ok({ key, ref, dimension: d, amount, epoch });
}

/**
 * Every leg of every contribution, in canonical order: contribution by
 * contribution; within one, the lineage leaf to root, each node's dimensions
 * in its grant's canonical term order, then the policy's dimensions.
 */
export function deriveLegs(
  lineage: readonly NodeRecord[],
  policyId: PrincipalPolicyId,
  policyDims: readonly LedgerDimensionTerm[],
  contributions: readonly Contribution[],
  domain: DomainId,
  at: bigint,
  path = 'plan.contributions',
): LedgerResult<readonly (readonly LegDraft[])[]> {
  const out: LegDraft[][] = [];
  for (let i = 0; i < contributions.length; i += 1) {
    const c = contributions[i] as Contribution;
    const cp = `${path}[${i}]`;
    const legs: LegDraft[] = [];
    for (const node of lineage) {
      for (const t of node.grant.terms) {
        if (t.kind !== 'LEDGER_DIMENSION' || !contributionMatches(c, domain, t)) continue;
        const leg = legFor(nodeTargetKey(node.id, t.dimensionId), { kind: 'NODE', authority: node.id, dimensionId: t.dimensionId }, t, c, at, cp, node.id);
        if (!leg.ok) return leg;
        legs.push(leg.value);
      }
    }
    if (c.required && legs.length === 0) return refuse('UNBOUNDED_CONTRIBUTION', cp, (lineage[0] as NodeRecord).id);
    for (const d of policyDims) {
      if (!contributionMatches(c, domain, d)) continue;
      const leg = legFor(policyTargetKey(policyDimensionIdentity(d)), { kind: 'POLICY', policy: policyId, dimensionId: d.dimensionId }, d, c, at, cp, null);
      if (!leg.ok) return leg;
      legs.push(leg.value);
    }
    out.push(legs);
  }
  return ok(out);
}

export function policyDimsOf(state: LedgerState): readonly LedgerDimensionTerm[] {
  return state.policy === null ? [] : policyDimensions(state.policy.policy);
}

/**
 * `AuthorityAvailable` over the aggregate demand at each target
 * (authority-ledger.md §8). All-or-nothing: every failing target is
 * reported and nothing is reserved.
 */
export function checkAvailability(state: LedgerState, legs: readonly (readonly LegDraft[])[], at: bigint, path = 'plan'): LedgerResult<ReadonlyMap<string, bigint>> {
  const demand = new Map<string, bigint>();
  const order: LegDraft[] = [];
  for (const perContribution of legs) {
    for (const leg of perContribution) {
      const prev = demand.get(leg.key);
      if (prev === undefined) order.push(leg);
      demand.set(leg.key, (prev ?? 0n) + leg.amount);
    }
  }
  const failures: LimitFailure[] = [];
  for (const leg of order) {
    const balance = state.targets.get(leg.key) as TargetBalance;
    const requested = demand.get(leg.key) as bigint;
    if (balance.reserved + requested > UINT256_MAX) return refuse('AMOUNT_OVERFLOW', path, leg.ref.kind === 'NODE' ? leg.ref.authority : null);
    const available = availableOf(balance, at);
    if (requested > available) {
      failures.push({
        target: leg.ref,
        kind: leg.dimension.limit.kind,
        unit: leg.dimension.limit.unit,
        decimals: leg.dimension.limit.decimals,
        requested,
        available,
        limit: leg.dimension.limit.atoms,
      });
    }
  }
  if (failures.length > 0) return { ok: false, error: { code: 'LEDGER_LIMIT_EXCEEDED', path, failures } };
  return ok(demand);
}

/** The records a reservation keeps for each leg: its charge attribution. */
export function legRecordOf(leg: LegDraft): LegRecord {
  return {
    key: leg.key,
    ref: leg.ref,
    decimals: leg.dimension.limit.decimals,
    capacity: leg.dimension.accounting === 'CAPACITY',
    epoch: leg.epoch,
  };
}
