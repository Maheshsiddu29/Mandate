/**
 * Child ⊆ parent at registration (AUTH-2, first half; authority-model.md §4, §6).
 *
 * Each term kind has its own subset rule, taken from the specification's §4
 * table. None of them is "the encodings are equal": equality is only the rule
 * where Core cannot order two values, and there it is stated as such.
 *
 * | kind               | child valid iff                                                             |
 * | ------------------ | --------------------------------------------------------------------------- |
 * | SET (per vocab.)   | parent has the vocabulary and child members ⊆ parent members (exact refs)    |
 * | RIGHT              | parent has the right; `DELEGATE` depth ≤ parent's effective depth − 1        |
 * | BOUND MAX / MIN    | restated; comparable; child ≤ parent / child ≥ parent (exact, rescaled)      |
 * | validity           | child window ⊆ parent window                                                 |
 * | TIME_WINDOW        | where both constrain a domain, child window ⊆ parent window                  |
 * | LEDGER_DIMENSION   | same id ⇒ same measure, accounting, restoration, epoch, sign and scope; limit ≤ |
 * | STATE_INVARIANT    | restated; parameters no weaker — provable by Core only as byte equality      |
 * | STATE_POLICY       | restated; sources ⊆; freshness, trust, finality, recheck, execution no weaker |
 *
 * Absence means different things per kind, and the rules above encode it:
 * a set or right the child omits is narrower (closed world); a bound,
 * invariant or state policy it omits is refused, because every grant must be
 * self-describing; a ledger dimension it omits is still charged at the
 * parent's leg; a per-domain window it omits is still intersected at action
 * time (the specification lists no restatement rule for it).
 *
 * A child term with no comparable parent term is an added restriction and
 * always permitted. Every violation is reported, not only the first.
 *
 * Where Core cannot decide an ordering — an invariant's opaque parameters, two
 * finality levels on a ladder only its declarer orders, two different
 * execution-time dependencies — a different child value is refused as
 * `DELEGATION_NARROWING_UNPROVEN`. Exact restatement is accepted.
 *
 * Invariant parameters are the one exception, from 7D: when the reducer is
 * configured with an `InvariantOrdering` (rules.ts), a restated invariant with
 * different parameters is accepted if the ordering proves it `NO_WEAKER` —
 * since 7D.2, under exactly the definition the registration committed —
 * refused `DELEGATION_WEAKENS_INVARIANT` if it proves it `WEAKER`, and still
 * refused `DELEGATION_NARROWING_UNPROVEN` otherwise.
 */

import {
  compareRatios,
  termKey,
  type AuthorityGrant,
  type AuthorityTerm,
  type BoundValue,
  type ExecutionDependence,
  type FreshnessPolicy,
  type LedgerDimensionTerm,
  type PerActionBoundTerm,
  type ResourceId,
  type SetConstraintTerm,
  type StateInvariantTerm,
  type StatePolicyTerm,
  type TimeWindowTerm,
} from '@mandate/core';
import { compareScaled } from './encoding.ts';
import type { DelegationViolation, DelegationViolationCode } from './errors.ts';
import type { NarrowingProver } from './rules.ts';

// --- Exact member identity ------------------------------------------------------

function resourceKey(r: ResourceId): string {
  return JSON.stringify([r.domain, r.kind, r.localId]);
}

/** Each member's exact identity: a `ModuleRef` or `AdapterRef` by every field, digest included (DOM-2). */
export function setMemberKeys(t: SetConstraintTerm): readonly string[] {
  switch (t.vocabulary) {
    case 'MODULES':
      return t.members.map((m) => JSON.stringify([m.domainId, m.moduleId, m.moduleVersion, m.moduleDigest]));
    case 'ADAPTERS':
      return t.members.map((a) => JSON.stringify([a.adapterId, a.adapterVersion, a.adapterDigest]));
    case 'ACTION_TYPES':
      return t.members.map((a) => JSON.stringify([a.domain, a.actionType]));
    case 'MARKETS':
    case 'ASSETS':
    case 'VENUES':
    case 'RECIPIENTS':
      return t.members.map((m: ResourceId) => resourceKey(m));
  }
}

// --- Orderings Core understands -------------------------------------------------

/** `c` against `p`: −1, 0, 1, or `null` when the two bound values do not measure the same thing. */
export function compareBoundValues(c: BoundValue, p: BoundValue): -1 | 0 | 1 | null {
  if (c.type === 'QUANTITY' && p.type === 'QUANTITY') {
    if (c.quantity.kind !== p.quantity.kind || c.quantity.unit !== p.quantity.unit) return null;
    return compareScaled(c.quantity.atoms, c.quantity.decimals, p.quantity.atoms, p.quantity.decimals);
  }
  if (c.type === 'RATIO' && p.type === 'RATIO') return compareRatios(c.ratio, p.ratio);
  return null;
}

