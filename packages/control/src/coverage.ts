/**
 * Coverage: does the effective authority cover this action at all
 * (authority-model.md §3–4; implementation-7c.md §3 — "the other coverage
 * checks need the action's own parameters and are 7D's")?
 *
 * Over the meet 7C computes — never over the leaf's own terms alone:
 *
 * | Term            | Check                                                                    |
 * | --------------- | ------------------------------------------------------------------------ |
 * | `SET MODULES`   | the exact `ModuleRef`, digest included (DOM-2)                            |
 * | `SET ADAPTERS`  | the exact `AdapterRef`                                                    |
 * | `SET ACTION_TYPES` | `(module domain, actionType)`                                          |
 * | `SET MARKETS`, `ASSETS`, `VENUES`, `RECIPIENTS` | every target and resource of that kind    |
 * | `RIGHT`         | every right the module says the action exercises                          |
 * | `BOUND`         | every effective bound, against the module's value for it                 |
 * | `TIME_WINDOW`   | the module's domain's window contains `t`                                 |
 *
 * Closed world: a vocabulary the effective authority lacks grants nothing,
 * so an action touching a market under an authority with no `MARKETS` set is
 * not covered. A bound the module reports no value for cannot be checked,
 * and refuses rather than passing (FAIL-1). `ACCOUNT` resources are the
 * principal's own enforcement accounts; they are scoped by state and
 * demands, not by a set.
 */

import { ok } from '@mandate/kernel';
import { adapterRefsEqual, resourceIdsEqual, type ActionEnvelope, type ResourceId, type SetConstraintTerm, type SetVocabulary } from '@mandate/core';
import { compareBoundValues, moduleAllowed, type EffectiveAuthority } from '@mandate/ledger';
import { refuse, type ControlResult } from './errors.ts';
import type { ActionAnalysis } from './module.ts';

function vocabulary(e: EffectiveAuthority, v: SetVocabulary): SetConstraintTerm | null {
  return e.sets.find((s) => s.vocabulary === v) ?? null;
}

const RESOURCE_VOCABULARY: { readonly [K in ResourceId['kind']]: SetVocabulary | null } = {
  MARKET: 'MARKETS',
  CANONICAL_ASSET: 'ASSETS',
  REPRESENTATION_ASSET: 'ASSETS',
  VENUE: 'VENUES',
  RECIPIENT: 'RECIPIENTS',
  ACCOUNT: null,
  PROPOSAL: null,
};

function containsResource(set: SetConstraintTerm, r: ResourceId): boolean {
  switch (set.vocabulary) {
    case 'MARKETS':
    case 'ASSETS':
    case 'VENUES':
    case 'RECIPIENTS':
      return set.members.some((m: ResourceId) => resourceIdsEqual(m, r));
    default:
      return false;
  }
}

function notCovered(reason: string, path: string): ControlResult<never> {
  return refuse('ACTION_NOT_COVERED', reason, path);
}

export function checkCoverage(e: EffectiveAuthority, action: ActionEnvelope, analysis: ActionAnalysis, at: bigint): ControlResult<true> {
  if (!moduleAllowed(e, action.module)) return notCovered('MODULE_NOT_PERMITTED', 'action.module');

  const adapters = vocabulary(e, 'ADAPTERS');
  if (adapters === null || adapters.vocabulary !== 'ADAPTERS' || !adapters.members.some((a) => adapterRefsEqual(a, action.adapter))) {
    return notCovered('ADAPTER_NOT_PERMITTED', 'action.adapter');
  }
  const types = vocabulary(e, 'ACTION_TYPES');
  if (types === null || types.vocabulary !== 'ACTION_TYPES' || !types.members.some((t) => t.domain === action.module.domainId && t.actionType === action.actionType)) {
    return notCovered('ACTION_TYPE_NOT_PERMITTED', 'action.actionType');
  }
  const touched: ResourceId[] = [action.target, ...action.resources];
  for (let i = 0; i < touched.length; i += 1) {
    const r = touched[i] as ResourceId;
    const v = RESOURCE_VOCABULARY[r.kind];
    if (v === null) continue;
    const set = vocabulary(e, v);
    if (set === null || !containsResource(set, r)) return notCovered(`${v}_NOT_PERMITTED`, i === 0 ? 'action.target' : `action.resources[${i - 1}]`);
  }

  for (const right of analysis.requiredRights) {
    if (!e.rights.includes(right)) return notCovered('RIGHT_NOT_GRANTED', `rights.${right}`);
  }

  for (const b of e.bounds) {
    const observed = analysis.bounds.find((x) => x.boundId === b.boundId);
    if (observed === undefined) return notCovered('BOUND_NOT_EVALUATED', `bounds.${b.boundId}`);
    const cmp = compareBoundValues(observed.value, b.value);
    if (cmp === null) return notCovered('BOUND_INCOMPARABLE', `bounds.${b.boundId}`);
    if ((b.polarity === 'MAX' && cmp > 0) || (b.polarity === 'MIN' && cmp < 0)) return notCovered('BOUND_EXCEEDED', `bounds.${b.boundId}`);
  }

  const window = e.timeWindows.find((w) => w.domain === action.module.domainId);
  if (window !== undefined && (window.empty || at < window.notBefore || at >= window.expiresAt)) return notCovered('OUTSIDE_TIME_WINDOW', `timeWindows.${window.domain}`);
  return ok(true);
}
