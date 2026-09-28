/**
 * Effective authority: the meet of every grant on a lineage (AUTH-2, second
 * half; authority-model.md §4).
 *
 * Core does not trust that registration happened correctly. For every
 * decision, the acting node's authority is recomputed as the meet of every
 * node from the leaf to the root, so a widening grant that somehow reached the
 * ledger still widens nothing: the result is never wider than any ancestor's
 * terms.
 *
 * | kind            | meet over the lineage                                              |
 * | --------------- | ------------------------------------------------------------------ |
 * | SET             | intersection per vocabulary; a vocabulary any node lacks is absent  |
 * | RIGHT           | conjunction; `DELEGATE` depth is the depth meet                     |
 * | BOUND           | per key: min of ceilings, max of floors; incomparable ⇒ refused      |
 * | validity        | intersection                                                        |
 * | TIME_WINDOW     | intersection per domain                                             |
 * | STATE_INVARIANT | union (all must hold); the principal policy's kept separately       |
 * | STATE_POLICY    | per (domain, kind): intersection of sources, every requirement held |
 * | LEDGER_DIMENSION| **not meet-reduced**: every node's dimensions are legs of the path  |
 *
 * The effective invariants and state policy are data here: they are
 * evaluated in 7D. Only the module set is enforced by the ledger in 7C
 * (DOM-2); the other coverage checks need the action's parameters.
 */

import { ok } from '@mandate/kernel';
import {
  bytesToHex,
  encodeWith,
  moduleRefsEqual,
  policyInvariants,
  policyStatePolicy,
  termKey,
  writeStateRequirement,
  type AgentId,
  type AuthorityId,
  type DomainId,
  type ModuleRef,
  type PerActionBoundTerm,
  type PrincipalPolicy,
  type Right,
  type SetConstraintTerm,
  type SetVocabulary,
  type StateInvariantTerm,
  type StateKind,
  type StatePolicyTerm,
  type StateRequirement,
  type StateSourceId,
  type TimeWindowTerm,
} from '@mandate/core';
import { refuse, type LedgerResult } from './errors.ts';
import { effectiveDepths } from './graph.ts';
import type { NodeRecord } from './state.ts';
import { compareBoundValues, setMemberKeys } from './subset.ts';

export interface EffectiveWindow {
  readonly notBefore: bigint;
  readonly expiresAt: bigint;
  /** The intersection is empty: nothing is ever inside it. */
  readonly empty: boolean;
}

export interface EffectiveTimeWindow extends EffectiveWindow {
  readonly domain: DomainId;
}

export interface EffectiveStatePolicy {
  readonly domain: DomainId;
  readonly stateKind: StateKind;
  readonly admittedSources: readonly StateSourceId[];
  /** Every requirement from the lineage and the principal policy; all must hold (the tighter bound wins). */
  readonly requirements: readonly StateRequirement[];
}

export interface EffectiveAuthority {
  readonly leaf: AuthorityId;
  /** Leaf to root: the nodes whose ledger dimensions form the lineage part of the charging path. */
  readonly lineage: readonly AuthorityId[];
  readonly holder: AgentId;
  readonly validity: EffectiveWindow;
  /** One term per vocabulary every node grants, with the intersection of members. An absent vocabulary grants nothing. */
  readonly sets: readonly SetConstraintTerm[];
  readonly rights: readonly Exclude<Right, 'DELEGATE'>[];
  readonly delegateDepth: number;
  readonly bounds: readonly PerActionBoundTerm[];
  readonly timeWindows: readonly EffectiveTimeWindow[];
  readonly invariants: readonly StateInvariantTerm[];
  /** Principal-global invariants: constraints, never grants; evaluated in 7D over all of the principal's state. */
  readonly principalInvariants: readonly StateInvariantTerm[];
  readonly statePolicies: readonly EffectiveStatePolicy[];
}

function filterMembers(t: SetConstraintTerm, keep: (key: string) => boolean): SetConstraintTerm {
  const keys = setMemberKeys(t);
  const pick = (_: object, i: number): boolean => keep(keys[i] as string);
  switch (t.vocabulary) {
    case 'MODULES':
      return { ...t, members: t.members.filter(pick) } as SetConstraintTerm;
    case 'ADAPTERS':
      return { ...t, members: t.members.filter(pick) } as SetConstraintTerm;
    case 'MARKETS':
      return { ...t, members: t.members.filter(pick) } as SetConstraintTerm;
    case 'ASSETS':
      return { ...t, members: t.members.filter(pick) } as SetConstraintTerm;
    case 'VENUES':
      return { ...t, members: t.members.filter(pick) } as SetConstraintTerm;
    case 'RECIPIENTS':
      return { ...t, members: t.members.filter(pick) } as SetConstraintTerm;
    case 'ACTION_TYPES':
      return { ...t, members: t.members.filter(pick) } as SetConstraintTerm;
  }
}

const RIGHTS: readonly Exclude<Right, 'DELEGATE'>[] = ['OPEN_RISK', 'REDUCE_RISK', 'TRANSFER_OUT'];

