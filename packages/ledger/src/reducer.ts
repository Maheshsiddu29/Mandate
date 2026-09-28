/**
 * The ledger's transition rules: a pure fold `Sₙ = reduce(Sₙ₋₁, batchₙ)`
 * (authority-ledger.md §13: "the transition rules are pure functions over
 * (state, events)").
 *
 * - **Pure and total.** No clock, no I/O, no ambient state: every event
 *   carries its evaluation time, and every input yields a new state or a
 *   refusal. Reading a state never changes it — in particular, expiry is
 *   evaluated against an event's time when that event is applied, and nothing
 *   is ever released because time passed (TIME-1).
 * - **One rule set.** The store applies exactly these functions at commit,
 *   and replay applies them again. A `RESERVE` event's lineage, policy and
 *   legs are re-derived from the state and must match, so the recorded charge
 *   path is evidence, never trusted input.
 * - **Atomic batches.** A batch is folded event by event over an immutable
 *   state; the first refusal discards the whole batch, so a batch is applied
 *   entirely or not at all (LEDGER-4). One batch is one version.
 * - **Time never regresses** within a principal's ledger: every event's time
 *   is at or after the latest committed one (7C; implementation-7c.md §5.4).
 *
 * - **Immutable semantics (7D.3).** A registration binds each of its
 *   module-defined terms to one exact definition, and the node or policy
 *   keeps that binding for its life. An unbound module-defined term is
 *   refused — at commit as `SEMANTIC_BINDING_MISSING`, and in replayed
 *   history as `HISTORICAL_SEMANTICS_UNBOUND` — and nothing is inferred for
 *   it from any registry.
 *
 * Boundary with 7D: `CONSUME`, `CLOSE` and `RESTORE` are folded here with
 * their arithmetic and attribution rules. When they are *legal* — which
 * observation, at which finality, for which lots — is the reservation and
 * reconciliation engine's (7D), which this phase does not implement.
 */

import { ok } from '@mandate/kernel';
import {
  UINT256_MAX,
  authorityId,
  partyIdsEqual,
  policyDimensions,
  policyInvariants,
  principalPolicyId,
  termKey,
  type LedgerVersion,
  type PrincipalId,
  type PrincipalPolicy,
  type ReservationId,
  type StateInvariantTerm,
} from '@mandate/core';
import { planReservationId, type ChargePlan } from './charge-plan.ts';
import { checkAvailability, deriveLegs, legRecordOf, policyDimsOf, type LegDraft } from './charging.ts';
import { rescaleExact } from './encoding.ts';
import { refuse, withPath, type LedgerRefusal, type LedgerResult, type TargetRef } from './errors.ts';
import { batchHead, decodeBatch, encodeBatch, type AccountingEvent, type EventLeg, type LedgerEvent } from './events.ts';
import { checkGrantRegistration, checkLineageValid, checkRevocation, resolveLineage } from './graph.ts';
import { MAX_BATCH_EVENTS } from './limits.ts';
import { effectiveAuthority, moduleAllowed, type EffectiveAuthority } from './meet.ts';
import { revocationId } from './revocation.ts';
import {
  availableOf,
  emptyLedgerState,
  nodeTargetKey,
  policyDimensionIdentity,
  policyTargetKey,
  type DemandRecord,
  type LedgerState,
  type NodeRecord,
  type ReservationRecord,
  type TargetBalance,
} from './state.ts';
import type { PMap } from './pmap.ts';
import { CORE_RULES, committedProver, type ReducerRules } from './rules.ts';
import {
  canonicalBindings,
  checkBindingSet,
  checkProofSet,
  checkProofsBound,
  checkRestatedBindings,
  grantInvariants,
  keepsSemantics,
  restatedInvariants,
  type SemanticProofRef,
  type SemanticTermBinding,
} from './semantic.ts';

// --- Registration --------------------------------------------------------------

function zeroBalance(ref: TargetRef, source: TargetBalance['source'], dimension: TargetBalance['dimension']): TargetBalance {
  return { ref, source, dimension, current: true, reserved: 0n, consumed: 0n, restored: 0n, epochConsumed: null };
}

