/**
 * The control engine's failure taxonomy.
 *
 * **Provisional**, like Core's and the ledger's codes (open question 9). A
 * refusal is a value, never an exception: every operation is total over its
 * inputs and returns either its result or why nothing was authorized.
 *
 * A refusal has two levels, because the operational response depends on the
 * first and the diagnosis on the second:
 *
 * - `code` — the taxonomy below: what kind of thing failed.
 * - `reason` — the specific rule, as an identifier. Where the rule is the
 *   control engine's or the ledger's, it is that component's own name
 *   (`AGE_EXCEEDED`, `LEDGER_LIMIT_EXCEEDED`). Where a domain module refused,
 *   `origin` is `MODULE` and `module` names the exact `ModuleRef` whose
 *   namespace the reason belongs to: two modules' `MARKET_UNKNOWN` are never
 *   the same reason.
 *
 * `detail` carries the structure a caller needs to act — the ledger refusal
 * with every failing leg, every invariant result, every delegation
 * violation — rather than a message to parse.
 */

import { err, type Result } from '@mandate/kernel';
import type { CoreError, ModuleRef } from '@mandate/core';
import type { DelegationViolation, LedgerRefusal } from '@mandate/ledger';
import type { InvariantResult } from './invariants.ts';
import type { NarrowingProof } from './narrowing.ts';

export const CONTROL_CODES_ARE_PROVISIONAL = true;

export const CONTROL_CODES = [
  // Inputs
  'REQUEST_INVALID', // a request object that is not well formed
  'CONTEXT_INVALID', // the evaluation context is malformed or ambiguous
  'RESOURCE_BOUND_EXCEEDED', // an attacker-controlled cardinality is above its bound (limits.ts)
  // Modules
  'MODULE_NOT_FOUND', // no conforming implementation for this exact ModuleRef
  'MODULE_NOT_CONFORMING', // the module is registered but its implementation or its output is not conforming
  // Action and authority
  'ACTION_INVALID',
  'ACTION_NOT_COVERED', // the effective authority does not cover the action (sets, rights, bounds, windows)
  'AUTHORITY_INVALID', // lineage, actor or principal
  'AUTHORITY_UNAVAILABLE', // the ledger's charging path cannot hold the demand
  'DELEGATION_REFUSED',
  'SEMANTIC_NARROWING_UNPROVABLE',
  'SEMANTIC_BINDING_REFUSED', // 7D.3: a term's exact semantic definition cannot be bound, or a binding disagrees with a committed one
  // State
  'STATE_MISSING',
  'STATE_STALE',
  'STATE_UNTRUSTED',
  'STATE_CONFLICT',
  'STATE_FINALITY_INSUFFICIENT',
  'STATE_INVALID',
  'STATE_POLICY_CONFLICT', // module, lineage and policy requirements for one state kind cannot be combined
  // Projection, invariants and demand
  'INVARIANT_FAILED', // at least one applicable invariant is VIOLATED
  'INVARIANT_UNKNOWN', // none is VIOLATED, but at least one could not be evaluated (FAIL-1)
  'DEMAND_INVALID',
  // Commit and lifecycle
  'LEDGER_CONFLICT', // the store refused at commit a batch the decision had validated: its rules disagree
  'RETRY_EXHAUSTED', // every attempt lost a compare-and-swap race; nothing was decided against, nothing written
  'AUTHORIZATION_EXPIRED',
  'RESERVATION_NOT_ACTIVE',
  'REVALIDATION_FAILED',
  'REVALIDATION_PASSED', // NEVER_ISSUED closure needs a failed revalidation; this one passed
  'EXECUTION_EVIDENCE_EXISTS', // NEVER_ISSUED closure refused: the reservation has consumption
  // Issuance (7E.1)
  'NEVER_ISSUED_FORBIDDEN', // an issuance attempt was admitted for this generation: an artifact may exist
  'ADAPTER_NOT_USABLE', // the adapter is unregistered, another digest, retiring (for new authority) or disabled
  'PRE_EXECUTION_FAILED', // a required pre-execution requirement is FAIL or UNKNOWN
  'ATTEMPT_REFUSED', // the ledger refused the attempt admission (a live attempt, a reused artifact or slot, …)
] as const;

export type ControlCode = (typeof CONTROL_CODES)[number];

export type RefusalOrigin = 'CONTROL' | 'CORE' | 'LEDGER' | 'MODULE';

export type RefusalDetail =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'CORE'; readonly error: CoreError }
  | { readonly kind: 'LEDGER'; readonly refusal: LedgerRefusal }
  | { readonly kind: 'INVARIANTS'; readonly results: readonly InvariantResult[] }
  | { readonly kind: 'DELEGATION'; readonly violations: readonly DelegationViolation[]; readonly proofs: readonly NarrowingProof[] }
  | { readonly kind: 'STATE'; readonly failures: readonly StateFailure[] };

/** One requirement that admission could not satisfy. */
export interface StateFailure {
  readonly code: ControlCode;
  readonly reason: string;
  /** `module / stateKind / subject` of the requirement. */
  readonly requirement: string;
}

