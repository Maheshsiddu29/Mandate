/**
 * Issue-time revalidation (reservations-reconciliation.md §10a; STATE-5;
 * CORE-CONC-1; examples.md §F; brief §34–§35).
 *
 * The decision's state was admitted at `t`; an artifact would be created
 * later, and the world may have moved in between without the ledger's CAS
 * seeing it. Before anything is issued, the exact authorization is
 * revalidated — never edited:
 *
 * 1. **Reservation.** Still `ACTIVE`, at exactly the authorization's
 *    generation (RECON-2), and the authorization's own lifetime has not ended.
 * 2. **Lineage.** Still valid at `t_i` at the current version: not revoked,
 *    not expired.
 * 3. **Re-admission.** If every binding says `WITHIN_POLICY`, each is
 *    re-admitted from the binding alone at `t_i`. If all still pass, the
 *    authorization stands on the state it was decided on.
 * 4. **Revalidation.** Otherwise — a `RECHECK` binding, or one that no longer
 *    re-admits — fresh state is admitted and projection and every lineage
 *    and principal-global invariant are re-run over `S_fresh ⊕ Pending(L@v')`.
 *    `Pending` already contains this reservation's own worst case, which is
 *    not added again; coverage and availability are not re-run, because the
 *    reservation already holds its authority.
 *
 * The result is a value: `PASSED` (with the bindings to issue under, which
 * are the original ones or fresh ones) or `FAILED` (with the refusal). It
 * changes nothing. In 7D there is no issuance, so committing `REVALIDATE` and
 * `ADMIT_ATTEMPT` is 7E's; what 7D does commit is the one safe consequence of
 * a failure — `NEVER_ISSUED` closure (engine.ts). A revalidation that finds
 * the projection materially changed does not mutate the authorization: it
 * either still holds on fresh state, or the reservation must be closed and a
 * new decision made.
 */

import { ok } from '@mandate/kernel';
import {
  actionPayloadDigest,
  keccakDigest,
  moduleRefsEqual,
  stateBindingId,
  writeDigest,
  writeStateBinding,
  type Digest32,
  type LedgerVersion,
  type ModuleRef,
  type StateBinding,
  type Tagged,
} from '@mandate/core';
import type { LedgerSnapshot, ReservationRecord } from '@mandate/ledger';
import { prepareStates, readmitBinding, type SuppliedState } from './admission.ts';
import type { AuthorizationRecord } from './authorization.ts';
import { validateEvaluationContext, type EvaluationContextInput } from './context.ts';
import { ControlTag, controlWriter, sortCanonical, writeDigestList } from './encoding.ts';
import { refuse, refusal, type ControlRefusal, type ControlResult } from './errors.ts';
import { frozenCopy } from './freeze.ts';
import { invariantResultsDigest, invariantVerdict, type InvariantResult } from './invariants.ts';
import type { ScopedAction } from './module.ts';
import { bindingLifetime, evaluateState, resolveAuthority, type DecisionEnv, type Pipeline } from './pipeline.ts';
import type { ProjectionDigest } from './projection.ts';

export type RevalidationId = Tagged<Digest32, 'RevalidationId'>;

export interface RevalidationRequest {
  /** The payload the authorization's action commits to. */
  readonly payload: Uint8Array;
  /** Fresh snapshots; unused when every binding still re-admits. */
  readonly states: readonly SuppliedState[];
  readonly context: EvaluationContextInput;
}

interface Common {
  readonly authorization: AuthorizationRecord['id'];
  /** The ledger version whose pending set the revalidation read. */
  readonly ledgerVersion: LedgerVersion;
  readonly evaluatedAt: bigint;
  readonly id: RevalidationId;
}

export type RevalidationResult =
  | (Common & {
      readonly status: 'PASSED';
      /** `false`: every binding re-admitted as decided. `true`: fresh state was admitted and every invariant re-ran. */
      readonly refreshed: boolean;
      /** The bindings an artifact would be issued under. */
      readonly bindings: readonly StateBinding[];
      readonly projectionDigest: ProjectionDigest | null;
      readonly invariants: readonly InvariantResult[];
      /** No artifact may outlive this: the authorization's own end, or a fresh binding's, whichever is earlier. */
      readonly validUntil: bigint;
    })
  | (Common & { readonly status: 'FAILED'; readonly refusal: ControlRefusal; readonly invariants: readonly InvariantResult[] });

function revalidationId(authorization: AuthorizationRecord['id'], version: LedgerVersion, at: bigint, passed: boolean, reason: string, bindings: readonly StateBinding[]): RevalidationId {
  const w = controlWriter(ControlTag.REVALIDATION);
  writeDigest(w, authorization);
  w.u64(version).i64(at).u8(passed ? 1 : 0).str(reason);
  writeDigestList(w, bindings.map(stateBindingId).sort());
  return keccakDigest<RevalidationId>(w.finish());
}