/**
 * AUTH-GLOBAL-2: a policy update may not activate a principal-global
 * constraint that would have to account for activity which already exists,
 * because no baseline of that activity is established. The only baseline the
 * ledger can prove is the empty one — no reservation has ever been committed.
 * Anything else needs the open-lot initialization of authority-model.md §8.2,
 * which is not implemented, so the update is refused.
 *
 * - A **ledger dimension** new to the policy would start from zero while
 *   earlier reservations exist (7C).
 * - A **state invariant** new to the policy, or restated with parameters that
 *   are not provably no stronger than before, would newly constrain activity
 *   that was admitted without it (7D.1). "No stronger" is the definition's own
 *   `noWeaker` with the roles reversed — the old parameters are no weaker than
 *   the new — from the configured ordering; `UNPROVABLE` is not no stronger.
 *   An unchanged restatement and a removed invariant need no baseline. Replay
 *   asks the same ordering again, exactly as for a narrowed delegation — and,
 *   since 7D.2, under exactly the definition the event's proof commits.
 * - Since 7D.3, a restated invariant whose committed binding differs — the
 *   same name under another definition — is a new constraint, whatever its
 *   parameters, and needs the same baseline.
 *
 * Whether a particular earlier reservation is irrelevant to the new
 * constraint is not inferred: any committed reservation counts as activity.
 */
export function checkPolicyBaseline(
  s: LedgerState,
  policy: PrincipalPolicy,
  rules: ReducerRules,
  proofs: readonly SemanticProofRef[] = [],
  bindings: readonly SemanticTermBinding[] = [],
): LedgerResult<true> {
  const constrained = s.policy !== null && s.everReserved;
  // A proof is committed exactly for each restated invariant the ordering is asked about, and for nothing else.
  const needed = constrained ? restatedInvariants(policyInvariants((s.policy as NonNullable<LedgerState['policy']>).policy), policyInvariants(policy)) : [];
  const set = checkProofSet(proofs, needed, 'proofs');
  if (!set.ok) return set;
  const agree = checkProofsBound(proofs, bindings, 'proofs');
  if (!agree.ok) return agree;
  if (s.policy === null || !s.everReserved) return ok(true);
  const previous = s.policy.policy;
  const previousBindings = s.policy.bindings;
  const kept = new Set(policyDimensions(previous).map((d) => policyTargetKey(policyDimensionIdentity(d))));
  const dims = policyDimensions(policy);
  for (let i = 0; i < dims.length; i += 1) {
    const key = policyTargetKey(policyDimensionIdentity(dims[i] as (typeof dims)[number]));
    if (!kept.has(key)) return refuse('POLICY_UPDATE_REQUIRES_BASELINE', `policy.terms.dimension[${i}]`);
  }
  const before = new Map(policyInvariants(previous).map((t) => [termKey(t), t]));
  const invariants = policyInvariants(policy);
  const prove = committedProver(rules.invariantOrdering, proofs);
  for (let i = 0; i < invariants.length; i += 1) {
    const t = invariants[i] as StateInvariantTerm;
    const p = before.get(termKey(t));
    // Same meaning, and no stronger: the old parameters are no weaker than the new, under the committed definition.
    if (p !== undefined && keepsSemantics(p, previousBindings, t, bindings) && (p.params === t.params || prove(t, p) === 'NO_WEAKER')) continue;
    return refuse('POLICY_UPDATE_REQUIRES_BASELINE', `policy.terms.invariant[${i}]`);
  }
  return ok(true);
}

function applyRegisterPolicy(s: LedgerState, e: Extract<LedgerEvent, { kind: 'REGISTER_POLICY' }>, version: LedgerVersion, rules: ReducerRules): LedgerResult<LedgerState> {
  const policy = e.policy;
  if (!partyIdsEqual(policy.principal, s.principal)) return refuse('PRINCIPAL_MISMATCH', 'policy.principal');
  const id = principalPolicyId(policy);
  const dims = policyDimensions(policy);
  let targets = s.targets;

  if (s.policy !== null && policy.sequence <= s.policy.policy.sequence) return refuse('POLICY_SEQUENCE_NOT_INCREASING', 'policy.sequence');
  const bindings = e.bindings ?? [];
  const bound = checkBindingSet(bindings, policyInvariants(policy), 'bindings', 'policy.terms');
  if (!bound.ok) return bound;
  const baseline = checkPolicyBaseline(s, policy, rules, e.proofs ?? [], bindings);
  if (!baseline.ok) return baseline;
  if (s.policy !== null) {
    for (const d of policyDimensions(s.policy.policy)) {
      const key = policyTargetKey(policyDimensionIdentity(d));
      const b = targets.get(key) as TargetBalance;
      targets = targets.set(key, { ...b, current: false });
    }
  }

  for (const d of dims) {
    const key = policyTargetKey(policyDimensionIdentity(d));
    const ref: TargetRef = { kind: 'POLICY', policy: id, dimensionId: d.dimensionId };
    const prev = targets.get(key);
    // A kept dimension keeps its whole history; only its ceiling follows the new policy.
    targets = targets.set(key, prev === undefined ? zeroBalance(ref, 'POLICY', d) : { ...prev, ref, dimension: d, current: true });
  }
  return ok({ ...s, policy: { id, policy, bindings: canonicalBindings(bindings), registeredAt: version }, targets });
}

