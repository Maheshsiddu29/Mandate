/**
 * Ledger refusals.
 *
 * **Provisional**, like Core's codes (open question 9). The names follow the
 * frozen specification wherever it names one (`LEDGER_LIMIT_EXCEEDED`,
 * `AUTHORITY_REVOKED`, `DELEGATION_WIDENS_SET`, ...). Codes the specification
 * does not name are marked below as 7C additions.
 *
 * A refusal is a value, never an exception: every ledger operation is total
 * over its inputs and returns either the new state or the reason nothing
 * changed. Four shapes carry the detail each needs:
 *
 * - `MALFORMED` wraps the structural `CoreError` of an input that is not a
 *   well-formed Core object;
 * - `LEDGER_LIMIT_EXCEEDED` names *every* failing `(node, dimension)` with the
 *   requested, available and granted amounts (authority-ledger.md §8);
 * - `DELEGATION_REFUSED` lists *every* subset violation, not only the first
 *   (authority-model.md §6);
 * - every other code names the path of the offending field and, where one
 *   exists, the authority node it concerns (authority-model.md §5: "the reason
 *   identifies the node that failed").
 *
 * Reason codes never name a dimension (decision 21); dimensions travel as
 * structured detail.
 */

import { err, type Result } from '@mandate/kernel';
import type { AuthorityId, CoreError, DimensionId, PrincipalPolicyId, QuantityKind, UnitCode } from '@mandate/core';

export const LEDGER_REFUSAL_CODES_ARE_PROVISIONAL = true;

export const LEDGER_REFUSAL_CODES = [
  'MALFORMED',
  // Principal and principal policy
  'PRINCIPAL_MISMATCH', // 7C: an object or event for another principal's ledger
  'PRINCIPAL_POLICY_MISSING',
  'POLICY_SEQUENCE_NOT_INCREASING', // 7C: authority-model.md §8.1 "strictly greater"
  'POLICY_UPDATE_REQUIRES_BASELINE', // 7C: AUTH-GLOBAL-2 initialization is not implemented
  // Authority graph
  'AUTHORITY_ALREADY_REGISTERED', // 7C
  'AUTHORITY_UNKNOWN',
  'AUTHORITY_PRINCIPAL_MISMATCH',
  'AUTHORITY_ISSUER_MISMATCH',
  'AUTHORITY_NOT_YET_VALID',
  'AUTHORITY_EXPIRED',
  'AUTHORITY_REVOKED',
  'AUTHORITY_DEPTH_EXCEEDED',
  'LINEAGE_TERMS_INCOMPARABLE', // 7C: the action-time meet cannot be formed
  'DELEGATION_REFUSED',
  'SEMANTIC_PROOF_INVALID', // 7D.2: a committed proof is out of order, duplicated, or names an owner that cannot define its invariant
  'SEMANTIC_PROOF_UNEXPECTED', // 7D.2: a committed proof for a term that needs none
  'REVOCATION_ISSUER_NOT_ELIGIBLE', // 7C: authority-model.md §7 scope rule
  'REVOCATION_NOT_EFFECTIVE', // 7C: effectiveAt after the registration time
  // Reservation
  'ACTOR_NOT_HOLDER',
  'MODULE_NOT_PERMITTED', // 7C: the ModuleRef is outside the effective MODULES set
  'MODULE_UNREGISTERED', // 7C
  'MODULE_DIGEST_MISMATCH',
  'MODULE_IMPLEMENTATION_UNREGISTERED',
  'MODULE_RETIRING', // 7C: action-state-model.md §8.1 "RETIRING — no new decisions"
  'RESERVATION_EXISTS', // 7C
  'GENERATION_OUT_OF_SEQUENCE', // 7C
  'PREVIOUS_GENERATION_OPEN', // 7C
  'CONTRIBUTION_INVALID', // 7C
  'UNBOUNDED_CONTRIBUTION',
  'INEXACT_RESCALE', // 7C: no rounding exists yet (UNIT-4 pending)
  'NET_DIMENSION_UNSUPPORTED', // 7C: NET sign mode is not implemented
  'EPOCH_NOT_STARTED', // 7C
  'LEDGER_LIMIT_EXCEEDED',
  'AMOUNT_OVERFLOW', // 7C
  'CHARGE_PATH_MISMATCH', // 7C: an event's lineage, policy or legs differ from the derived ones
  // Accounting
  'RESERVATION_UNKNOWN', // 7C
  'RESERVATION_ID_MISMATCH',
  'RESERVATION_CLOSED', // 7C
  'ACCOUNTING_SHAPE_INVALID', // 7C
  'CONSUME_EXCEEDS_RESERVED', // 7C: the excess would be OVERRUN, which is 7D
  'RELEASE_MISMATCH', // 7C
  'RESTORE_EXCEEDS_CONSUMED', // 7C: LEDGER-RESTORE-1
  'RESTORE_NOT_PERMITTED', // 7C: BUDGET dimensions never restore
  // Log and time
  'EVALUATION_TIME_REGRESSED', // 7C
  'BATCH_EMPTY', // 7C
  'BATCH_TOO_LARGE', // 7C
  'LEDGER_CHAIN_BROKEN', // 7C: a replayed batch does not extend the previous head
  // Registry
  'REGISTRY_DUPLICATE_MODULE', // 7C
  // Engine
  'RETRY_POLICY_INVALID', // 7C
] as const;