/** The reservation an authorization names, if it is still the active one at its generation. */
export function activeReservation(snapshot: LedgerSnapshot, record: AuthorizationRecord): ControlResult<ReservationRecord> {
  const r = snapshot.state.reservations.get(record.reservation);
  if (r === undefined) return refuse('RESERVATION_NOT_ACTIVE', 'RESERVATION_UNKNOWN', 'authorization.reservation');
  if (r.generation !== record.generation || r.action !== record.actionId) return refuse('RESERVATION_NOT_ACTIVE', 'GENERATION_MISMATCH', 'authorization.generation');
  if (!moduleRefsEqual(r.module, record.module)) return refuse('RESERVATION_NOT_ACTIVE', 'MODULE_MISMATCH', 'authorization.module');
  if (r.status !== 'ACTIVE') return refuse('RESERVATION_NOT_ACTIVE', 'RESERVATION_CLOSED', 'authorization.reservation');
  return ok(r);
}

/**
 * Revalidate `record` against `snapshot`. A malformed request, or a
 * reservation that is no longer active, is a refusal; every other outcome is
 * a `PASSED` or `FAILED` value.
 */
export function revalidateWith(p: Pipeline, snapshot: LedgerSnapshot, record: AuthorizationRecord, request: RevalidationRequest, env: DecisionEnv): ControlResult<RevalidationResult> {
  const ctx = validateEvaluationContext(request.context);
  if (!ctx.ok) return ctx;
  const t = ctx.value.evaluationTime;
  const active = activeReservation(snapshot, record);
  if (!active.ok) return active;
  if (!(request.payload instanceof Uint8Array)) return refuse('REQUEST_INVALID', 'WRONG_TYPE', 'request.payload');
  const digest = actionPayloadDigest(record.module, request.payload);
  if (!digest.ok || digest.value !== record.action.payloadDigest) return refuse('REQUEST_INVALID', 'PAYLOAD_DIGEST_MISMATCH', 'request.payload');

  const failed = (r: ControlRefusal, invariants: readonly InvariantResult[] = []): ControlResult<RevalidationResult> =>
    ok({ status: 'FAILED', refusal: r, invariants, authorization: record.id, ledgerVersion: snapshot.version, evaluatedAt: t, id: revalidationId(record.id, snapshot.version, t, false, r.reason, []) });

  // 1. the authorization's own lifetime
  if (t >= record.validUntil) return failed(refusal('REVALIDATION_FAILED', 'AUTHORIZATION_EXPIRED', 'authorization.validUntil'));

  // 2. the lineage at t_i, at the current version
  const authority = resolveAuthority(snapshot, record.action, t);
  if (!authority.ok) return failed({ ...authority.error, code: 'REVALIDATION_FAILED' });

  // The module is the reservation's, for its whole lifecycle; retiring it does not orphan the reservation.
  const module = env.catalog.resolveForLifecycle(record.module);
  if (!module.ok) return failed({ ...module.error, code: 'REVALIDATION_FAILED' });

  // 3. re-admission from the bindings alone, when every one permits it
  const recheck = record.stateBindings.some((b) => b.requirement.atIssue === 'RECHECK');
  if (!recheck) {
    let stale = false;
    for (let i = 0; i < record.stateBindings.length && !stale; i += 1) {
      const under = env.catalog.resolveForLifecycle(record.bindingModules[i] as ModuleRef, 'authorization.bindingModules');
      stale = !under.ok || readmitBinding(record.stateBindings[i] as StateBinding, under.value.ref.domainId, under.value.finalityLadders, ctx.value) !== null;
    }
    if (!stale) {
      return ok({
        status: 'PASSED',
        refreshed: false,
        bindings: record.stateBindings,
        projectionDigest: null,
        invariants: [],
        validUntil: record.validUntil,
        authorization: record.id,
        ledgerVersion: snapshot.version,
        evaluatedAt: t,
        id: revalidationId(record.id, snapshot.version, t, true, 'READMITTED', record.stateBindings),
      });
    }
  }

  // 4. full revalidation on fresh state, over the current pending set (which holds this reservation already)
  const prepared = prepareStates(request.states, 'request.states');
  if (!prepared.ok) return prepared;
  const action: ScopedAction = frozenCopy({ envelope: record.action, actionId: record.actionId, payload: new Uint8Array(request.payload), mode: 'REVALIDATE' as const });
  const evaluation = evaluateState(p, { snapshot, effective: authority.value.effective, acting: module.value, action, prepared: prepared.value, ctx: ctx.value, catalog: env.catalog });
  if (!evaluation.ok) return failed({ ...evaluation.error, code: 'REVALIDATION_FAILED', reason: `${evaluation.error.code}.${evaluation.error.reason}` });
  const verdict = invariantVerdict(evaluation.value.results);
  if (!verdict.ok) return failed({ ...verdict.error, code: 'REVALIDATION_FAILED', reason: `${verdict.error.code}.${verdict.error.reason}` }, evaluation.value.results);

  const bindings = sortCanonical(evaluation.value.admissions.map((a) => a.binding), writeStateBinding);
  const validUntil = bindingLifetime(bindings, record.validUntil);
  if (validUntil <= t) return failed(refusal('REVALIDATION_FAILED', 'LIFETIME_EMPTY', 'validUntil'), evaluation.value.results);
  return ok({
    status: 'PASSED',
    refreshed: true,
    bindings,
    projectionDigest: evaluation.value.projectionDigest,
    invariants: evaluation.value.results,
    validUntil,
    authorization: record.id,
    ledgerVersion: snapshot.version,
    evaluatedAt: t,
    id: revalidationId(record.id, snapshot.version, t, true, invariantResultsDigest(evaluation.value.results), bindings),
  });
}