function applyRegisterGrant(s: LedgerState, e: Extract<LedgerEvent, { kind: 'REGISTER_GRANT' }>, version: LedgerVersion, rules: ReducerRules): LedgerResult<LedgerState> {
  const id = authorityId(e.grant);
  const proofs = e.proofs ?? [];
  const bindings = e.bindings ?? [];
  const invariants = grantInvariants(e.grant);
  // Every module-defined term is bound to exactly one definition, and nothing else is bound.
  const bound = checkBindingSet(bindings, invariants, 'bindings', 'grant.terms');
  if (!bound.ok) return bound;
  // A proof is committed exactly for each invariant the child restates with other parameters, and for nothing else.
  const parent = e.grant.lineage.kind === 'DELEGATION' ? s.nodes.get(e.grant.lineage.parent) : undefined;
  const needed = parent === undefined ? [] : restatedInvariants(grantInvariants(parent.grant), invariants);
  const set = checkProofSet(proofs, needed, 'proofs');
  if (!set.ok) return set;
  // …under the definition the term itself is bound to, and a restated term keeps its parent's meaning.
  const agree = checkProofsBound(proofs, bindings, 'proofs');
  if (!agree.ok) return agree;
  if (parent !== undefined) {
    const kept = checkRestatedBindings(grantInvariants(parent.grant), parent.bindings, invariants, bindings, 'grant.terms');
    if (!kept.ok) return kept;
  }
  const depth = checkGrantRegistration(s, id, e.grant, e.at, 'grant', committedProver(rules.invariantOrdering, proofs));
  if (!depth.ok) return depth;
  let targets = s.targets;
  for (const t of e.grant.terms) {
    if (t.kind !== 'LEDGER_DIMENSION') continue;
    targets = targets.set(nodeTargetKey(id, t.dimensionId), zeroBalance({ kind: 'NODE', authority: id, dimensionId: t.dimensionId }, 'GRANT', t));
  }
  const node: NodeRecord = { id, grant: e.grant, depth: depth.value, bindings: canonicalBindings(bindings), registeredAt: version, revokedAt: null, revocation: null };
  return ok({ ...s, nodes: s.nodes.set(id, node), targets });
}

function applyRevoke(s: LedgerState, e: Extract<LedgerEvent, { kind: 'REVOKE' }>, version: LedgerVersion): LedgerResult<LedgerState> {
  const valid = checkRevocation(s, e.revocation, e.at);
  if (!valid.ok) return valid;
  const node = s.nodes.get(e.revocation.target) as NodeRecord;
  // The node is marked, never removed. Its outstanding reservations are untouched: revocation stops
  // future authorization; it is not evidence that an issued attempt cannot still execute.
  return ok({ ...s, nodes: s.nodes.set(node.id, { ...node, revokedAt: version, revocation: revocationId(e.revocation) }) });
}

// --- Reservation ---------------------------------------------------------------

export interface DerivedReservation {
  readonly reservation: ReservationId;
  readonly lineage: readonly NodeRecord[];
  readonly effective: EffectiveAuthority;
  readonly legs: readonly (readonly LegDraft[])[];
}

/**
 * Everything a `RESERVE` for `plan` at time `at` must be, derived from the
 * state: lineage validity, holder, module coverage, reservation identity and
 * generation, and the complete charging path. Availability is checked
 * separately (`checkAvailability`), so a caller can see the path and each
 * leg's headroom even when the plan does not fit.
 */
