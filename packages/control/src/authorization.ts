/**
 * The authorization a committed decision produces (brief §28, §32, §33;
 * architecture.md §9; reservations-reconciliation.md §4).
 *
 * Two objects:
 *
 * - Core's `ExecutionAuthorization` — the frozen structural statement that
 *   one reservation generation may be executed through its adapter until an
 *   attempt ceiling, under the state bindings the decision relied on. Its
 *   reservation reference names the action, generation, principal, lineage,
 *   policy, exact module and implementation, adapter and the ledger version
 *   the reservation committed at.
 * - The `AuthorizationRecord`, which additionally commits to everything the
 *   decision computed that Core's object does not name: the projection
 *   digest, the invariant results digest, the charge-plan digest, the
 *   evaluation context, the version and head the decision was *read* at, and
 *   which bindings must be rechecked before any artifact is issued. Its
 *   identity is the digest of all of it, so changing any material input — the
 *   action, the module, the lineage, the policy, one state snapshot, one
 *   pending reservation, one invariant, one demand, the ledger version, the
 *   generation — changes the authorization's identity.
 *
 * No signature and no venue artifact exist here; they are 7E and later.
 */

import { ok } from '@mandate/kernel';
import {
  executionAuthorizationId,
  keccakDigest,
  partyIdInputOf,
  moduleRefInputOf,
  adapterRefInputOf,
  reservationIdFor,
  stateBindingId,
  stateBindingInputOf,
  validateExecutionAuthorization,
  writeAdapterRef,
  writeDigest,
  writeModuleRef,
  writeParty,
  type ActionEnvelope,
  type ActionId,
  type AdapterRef,
  type AuthorityId,
  type Digest32,
  type ExecutionAuthorization,
  type ExecutionAuthorizationId,
  type ImplementationDigest,
  type LedgerHeadDigest,
  type LedgerVersion,
  type ModuleRef,
  type PrincipalId,
  type PrincipalPolicyId,
  type ReservationGeneration,
  type ReservationId,
  type StateBinding,
  type StateBindingId,
  type Tagged,
} from '@mandate/core';
import type { LedgerSnapshot } from '@mandate/ledger';
import type { ContextDigest } from './context.ts';
import { ControlTag, controlWriter, writeDigestList } from './encoding.ts';
import { refuse, type ControlResult } from './errors.ts';
import type { InvariantResultsDigest } from './invariants.ts';
import type { ChargePlanDigest, Decision } from './pipeline.ts';
import type { ProjectionDigest } from './projection.ts';

export type AuthorizationId = Tagged<Digest32, 'AuthorizationId'>;

export interface AuthorizationRecord {
  readonly id: AuthorizationId;
  readonly execution: ExecutionAuthorization;
  readonly executionId: ExecutionAuthorizationId;
  readonly action: ActionEnvelope;
  readonly actionId: ActionId;
  readonly principal: PrincipalId;
  readonly module: ModuleRef;
  readonly implementation: ImplementationDigest;
  /** The enforcement adapter the action named; issuance must use exactly it (7E). */
  readonly adapter: AdapterRef;
  /** Leaf to root. */
  readonly lineage: readonly AuthorityId[];
  readonly policy: PrincipalPolicyId;
  readonly reservation: ReservationId;
  readonly generation: ReservationGeneration;
  readonly stateBindings: readonly StateBinding[];
  /** The module each binding's snapshot was admitted under, aligned with `stateBindings`. */
  readonly bindingModules: readonly ModuleRef[];
  readonly projectionDigest: ProjectionDigest;
  readonly invariantResultsDigest: InvariantResultsDigest;
  readonly planDigest: ChargePlanDigest;
  readonly contextDigest: ContextDigest;
  readonly ledgerVersionRead: LedgerVersion;
  readonly ledgerHeadRead: LedgerHeadDigest;
  readonly ledgerVersionCommitted: LedgerVersion;
  readonly ledgerHeadCommitted: LedgerHeadDigest;
  readonly evaluatedAt: bigint;
  /** No artifact under this authorization may be valid at or after this instant (EXEC-3, EXEC-6). */
  readonly validUntil: bigint;
  /** Bindings whose requirement says `RECHECK`: revalidated on fresh state before any artifact. */
  readonly recheck: readonly StateBindingId[];
}

