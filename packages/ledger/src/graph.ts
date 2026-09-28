/**
 * The authority graph: a forest of registered grants per principal
 * (authority-model.md §5, §6, §7, §9).
 *
 * The graph is not a separate structure. It is the `nodes` of the ledger
 * state, written only by `REGISTER_GRANT` and `REVOKE` events, so which nodes
 * exist and which are revoked is read at exactly the ledger version a
 * reservation is decided at. A node is never mutated or deleted: revocation
 * records the version and revocation id on the node, and a descendant is
 * revoked because its lineage contains a revoked node.
 *
 * Cycles cannot exist. An `AuthorityId` is the digest of a grant that names
 * its parent's `AuthorityId`, and a parent must be registered strictly before
 * its child, so the registration order is a topological order; lineage
 * resolution is additionally bounded by `MAX_LINEAGE_LENGTH`.
 */

import { ok } from '@mandate/kernel';
import { MAX_LINEAGE_LENGTH, partyIdsEqual, type AuthorityGrant, type AuthorityId, type PartyId } from '@mandate/core';
import { refuse, type LedgerResult } from './errors.ts';
import type { LedgerState, NodeRecord } from './state.ts';
import { checkDelegationSubset, delegateDepth } from './subset.ts';
import type { Revocation } from './revocation.ts';
import type { NarrowingProver } from './rules.ts';

/** Leaf to root. Refuses an unknown node anywhere on the path. */
export function resolveLineage(state: LedgerState, leaf: AuthorityId, path = 'authority'): LedgerResult<readonly NodeRecord[]> {
  const out: NodeRecord[] = [];
  let id: AuthorityId | null = leaf;
  while (id !== null) {
    if (out.length === MAX_LINEAGE_LENGTH) return refuse('AUTHORITY_DEPTH_EXCEEDED', path, leaf);
    const node = state.nodes.get(id);
    if (node === undefined) return refuse('AUTHORITY_UNKNOWN', path, id);
    out.push(node);
    id = node.grant.lineage.kind === 'DELEGATION' ? node.grant.lineage.parent : null;
  }
  return ok(out);
}

/**
 * Effective remaining delegation depth of each node, leaf to root:
 * `eff(root) = depth(root)`, `eff(child) = min(eff(parent) − 1, depth(child))`
 * (authority-model.md §4, the depth meet).
 */
export function effectiveDepths(lineage: readonly NodeRecord[]): readonly number[] {
  const out: number[] = new Array<number>(lineage.length);
  let parent: number | null = null;
  for (let i = lineage.length - 1; i >= 0; i -= 1) {
    const own = delegateDepth((lineage[i] as NodeRecord).grant);
    const inherited = parent === null ? own : parent - 1;
    // Clamped at 0: below a node that may not delegate, nothing may delegate (and lineage validity refuses it).
    const eff: number = inherited < 0 ? 0 : own < inherited ? own : inherited;
    out[i] = eff;
    parent = eff;
  }
  return out;
}

/**
 * Lineage validity at decision time `at` (authority-model.md §5), checked
 * root first so the node reported is the highest one that fails:
 * principal restated at every level, issuer = parent's holder, not revoked
 * (self or ancestor), `notBefore ≤ at < expiresAt`, and every delegation step
 * permitted by its parent's effective depth. Signature verification (rule 2)
 * is not implemented in 7C.
 */
export function checkLineageValid(state: LedgerState, lineage: readonly NodeRecord[], at: bigint, path = 'authority'): LedgerResult<true> {
  if (state.policy === null) return refuse('PRINCIPAL_POLICY_MISSING', path);
  const depths = effectiveDepths(lineage);
  for (let i = lineage.length - 1; i >= 0; i -= 1) {
    const node = lineage[i] as NodeRecord;
    const g = node.grant;
    if (!partyIdsEqual(g.principal, state.principal)) return refuse('AUTHORITY_PRINCIPAL_MISMATCH', path, node.id);
    if (i < lineage.length - 1) {
      const parent = lineage[i + 1] as NodeRecord;
      if (g.lineage.kind !== 'DELEGATION' || g.lineage.parent !== parent.id || !partyIdsEqual(g.lineage.issuer, parent.grant.holder)) {
        return refuse('AUTHORITY_ISSUER_MISMATCH', path, node.id);
      }
      if ((depths[i + 1] as number) < 1) return refuse('AUTHORITY_DEPTH_EXCEEDED', path, node.id);
    } else if (g.lineage.kind !== 'ROOT' || !partyIdsEqual(g.lineage.issuer, state.principal)) {
      return refuse('AUTHORITY_ISSUER_MISMATCH', path, node.id);
    }
    if (node.revokedAt !== null) return refuse('AUTHORITY_REVOKED', path, node.id);
    if (at < g.notBefore) return refuse('AUTHORITY_NOT_YET_VALID', path, node.id);
    if (at >= g.expiresAt) return refuse('AUTHORITY_EXPIRED', path, node.id);
  }
  return ok(true);
}