export function deriveReservation(s: LedgerState, plan: ChargePlan, at: bigint): LedgerResult<DerivedReservation> {
  if (!partyIdsEqual(plan.principal, s.principal)) return refuse('PRINCIPAL_MISMATCH', 'plan.principal');
  if (s.policy === null) return refuse('PRINCIPAL_POLICY_MISSING', 'plan');
  const lineage = resolveLineage(s, plan.authority, 'plan.authority');
  if (!lineage.ok) return lineage;
  const valid = checkLineageValid(s, lineage.value, at, 'plan.authority');
  if (!valid.ok) return valid;
  const leaf = lineage.value[0] as NodeRecord;
  if (!partyIdsEqual(plan.actor, leaf.grant.holder)) return refuse('ACTOR_NOT_HOLDER', 'plan.actor', leaf.id);
  const effective = effectiveAuthority(lineage.value, s.policy.policy, 'plan.authority', s.policy.bindings);
  if (!effective.ok) return effective;
  if (!moduleAllowed(effective.value, plan.module)) return refuse('MODULE_NOT_PERMITTED', 'plan.module', leaf.id);

  const reservation = planReservationId(plan);
  if (s.reservations.has(reservation)) return refuse('RESERVATION_EXISTS', 'plan.generation');
  const action = s.actions.get(plan.action);
  if (action !== undefined && action.open !== null) return refuse('PREVIOUS_GENERATION_OPEN', 'plan.generation');
  const expected = action === undefined ? 1n : action.lastGeneration + 1n;
  if (plan.generation !== expected) return refuse('GENERATION_OUT_OF_SEQUENCE', 'plan.generation');

  const legs = deriveLegs(lineage.value, s.policy.id, policyDimsOf(s), plan.contributions, plan.module.domainId, at);
  if (!legs.ok) return legs;
  return ok({ reservation, lineage: lineage.value, effective: effective.value, legs: legs.value });
}

export function eventLegsOf(legs: readonly (readonly LegDraft[])[]): readonly (readonly EventLeg[])[] {
  return legs.map((per) => per.map((l) => ({ target: l.ref, amount: l.amount, epoch: l.epoch })));
}

/** The `RESERVE` event for `plan` at `at`, with its derived lineage, policy and legs. */
export function deriveReserveEvent(s: LedgerState, plan: ChargePlan, at: bigint): LedgerResult<Extract<LedgerEvent, { kind: 'RESERVE' }>> {
  const d = deriveReservation(s, plan, at);
  if (!d.ok) return d;
  return ok({
    kind: 'RESERVE',
    at,
    plan,
    lineage: d.value.lineage.map((n) => n.id),
    policy: (s.policy as NonNullable<LedgerState['policy']>).id,
    legs: eventLegsOf(d.value.legs),
  });
}

function sameTarget(a: TargetRef, b: TargetRef): boolean {
  if (a.dimensionId !== b.dimensionId) return false;
  if (a.kind === 'NODE') return b.kind === 'NODE' && a.authority === b.authority;
  return b.kind === 'POLICY' && a.policy === b.policy;
}

function sameLegs(recorded: readonly (readonly EventLeg[])[], derived: readonly (readonly LegDraft[])[]): boolean {
  if (recorded.length !== derived.length) return false;
  for (let i = 0; i < recorded.length; i += 1) {
    const r = recorded[i] as readonly EventLeg[];
    const d = derived[i] as readonly LegDraft[];
    if (r.length !== d.length) return false;
    for (let j = 0; j < r.length; j += 1) {
      const x = r[j] as EventLeg;
      const y = d[j] as LegDraft;
      if (!sameTarget(x.target, y.ref) || x.amount !== y.amount || x.epoch !== y.epoch) return false;
    }
  }
  return true;
}