export type LedgerRefusalCode = (typeof LEDGER_REFUSAL_CODES)[number];

/** authority-model.md §6, plus one 7C code for a narrowing Core cannot prove. */
export const DELEGATION_VIOLATION_CODES = [
  'DELEGATION_WIDENS_SET',
  'DELEGATION_WIDENS_RIGHT',
  'DELEGATION_WIDENS_BOUND',
  'DELEGATION_WIDENS_WINDOW',
  'DELEGATION_WIDENS_LIMIT',
  'DELEGATION_DROPS_BOUND',
  'DELEGATION_DROPS_INVARIANT',
  'DELEGATION_DROPS_STATE_POLICY',
  /** 7D: the invariant definition's `noWeaker` proves the child's parameters weaker. */
  'DELEGATION_WEAKENS_INVARIANT',
  'DELEGATION_WEAKENS_STATE_POLICY',
  'DELEGATION_DEPTH_EXCEEDED',
  'DELEGATION_TERM_INCOMPARABLE',
  /**
   * 7C: the child restates a term with different content whose ordering Core
   * cannot decide — an invariant's opaque parameters, a finality level on a
   * ladder Core does not order. Neither "weaker" nor "no weaker" is
   * provable, so the delegation is refused (fail closed). From 7D, the
   * invariant definition's `noWeaker`, configured as the reducer's
   * `InvariantOrdering` (rules.ts), decides invariant parameters; without
   * one, or when it cannot order them, this code stands.
   */
  'DELEGATION_NARROWING_UNPROVEN',
] as const;

export type DelegationViolationCode = (typeof DELEGATION_VIOLATION_CODES)[number];

export interface DelegationViolation {
  readonly code: DelegationViolationCode;
  /** The term's uniqueness key (Core `termKey`), or `validity` for the grant's own window. */
  readonly term: string;
}

/** A charge target: a node's dimension, or a principal-global dimension of the policy in force. */
export type TargetRef =
  | { readonly kind: 'NODE'; readonly authority: AuthorityId; readonly dimensionId: DimensionId }
  | { readonly kind: 'POLICY'; readonly policy: PrincipalPolicyId; readonly dimensionId: DimensionId };

export interface LimitFailure {
  readonly target: TargetRef;
  readonly kind: QuantityKind;
  readonly unit: UnitCode;
  /** The dimension's decimals: `requested`, `available` and `limit` are atoms at this scale. */
  readonly decimals: number;
  readonly requested: bigint;
  /** May be negative when a tightened policy limit is already below occupancy. */
  readonly available: bigint;
  readonly limit: bigint;
}

export type GenericRefusalCode = Exclude<LedgerRefusalCode, 'MALFORMED' | 'LEDGER_LIMIT_EXCEEDED' | 'DELEGATION_REFUSED'>;

export type LedgerRefusal =
  | { readonly code: 'MALFORMED'; readonly path: string; readonly core: CoreError }
  | { readonly code: 'LEDGER_LIMIT_EXCEEDED'; readonly path: string; readonly failures: readonly LimitFailure[] }
  | { readonly code: 'DELEGATION_REFUSED'; readonly path: string; readonly violations: readonly DelegationViolation[] }
  | { readonly code: GenericRefusalCode; readonly path: string; readonly node: AuthorityId | null };

export type LedgerResult<T> = Result<T, LedgerRefusal>;

export function refuse(code: GenericRefusalCode, path: string, node: AuthorityId | null = null): LedgerResult<never> {
  return err({ code, path, node });
}

export function malformed(core: CoreError, path: string): LedgerResult<never> {
  return err({ code: 'MALFORMED', path, core });
}

/** Re-address a refusal produced for one event at its position in a batch. */
export function withPath(r: LedgerRefusal, prefix: string): LedgerRefusal {
  const path = r.path === '' ? prefix : `${prefix}.${r.path}`;
  return { ...r, path };
}