export interface ControlRefusal {
  readonly code: ControlCode;
  readonly reason: string;
  readonly origin: RefusalOrigin;
  readonly path: string;
  /** The module whose namespace `reason` is in (origin `MODULE`), or the module the failure concerns. */
  readonly module: ModuleRef | null;
  readonly detail: RefusalDetail;
}

export type ControlResult<T> = Result<T, ControlRefusal>;

const NONE: RefusalDetail = Object.freeze({ kind: 'NONE' });

export function refusal(code: ControlCode, reason: string, path: string, o: { origin?: RefusalOrigin; module?: ModuleRef | null; detail?: RefusalDetail } = {}): ControlRefusal {
  return { code, reason, origin: o.origin ?? 'CONTROL', path, module: o.module ?? null, detail: o.detail ?? NONE };
}

export function refuse(code: ControlCode, reason: string, path: string, o: { origin?: RefusalOrigin; module?: ModuleRef | null; detail?: RefusalDetail } = {}): ControlResult<never> {
  return err(refusal(code, reason, path, o));
}

export function fromCore(code: ControlCode, e: CoreError, path: string, module: ModuleRef | null = null): ControlResult<never> {
  return err(refusal(code, e.code, path === '' ? e.path : `${path}.${e.path}`, { origin: 'CORE', module, detail: { kind: 'CORE', error: e } }));
}

/**
 * A ledger refusal in the taxonomy. The ledger's code is kept as the reason
 * and the whole refusal as detail; only the family is decided here.
 */
export function fromLedger(r: LedgerRefusal, path: string): ControlRefusal {
  let code: ControlCode;
  switch (r.code) {
    case 'LEDGER_LIMIT_EXCEEDED':
    case 'UNBOUNDED_CONTRIBUTION':
    case 'AMOUNT_OVERFLOW':
    case 'EPOCH_NOT_STARTED':
    case 'NET_DIMENSION_UNSUPPORTED':
    case 'INEXACT_RESCALE':
      code = 'AUTHORITY_UNAVAILABLE';
      break;
    case 'MODULE_UNREGISTERED':
      code = 'MODULE_NOT_FOUND';
      break;
    case 'MODULE_DIGEST_MISMATCH':
    case 'MODULE_IMPLEMENTATION_UNREGISTERED':
    case 'MODULE_RETIRING':
    case 'MODULE_DISABLED':
      code = 'MODULE_NOT_CONFORMING';
      break;
    case 'ADAPTER_UNREGISTERED':
    case 'ADAPTER_DIGEST_MISMATCH':
    case 'ADAPTER_RETIRING':
    case 'ADAPTER_DISABLED':
      code = 'ADAPTER_NOT_USABLE';
      break;
    case 'ATTEMPT_SHAPE_INVALID':
    case 'ATTEMPT_BINDING_MISMATCH':
    case 'ATTEMPT_ID_MISMATCH':
    case 'ATTEMPT_UNRESOLVED':
    case 'ARTIFACT_REUSED':
    case 'VENUE_SLOT_REUSED':
    case 'ATTEMPT_EXPIRED':
      code = 'ATTEMPT_REFUSED';
      break;
    case 'MODULE_NOT_PERMITTED':
      code = 'ACTION_NOT_COVERED';
      break;
    case 'CONTRIBUTION_INVALID':
    case 'MALFORMED':
      code = 'DEMAND_INVALID';
      break;
    case 'SEMANTIC_PROOF_INVALID':
    case 'SEMANTIC_PROOF_UNEXPECTED':
      code = 'SEMANTIC_NARROWING_UNPROVABLE';
      break;
    case 'SEMANTIC_BINDING_INVALID':
    case 'SEMANTIC_BINDING_UNEXPECTED':
    case 'SEMANTIC_BINDING_MISSING':
    case 'SEMANTIC_BINDING_MISMATCH':
    case 'HISTORICAL_SEMANTICS_UNBOUND':
      code = 'SEMANTIC_BINDING_REFUSED';
      break;
    case 'DELEGATION_REFUSED':
      code = r.violations.every((v) => v.code === 'DELEGATION_NARROWING_UNPROVEN') ? 'SEMANTIC_NARROWING_UNPROVABLE' : 'DELEGATION_REFUSED';
      break;
    case 'EVALUATION_TIME_REGRESSED':
      code = 'CONTEXT_INVALID';
      break;
    case 'RESERVATION_EXISTS':
    case 'PREVIOUS_GENERATION_OPEN':
    case 'GENERATION_OUT_OF_SEQUENCE':
      code = 'REQUEST_INVALID';
      break;
    default:
      code = 'AUTHORITY_INVALID';
  }
  return refusal(code, r.code, path === '' ? r.path : `${path}.${r.path}`, { origin: 'LEDGER', detail: { kind: 'LEDGER', refusal: r } });
}

/** A failure a domain module reported, in the module's namespace. */
export interface ModuleFailure {
  /** An identifier in the module's own vocabulary. */
  readonly reason: string;
  readonly path: string;
}

export type ModuleResult<T> = Result<T, ModuleFailure>;

export function moduleFail(reason: string, path = ''): ModuleResult<never> {
  return err({ reason, path });
}