function applyReserve(s: LedgerState, e: Extract<LedgerEvent, { kind: 'RESERVE' }>, version: LedgerVersion): LedgerResult<LedgerState> {
  const d = deriveReservation(s, e.plan, e.at);
  if (!d.ok) return d;
  const policy = (s.policy as NonNullable<LedgerState['policy']>).id;
  const lineage = d.value.lineage.map((n) => n.id);
  if (e.policy !== policy) return refuse('CHARGE_PATH_MISMATCH', 'policy');
  if (e.lineage.length !== lineage.length || e.lineage.some((id, i) => id !== lineage[i])) return refuse('CHARGE_PATH_MISMATCH', 'lineage');
  if (!sameLegs(e.legs, d.value.legs)) return refuse('CHARGE_PATH_MISMATCH', 'legs');
  const demand = checkAvailability(s, d.value.legs, e.at);
  if (!demand.ok) return demand;

  let targets = s.targets;
  for (const [key, amount] of demand.value) {
    const b = targets.get(key) as TargetBalance;
    targets = targets.set(key, { ...b, reserved: b.reserved + amount });
  }
  const record: ReservationRecord = {
    id: d.value.reservation,
    action: e.plan.action,
    generation: e.plan.generation,
    authority: e.plan.authority,
    lineage,
    policy,
    module: e.plan.module,
    implementation: e.plan.implementation,
    committedAt: version,
    reservedAt: e.at,
    status: 'ACTIVE',
    demands: e.plan.contributions.map((c, i) => ({
      contribution: c,
      legs: (d.value.legs[i] as readonly LegDraft[]).map(legRecordOf),
      reserved: c.quantity.atoms,
      consumed: 0n,
      released: 0n,
      restored: 0n,
    })),
  };
  return ok({
    ...s,
    everReserved: true,
    targets,
    reservations: s.reservations.set(record.id, record),
    actions: s.actions.set(e.plan.action, { lastGeneration: e.plan.generation, open: record.id }),
  });
}

// --- Accounting ----------------------------------------------------------------

function reservationFor(s: LedgerState, e: AccountingEvent<'CONSUME' | 'CLOSE' | 'RESTORE'>): LedgerResult<ReservationRecord> {
  const r = s.reservations.get(e.reservation);
  if (r === undefined) return refuse('RESERVATION_UNKNOWN', 'reservation');
  // The id is H(action, generation): an effect restating another generation names a different reservation.
  if (r.generation !== e.generation) return refuse('RESERVATION_ID_MISMATCH', 'generation');
  if (e.amounts.length !== r.demands.length || e.amounts.some((a) => a < 0n)) return refuse('ACCOUNTING_SHAPE_INVALID', 'amounts');
  return ok(r);
}

/** Apply `delta(leg)` to every leg's target; each leg's amount is the demand's, rescaled exactly. */
function forEachLeg(
  targets: PMap<TargetBalance>,
  demand: DemandRecord,
  amount: bigint,
  path: string,
  only: (capacity: boolean) => boolean,
  update: (b: TargetBalance, legAmount: bigint, epoch: bigint | null) => TargetBalance | null,
): LedgerResult<PMap<TargetBalance>> {
  let out = targets;
  for (const leg of demand.legs) {
    if (!only(leg.capacity)) continue;
    const legAmount = rescaleExact(amount, demand.contribution.quantity.decimals, leg.decimals);
    if (legAmount === null) return refuse('INEXACT_RESCALE', path);
    const next = update(out.get(leg.key) as TargetBalance, legAmount, leg.epoch);
    if (next === null) return refuse('AMOUNT_OVERFLOW', path);
    out = out.set(leg.key, next);
  }
  return ok(out);
}

const allLegs = (): boolean => true;
const capacityLegs = (capacity: boolean): boolean => capacity;

function applyConsume(s: LedgerState, e: AccountingEvent<'CONSUME'>): LedgerResult<LedgerState> {
  const r = reservationFor(s, e);
  if (!r.ok) return r;
  if (r.value.status !== 'ACTIVE') return refuse('RESERVATION_CLOSED', 'reservation');
  if (!e.amounts.some((a) => a > 0n)) return refuse('ACCOUNTING_SHAPE_INVALID', 'amounts');
  let targets = s.targets;
  const demands: DemandRecord[] = [];
  for (let i = 0; i < r.value.demands.length; i += 1) {
    const d = r.value.demands[i] as DemandRecord;
    const amount = e.amounts[i] as bigint;
    // Consumption beyond the reservation is OVERRUN (authority-ledger.md §10), which is 7D's to record.
    if (amount > d.reserved - d.consumed) return refuse('CONSUME_EXCEEDS_RESERVED', `amounts[${i}]`);
    const t = forEachLeg(targets, d, amount, `amounts[${i}]`, allLegs, (b, x, epoch) => {
      if (b.consumed + x > UINT256_MAX) return null;
      let epochConsumed = b.epochConsumed;
      if (epoch !== null) {
        if (epochConsumed === null || epochConsumed.epoch < epoch) epochConsumed = { epoch, atoms: x };
        else if (epochConsumed.epoch === epoch) epochConsumed = { epoch, atoms: epochConsumed.atoms + x };
      }
      return { ...b, reserved: b.reserved - x, consumed: b.consumed + x, epochConsumed };
    });
    if (!t.ok) return t;
    targets = t.value;
    demands.push({ ...d, consumed: d.consumed + amount });
  }
  return ok({ ...s, targets, reservations: s.reservations.set(r.value.id, { ...r.value, demands }) });
}