/** Same dimension identifier in the same measure: everything but the limit (and its decimals) agrees. */
export function dimensionsComparable(c: LedgerDimensionTerm, p: LedgerDimensionTerm): boolean {
  const sameEpoch =
    c.epoch === null || p.epoch === null ? c.epoch === p.epoch : c.epoch.anchor === p.epoch.anchor && c.epoch.lengthSeconds === p.epoch.lengthSeconds;
  const sameResource = (a: ResourceId | null, b: ResourceId | null): boolean => (a === null || b === null ? a === b : resourceKey(a) === resourceKey(b));
  return (
    c.limit.kind === p.limit.kind &&
    c.limit.unit === p.limit.unit &&
    c.accounting === p.accounting &&
    c.restoration === p.restoration &&
    sameEpoch &&
    c.sign === p.sign &&
    sameResource(c.scope.asset, p.scope.asset) &&
    sameResource(c.scope.market, p.scope.market) &&
    c.scope.domain === p.scope.domain &&
    sameResource(c.scope.account, p.scope.account)
  );
}

const TRUST_RANK = { VERIFIED: 1, AUTHORITATIVE: 2 } as const;
const AT_ISSUE_RANK = { WITHIN_POLICY: 1, RECHECK: 2 } as const;

type Verdict = 'OK' | DelegationViolationCode;

function freshnessVerdict(c: FreshnessPolicy, p: FreshnessPolicy): Verdict {
  switch (p.kind) {
    case 'AGE':
      if (c.kind !== 'AGE') return 'DELEGATION_TERM_INCOMPARABLE';
      return c.maxAgeSeconds <= p.maxAgeSeconds ? 'OK' : 'DELEGATION_WEAKENS_STATE_POLICY';
    case 'BLOCKS':
      if (c.kind !== 'BLOCKS') return 'DELEGATION_TERM_INCOMPARABLE';
      return c.maxBlocksBehind <= p.maxBlocksBehind ? 'OK' : 'DELEGATION_WEAKENS_STATE_POLICY';
    case 'SEQUENCE':
      return c.kind === 'SEQUENCE' ? 'OK' : 'DELEGATION_TERM_INCOMPARABLE';
    case 'VERSION':
      // A different pinned version is a different state, not a tighter or looser one.
      if (c.kind !== 'VERSION' || c.pinnedDigest !== p.pinnedDigest) return 'DELEGATION_TERM_INCOMPARABLE';
      return c.maxAgeSeconds <= p.maxAgeSeconds ? 'OK' : 'DELEGATION_WEAKENS_STATE_POLICY';
  }
}

function executionVerdict(c: ExecutionDependence, p: ExecutionDependence): Verdict {
  if (c.kind === p.kind && (c.kind !== 'ENFORCED_BY_ARTIFACT' || (p.kind === 'ENFORCED_BY_ARTIFACT' && c.field === p.field))) return 'OK';
  // Anything is at least as strict as requiring nothing; requiring nothing is weaker than anything.
  if (p.kind === 'NOT_REQUIRED') return 'OK';
  if (c.kind === 'NOT_REQUIRED') return 'DELEGATION_WEAKENS_STATE_POLICY';
  return 'DELEGATION_NARROWING_UNPROVEN';
}

function statePolicyVerdicts(c: StatePolicyTerm, p: StatePolicyTerm): Verdict[] {
  const out: Verdict[] = [];
  if (!c.admittedSources.every((s) => p.admittedSources.includes(s))) out.push('DELEGATION_WEAKENS_STATE_POLICY');
  out.push(freshnessVerdict(c.requirement.freshness, p.requirement.freshness));
  if (TRUST_RANK[c.requirement.minTrust] < TRUST_RANK[p.requirement.minTrust]) out.push('DELEGATION_WEAKENS_STATE_POLICY');
  // Core implies no order between finality levels: only the declarer of a ladder orders it.
  const cf = c.requirement.minFinality;
  const pf = p.requirement.minFinality;
  if (cf.ladder !== pf.ladder || cf.level !== pf.level) out.push('DELEGATION_NARROWING_UNPROVEN');
  if (AT_ISSUE_RANK[c.requirement.atIssue] < AT_ISSUE_RANK[p.requirement.atIssue]) out.push('DELEGATION_WEAKENS_STATE_POLICY');
  out.push(executionVerdict(c.requirement.atExecution, p.requirement.atExecution));
  return out.filter((v) => v !== 'OK');
}

// --- The check ------------------------------------------------------------------

/** A grant's own `DELEGATE` depth; 0 without the right. */
export function delegateDepth(g: AuthorityGrant): number {
  for (const t of g.terms) if (t.kind === 'RIGHT' && t.right === 'DELEGATE') return t.maxDepth;
  return 0;
}


const DELEGATE_KEY = JSON.stringify(['RIGHT', 'DELEGATE']);