/**
 * `RegisterGrant(g)` at time `at` (authority-model.md §6). A root needs a
 * registered principal policy (§8.2); a delegation needs a registered parent
 * whose lineage is valid at `at`, the parent's holder as issuer, and every
 * subset rule. Nothing is registered first and validated later. Returns the
 * new node's depth. `prove` orders restated invariants under the
 * registration's committed proofs (rules.ts `committedProver`).
 */
export function checkGrantRegistration(
  state: LedgerState,
  id: AuthorityId,
  grant: AuthorityGrant,
  at: bigint,
  path = 'grant',
  prove: NarrowingProver | null = null,
): LedgerResult<number> {
  if (!partyIdsEqual(grant.principal, state.principal)) return refuse('PRINCIPAL_MISMATCH', `${path}.principal`, id);
  if (state.policy === null) return refuse('PRINCIPAL_POLICY_MISSING', path, id);
  if (state.nodes.has(id)) return refuse('AUTHORITY_ALREADY_REGISTERED', path, id);
  // A grant already expired can never be used, and registering it would only hide a mistake.
  if (at >= grant.expiresAt) return refuse('AUTHORITY_EXPIRED', `${path}.expiresAt`, id);
  if (grant.lineage.kind === 'ROOT') return ok(0);

  const parentId = grant.lineage.parent;
  const lineage = resolveLineage(state, parentId, `${path}.lineage.parent`);
  if (!lineage.ok) return lineage;
  const valid = checkLineageValid(state, lineage.value, at, `${path}.lineage.parent`);
  if (!valid.ok) return valid;
  const parent = lineage.value[0] as NodeRecord;
  if (!partyIdsEqual(grant.principal, parent.grant.principal)) return refuse('AUTHORITY_PRINCIPAL_MISMATCH', `${path}.principal`, id);
  if (!partyIdsEqual(grant.lineage.issuer, parent.grant.holder)) return refuse('AUTHORITY_ISSUER_MISMATCH', `${path}.lineage.issuer`, id);
  const violations = checkDelegationSubset(parent.grant, grant, effectiveDepths(lineage.value)[0] as number, prove);
  if (violations.length > 0) return { ok: false, error: { code: 'DELEGATION_REFUSED', path, violations } };
  // Unreachable through the depth meet (Core caps DELEGATE at 7); kept as an absolute bound.
  if (lineage.value.length >= MAX_LINEAGE_LENGTH) return refuse('AUTHORITY_DEPTH_EXCEEDED', path, id);
  return ok(parent.depth + 1);
}

/**
 * A revocation at time `at` (authority-model.md §7): the target is
 * registered and not already revoked (itself or through an ancestor); the
 * issuer is the issuer of the target or of any ancestor — so the principal
 * may revoke anything, and a holder may revoke its descendants but never its
 * own node or an ancestor; and it is effective now, not scheduled.
 */
export function checkRevocation(state: LedgerState, revocation: Revocation, at: bigint, path = 'revocation'): LedgerResult<true> {
  const lineage = resolveLineage(state, revocation.target, `${path}.target`);
  if (!lineage.ok) return lineage;
  if (revocation.effectiveAt > at) return refuse('REVOCATION_NOT_EFFECTIVE', `${path}.effectiveAt`, revocation.target);
  for (const node of lineage.value) {
    if (node.revokedAt !== null) return refuse('AUTHORITY_REVOKED', `${path}.target`, node.id);
  }
  const issuers: PartyId[] = lineage.value.map((n) => n.grant.lineage.issuer);
  if (!issuers.some((p) => partyIdsEqual(p, revocation.issuer))) {
    return refuse('REVOCATION_ISSUER_NOT_ELIGIBLE', `${path}.issuer`, revocation.target);
  }
  return ok(true);
}