type RecordBody = Omit<AuthorizationRecord, 'id'>;

export function encodeAuthorizationRecord(r: RecordBody): Uint8Array {
  const w = controlWriter(ControlTag.AUTHORIZATION);
  writeDigest(w, r.executionId);
  writeDigest(w, r.actionId);
  writeParty(w, r.principal);
  writeModuleRef(w, r.module);
  writeDigest(w, r.implementation);
  writeAdapterRef(w, r.adapter);
  w.u16(r.lineage.length);
  for (const id of r.lineage) writeDigest(w, id);
  writeDigest(w, r.policy);
  writeDigest(w, r.reservation);
  w.u64(r.generation);
  writeDigestList(w, r.stateBindings.map(stateBindingId));
  for (const m of r.bindingModules) writeModuleRef(w, m);
  writeDigest(w, r.projectionDigest);
  writeDigest(w, r.invariantResultsDigest);
  writeDigest(w, r.planDigest);
  writeDigest(w, r.contextDigest);
  w.u64(r.ledgerVersionRead);
  writeDigest(w, r.ledgerHeadRead);
  w.u64(r.ledgerVersionCommitted);
  writeDigest(w, r.ledgerHeadCommitted);
  w.i64(r.evaluatedAt).i64(r.validUntil);
  writeDigestList(w, r.recheck);
  return w.finish();
}

/**
 * The record for a decision whose `RESERVE` committed as `committed`. Refuses
 * if the commit is not the decision's own: the decision must have been read
 * at exactly the version before (no action authorized on a stale
 * projection).
 */
export function authorizationRecordOf(d: Decision, committed: LedgerSnapshot): ControlResult<AuthorizationRecord> {
  if (committed.version !== d.ledgerVersion + 1n) return refuse('LEDGER_CONFLICT', 'COMMIT_NOT_AT_DECISION_VERSION', 'ledger.version');
  const reservation = reservationIdFor(d.actionId, d.generation);
  const execution = validateExecutionAuthorization({
    reservation: {
      action: d.actionId,
      generation: d.generation,
      principal: partyIdInputOf(d.principal),
      lineage: [...d.lineage],
      policy: d.policy,
      module: moduleRefInputOf(d.module),
      implementation: d.implementation,
      adapter: adapterRefInputOf(d.action.adapter),
      ledgerVersion: committed.version,
    },
    stateBindings: d.bindings.map(stateBindingInputOf),
    attemptCeiling: d.validUntil,
  });
  if (!execution.ok) return refuse('REQUEST_INVALID', execution.error.code, `authorization.${execution.error.path}`, { origin: 'CORE' });
  const bindingModules: ModuleRef[] = [];
  for (const b of execution.value.stateBindings) {
    const a = d.admissions.find((x) => x.binding.stateDigest === b.stateDigest);
    if (a === undefined) return refuse('REQUEST_INVALID', 'BINDING_WITHOUT_ADMISSION', 'authorization.stateBindings');
    bindingModules.push(a.need.module.ref);
  }
  const body: RecordBody = {
    execution: execution.value,
    executionId: executionAuthorizationId(execution.value),
    action: d.action,
    actionId: d.actionId,
    principal: d.principal,
    module: d.module,
    implementation: d.implementation,
    adapter: d.action.adapter,
    lineage: d.lineage,
    policy: d.policy,
    reservation,
    generation: d.generation,
    stateBindings: execution.value.stateBindings,
    bindingModules,
    projectionDigest: d.projectionDigest,
    invariantResultsDigest: d.invariantResultsDigest,
    planDigest: d.planDigest,
    contextDigest: d.context,
    ledgerVersionRead: d.ledgerVersion,
    ledgerHeadRead: d.ledgerHead,
    ledgerVersionCommitted: committed.version,
    ledgerHeadCommitted: committed.head,
    evaluatedAt: d.evaluatedAt,
    validUntil: d.validUntil,
    recheck: execution.value.stateBindings.filter((b) => b.requirement.atIssue === 'RECHECK').map(stateBindingId).sort(),
  };
  return ok({ id: keccakDigest<AuthorizationId>(encodeAuthorizationRecord(body)), ...body });
}