function applyClose(s: LedgerState, e: AccountingEvent<'CLOSE'>): LedgerResult<LedgerState> {
  const r = reservationFor(s, e);
  if (!r.ok) return r;
  if (r.value.status !== 'ACTIVE') return refuse('RESERVATION_CLOSED', 'reservation');
  let targets = s.targets;
  const demands: DemandRecord[] = [];
  for (let i = 0; i < r.value.demands.length; i += 1) {
    const d = r.value.demands[i] as DemandRecord;
    const remaining = d.reserved - d.consumed;
    // `released = reserved − consumed`, set once (§5). A release is never more — or less — than what remains.
    if (e.amounts[i] !== remaining) return refuse('RELEASE_MISMATCH', `amounts[${i}]`);
    const t = forEachLeg(targets, d, remaining, `amounts[${i}]`, allLegs, (b, x) => ({ ...b, reserved: b.reserved - x }));
    if (!t.ok) return t;
    targets = t.value;
    demands.push({ ...d, released: remaining });
  }
  const action = s.actions.get(r.value.action);
  const actions = action !== undefined && action.open === r.value.id ? s.actions.set(r.value.action, { ...action, open: null }) : s.actions;
  return ok({ ...s, targets, actions, reservations: s.reservations.set(r.value.id, { ...r.value, status: 'CLOSED', demands }) });
}

function applyRestore(s: LedgerState, e: AccountingEvent<'RESTORE'>): LedgerResult<LedgerState> {
  const r = reservationFor(s, e);
  if (!r.ok) return r;
  if (!e.amounts.some((a) => a > 0n)) return refuse('ACCOUNTING_SHAPE_INVALID', 'amounts');
  let targets = s.targets;
  const demands: DemandRecord[] = [];
  for (let i = 0; i < r.value.demands.length; i += 1) {
    const d = r.value.demands[i] as DemandRecord;
    const amount = e.amounts[i] as bigint;
    // LEDGER-RESTORE-1, per charge: never more than this reservation consumed and has not yet had restored.
    if (amount > d.consumed - d.restored) return refuse('RESTORE_EXCEEDS_CONSUMED', `amounts[${i}]`);
    if (amount > 0n && !d.legs.some((l) => l.capacity)) return refuse('RESTORE_NOT_PERMITTED', `amounts[${i}]`);
    // Credited to the legs this reservation was charged to — never to the restoring actor's path. BUDGET legs never restore.
    const t = forEachLeg(targets, d, amount, `amounts[${i}]`, capacityLegs, (b, x) => ({ ...b, restored: b.restored + x }));
    if (!t.ok) return t;
    targets = t.value;
    demands.push({ ...d, restored: d.restored + amount });
  }
  return ok({ ...s, targets, reservations: s.reservations.set(r.value.id, { ...r.value, demands }) });
}

// --- Folding -------------------------------------------------------------------

export function applyEvent(s: LedgerState, e: LedgerEvent, version: LedgerVersion, rules: ReducerRules = CORE_RULES): LedgerResult<LedgerState> {
  if (s.lastAt !== null && e.at < s.lastAt) return refuse('EVALUATION_TIME_REGRESSED', 'at');
  let next: LedgerResult<LedgerState>;
  switch (e.kind) {
    case 'REGISTER_POLICY':
      next = applyRegisterPolicy(s, e, version, rules);
      break;
    case 'REGISTER_GRANT':
      next = applyRegisterGrant(s, e, version, rules);
      break;
    case 'REVOKE':
      next = applyRevoke(s, e, version);
      break;
    case 'RESERVE':
      next = applyReserve(s, e, version);
      break;
    case 'CONSUME':
      next = applyConsume(s, e);
      break;
    case 'CLOSE':
      next = applyClose(s, e);
      break;
    case 'RESTORE':
      next = applyRestore(s, e);
      break;
  }
  return next.ok ? ok({ ...next.value, lastAt: e.at }) : next;
}