export function effectiveAuthority(lineage: readonly NodeRecord[], policy: PrincipalPolicy, path = 'authority'): LedgerResult<EffectiveAuthority> {
  const leaf = lineage[0] as NodeRecord;
  const grants = lineage.map((n) => n.grant);

  let notBefore = leaf.grant.notBefore;
  let expiresAt = leaf.grant.expiresAt;
  for (const g of grants) {
    if (g.notBefore > notBefore) notBefore = g.notBefore;
    if (g.expiresAt < expiresAt) expiresAt = g.expiresAt;
  }

  // Sets: start from the leaf's vocabularies; keep a vocabulary only if every node grants it.
  const sets: SetConstraintTerm[] = [];
  for (const t of leaf.grant.terms) {
    if (t.kind !== 'SET') continue;
    let current: SetConstraintTerm | null = t;
    for (const g of grants.slice(1)) {
      if (current === null) break;
      const vocabulary: SetVocabulary = t.vocabulary;
      const other = g.terms.find((x): x is SetConstraintTerm => x.kind === 'SET' && x.vocabulary === vocabulary);
      if (other === undefined) current = null;
      else {
        const allowed = new Set(setMemberKeys(other));
        current = filterMembers(current, (k) => allowed.has(k));
      }
    }
    if (current !== null) sets.push(current);
  }

  const rights = RIGHTS.filter((r) => grants.every((g) => g.terms.some((t) => t.kind === 'RIGHT' && t.right === r)));

  // Bounds: every node's bound applies, restated or not; the tightest comparable one wins.
  const bounds = new Map<string, PerActionBoundTerm>();
  for (const g of grants) {
    for (const t of g.terms) {
      if (t.kind !== 'BOUND') continue;
      const key = termKey(t);
      const prev = bounds.get(key);
      if (prev === undefined) {
        bounds.set(key, t);
        continue;
      }
      const cmp = compareBoundValues(t.value, prev.value);
      if (cmp === null) return refuse('LINEAGE_TERMS_INCOMPARABLE', path, leaf.id);
      if ((t.polarity === 'MAX' && cmp < 0) || (t.polarity === 'MIN' && cmp > 0)) bounds.set(key, t);
    }
  }

  const windows = new Map<string, { domain: DomainId; notBefore: bigint; expiresAt: bigint }>();
  for (const g of grants) {
    for (const t of g.terms) {
      if (t.kind !== 'TIME_WINDOW') continue;
      const w: TimeWindowTerm = t;
      const prev = windows.get(w.domain);
      if (prev === undefined) windows.set(w.domain, { domain: w.domain, notBefore: w.notBefore, expiresAt: w.expiresAt });
      else {
        windows.set(w.domain, {
          domain: w.domain,
          notBefore: w.notBefore > prev.notBefore ? w.notBefore : prev.notBefore,
          expiresAt: w.expiresAt < prev.expiresAt ? w.expiresAt : prev.expiresAt,
        });
      }
    }
  }

  const invariants: StateInvariantTerm[] = [];
  const invariantSeen = new Set<string>();
  for (const g of grants) {
    for (const t of g.terms) {
      if (t.kind !== 'STATE_INVARIANT') continue;
      const k = `${termKey(t)}${t.params}`;
      if (invariantSeen.has(k)) continue;
      invariantSeen.add(k);
      invariants.push(t);
    }
  }

  const statePolicies = new Map<string, { domain: DomainId; stateKind: StateKind; sources: StateSourceId[]; requirements: Map<string, StateRequirement> }>();
  const addPolicy = (t: StatePolicyTerm): void => {
    const key = termKey(t);
    const reqKey = bytesToHex(encodeWith(writeStateRequirement, t.requirement));
    const prev = statePolicies.get(key);
    if (prev === undefined) {
      statePolicies.set(key, { domain: t.domain, stateKind: t.stateKind, sources: [...t.admittedSources], requirements: new Map([[reqKey, t.requirement]]) });
      return;
    }
    prev.sources = prev.sources.filter((s) => t.admittedSources.includes(s));
    prev.requirements.set(reqKey, t.requirement);
  };
  for (const g of grants) for (const t of g.terms) if (t.kind === 'STATE_POLICY') addPolicy(t);
  for (const t of policyStatePolicy(policy)) addPolicy(t);

  return ok({
    leaf: leaf.id,
    lineage: lineage.map((n) => n.id),
    holder: leaf.grant.holder,
    validity: { notBefore, expiresAt, empty: notBefore >= expiresAt },
    sets,
    rights,
    delegateDepth: effectiveDepths(lineage)[0] as number,
    bounds: [...bounds.values()],
    timeWindows: [...windows.values()].map((w) => ({ ...w, empty: w.notBefore >= w.expiresAt })),
    invariants,
    principalInvariants: policyInvariants(policy),
    statePolicies: [...statePolicies.values()].map((p) => ({
      domain: p.domain,
      stateKind: p.stateKind,
      admittedSources: p.sources,
      requirements: [...p.requirements.values()],
    })),
  });
}

/** DOM-2: the exact `ModuleRef`, digest included, is in the effective module set. */
export function moduleAllowed(e: EffectiveAuthority, module: ModuleRef): boolean {
  const set = e.sets.find((s) => s.vocabulary === 'MODULES');
  return set !== undefined && set.vocabulary === 'MODULES' && set.members.some((m) => moduleRefsEqual(m, module));
}