/**
 * Every way `child` fails to be ⊆ `parent`. Empty means the delegation is
 * valid by §4's right-hand column. `parentDepth` is the parent's *effective*
 * remaining delegation depth along its own lineage, which equals its grant's
 * depth whenever every ancestor was registered through this check.
 * `prove` orders a restated invariant's parameters: the reducer's configured
 * ordering bound to the registration's committed proofs (rules.ts), if any.
 */
export function checkDelegationSubset(
  parent: AuthorityGrant,
  child: AuthorityGrant,
  parentDepth: number,
  prove: NarrowingProver | null = null,
): readonly DelegationViolation[] {
  const found: DelegationViolation[] = [];
  const seen = new Set<string>();
  const add = (code: DelegationViolationCode, term: string): void => {
    const k = `${code} ${term}`;
    if (seen.has(k)) return;
    seen.add(k);
    found.push({ code, term });
  };

  // Delegation depth: the parent must be able to delegate, and the child may delegate at most one level less.
  if (parentDepth < 1) add('DELEGATION_DEPTH_EXCEEDED', DELEGATE_KEY);
  const childDepth = delegateDepth(child);
  if (childDepth > 0 && childDepth > parentDepth - 1) add('DELEGATION_DEPTH_EXCEEDED', DELEGATE_KEY);

  if (child.notBefore < parent.notBefore || child.expiresAt > parent.expiresAt) add('DELEGATION_WIDENS_WINDOW', 'validity');

  const parentTerms = new Map<string, AuthorityTerm>();
  for (const t of parent.terms) parentTerms.set(termKey(t), t);
  const childKeys = new Set<string>();

  for (const c of child.terms) {
    const key = termKey(c);
    childKeys.add(key);
    const p = parentTerms.get(key);
    switch (c.kind) {
      case 'SET': {
        if (p === undefined) {
          add('DELEGATION_WIDENS_SET', key);
          break;
        }
        const allowed = new Set(setMemberKeys(p as SetConstraintTerm));
        if (!setMemberKeys(c).every((m) => allowed.has(m))) add('DELEGATION_WIDENS_SET', key);
        break;
      }
      case 'RIGHT':
        // DELEGATE is governed by depth, above.
        if (c.right !== 'DELEGATE' && p === undefined) add('DELEGATION_WIDENS_RIGHT', key);
        break;
      case 'BOUND': {
        if (p === undefined) break; // an added bound only tightens
        const pb = p as PerActionBoundTerm;
        const cmp = compareBoundValues(c.value, pb.value);
        if (cmp === null) add('DELEGATION_TERM_INCOMPARABLE', key);
        else if ((c.polarity === 'MAX' && cmp > 0) || (c.polarity === 'MIN' && cmp < 0)) add('DELEGATION_WIDENS_BOUND', key);
        break;
      }
      case 'TIME_WINDOW': {
        if (p === undefined) break;
        const pw = p as TimeWindowTerm;
        if (c.notBefore < pw.notBefore || c.expiresAt > pw.expiresAt) add('DELEGATION_WIDENS_WINDOW', key);
        break;
      }
      case 'LEDGER_DIMENSION': {
        if (p === undefined) break; // a new dimension is an added constraint at the child's own node
        const pd = p as LedgerDimensionTerm;
        if (!dimensionsComparable(c, pd)) add('DELEGATION_TERM_INCOMPARABLE', key);
        else if (compareScaled(c.limit.atoms, c.limit.decimals, pd.limit.atoms, pd.limit.decimals) > 0) add('DELEGATION_WIDENS_LIMIT', key);
        break;
      }
      case 'STATE_INVARIANT': {
        if (p === undefined) break;
        const pi = p as StateInvariantTerm;
        if (pi.params === c.params) break;
        const verdict = prove === null ? 'UNPROVABLE' : prove(pi, c);
        if (verdict === 'WEAKER') add('DELEGATION_WEAKENS_INVARIANT', key);
        else if (verdict === 'UNPROVABLE') add('DELEGATION_NARROWING_UNPROVEN', key);
        break;
      }
      case 'STATE_POLICY': {
        if (p === undefined) break;
        for (const v of statePolicyVerdicts(c, p as StatePolicyTerm)) if (v !== 'OK') add(v, key);
        break;
      }
    }
  }

  // Restatement (authority-model.md §4): a dropped bound, invariant or state policy is refused.
  for (const [key, p] of parentTerms) {
    if (childKeys.has(key)) continue;
    if (p.kind === 'BOUND') add('DELEGATION_DROPS_BOUND', key);
    if (p.kind === 'STATE_INVARIANT') add('DELEGATION_DROPS_INVARIANT', key);
    if (p.kind === 'STATE_POLICY') add('DELEGATION_DROPS_STATE_POLICY', key);
  }
  return found;
}