export interface AppliedBatch {
  readonly state: LedgerState;
  /** The canonical batch encoding: what a store persists, and what the new head is the digest of. */
  readonly encoded: Uint8Array;
}

/** Apply one batch atomically: every event, or none. The version advances by exactly one. */
export function applyBatch(s: LedgerState, events: readonly LedgerEvent[], rules: ReducerRules = CORE_RULES): LedgerResult<AppliedBatch> {
  if (events.length === 0) return refuse('BATCH_EMPTY', 'events');
  if (events.length > MAX_BATCH_EVENTS) return refuse('BATCH_TOO_LARGE', 'events');
  const version = (s.version + 1n) as LedgerVersion;
  let current = s;
  for (let i = 0; i < events.length; i += 1) {
    const next = applyEvent(current, events[i] as LedgerEvent, version, rules);
    if (!next.ok) return { ok: false, error: withPath(next.error, `events[${i}]`) };
    current = next.value;
  }
  const encoded = encodeBatch(s.principal, version, s.head, events);
  return ok({ state: { ...current, version, head: batchHead(encoded) }, encoded });
}

/**
 * A module-defined term with no committed binding, met while replaying
 * history, is history whose semantics were never bound: nothing may be
 * inferred for it, so replay refuses (7D.3).
 */
function historical(r: LedgerRefusal, path: string): LedgerRefusal {
  const e = withPath(r, path);
  return e.code === 'SEMANTIC_BINDING_MISSING' ? { code: 'HISTORICAL_SEMANTICS_UNBOUND', path: e.path, node: e.node } : e;
}

/** The full fold from genesis over in-memory batches, under the same rules the store committed them with. */
export function replay(principal: PrincipalId, batches: readonly (readonly LedgerEvent[])[], rules: ReducerRules = CORE_RULES): LedgerResult<LedgerState> {
  let s = emptyLedgerState(principal);
  for (let i = 0; i < batches.length; i += 1) {
    const r = applyBatch(s, batches[i] as readonly LedgerEvent[], rules);
    if (!r.ok) return { ok: false, error: historical(r.error, `batches[${i}]`) };
    s = r.value.state;
  }
  return ok(s);
}

/**
 * The full fold from genesis over stored batch encodings: each must decode,
 * name this principal, carry the next version, extend the previous head and
 * be byte-identical to its own re-encoding.
 */
export function replayEncoded(principal: PrincipalId, batches: readonly Uint8Array[], rules: ReducerRules = CORE_RULES): LedgerResult<LedgerState> {
  let s = emptyLedgerState(principal);
  for (let i = 0; i < batches.length; i += 1) {
    const path = `batches[${i}]`;
    const bytes = batches[i] as Uint8Array;
    const decoded = decodeBatch(bytes);
    if (!decoded.ok) return { ok: false, error: { code: 'MALFORMED', path, core: decoded.error } };
    const b = decoded.value;
    if (!partyIdsEqual(b.principal, principal) || b.version !== s.version + 1n || b.previousHead !== s.head) {
      return refuse('LEDGER_CHAIN_BROKEN', path);
    }
    const r = applyBatch(s, b.events, rules);
    if (!r.ok) return { ok: false, error: historical(r.error, path) };
    if (r.value.encoded.length !== bytes.length || r.value.encoded.some((x, j) => x !== bytes[j])) return refuse('LEDGER_CHAIN_BROKEN', path);
    s = r.value.state;
  }
  return ok(s);
}

// --- Read-only views -----------------------------------------------------------

export interface LegPreview {
  readonly target: TargetRef;
  readonly source: TargetBalance['source'];
  readonly amount: bigint;
  readonly available: bigint;
  readonly limit: bigint;
  readonly decimals: number;
}

/**
 * The charging path a plan would take at `at`, with each leg's headroom —
 * what an agent's "local view" cannot see. Pure; changes nothing.
 */
export function previewCharge(s: LedgerState, plan: ChargePlan, at: bigint): LedgerResult<readonly (readonly LegPreview[])[]> {
  const d = deriveReservation(s, plan, at);
  if (!d.ok) return d;
  return ok(
    d.value.legs.map((per) =>
      per.map((l) => {
        const b = s.targets.get(l.key) as TargetBalance;
        return { target: l.ref, source: b.source, amount: l.amount, available: availableOf(b, at), limit: l.dimension.limit.atoms, decimals: l.dimension.limit.decimals };
      }),
    ),
  );
}
