/**
 * Ledger events and the hash-chained batch (authority-ledger.md §5, §9, §13).
 *
 * A closed union, one variant per event the specification names that 7C
 * folds. Each carries its evaluation time and exactly its own typed fields;
 * there is no `{ type: string, payload }` shape and no generic adjustment.
 *
 * | Event             | Effect                                                             |
 * | ----------------- | ------------------------------------------------------------------ |
 * | `REGISTER_POLICY` | the principal policy is set, or replaced by a higher sequence       |
 * | `REGISTER_GRANT`  | a node is registered, its dimensions become targets                 |
 * | `REVOKE`          | a node and its subtree are revoked for new use                      |
 * | `RESERVE`         | a plan's legs are reserved on every target of its charging path     |
 * | `CONSUME`         | reserved → consumed, per contribution, on every leg                 |
 * | `CLOSE`           | the remainder of every leg is released; the reservation is closed   |
 * | `RESTORE`         | consumed capacity is restored to the legs it was charged to         |
 *
 * `CONSUME`, `CLOSE` and `RESTORE` are accounting effects. Each names the
 * observation it is the effect of (an `ObservationId`), because the
 * specification admits them only as effects of applied observations (§5,
 * RECON-3). 7C folds their arithmetic; it does not validate observations or
 * decide when these transitions are legal. That is 7D.
 *
 * A `RESERVE` event carries the plan, the lineage and policy it was decided
 * under, and every leg with its amount and epoch — the provenance of the
 * charge. The reducer re-derives all of it from the state and refuses the
 * event if anything differs, so the recorded legs are evidence, not input.
 *
 * ```text
 * batch  = str("mandate-core/v1/ledger-batch") ‖ u16(1) ‖ principal ‖ u64(version) ‖ bytes32(previousHead) ‖ u16(n) ‖ event₁ … eventₙ
 * head   = keccak-256(batch)
 * head₀  = keccak-256(str("mandate-core/v1/ledger-genesis") ‖ u16(1) ‖ principal)
 * ```
 *
 * Every batch commits to its principal, its version, the previous head and
 * every event in order, so the same history always yields the same head, and
 * reordering, altering, inserting or removing any event changes every later
 * head.
 *
 * **Semantic proofs (7D.2).** A `REGISTER_GRANT` or `REGISTER_POLICY` whose
 * acceptance rests on an invariant definition's comparator commits which
 * exact definition decided it (`SemanticProofRef`, semantic.ts). Such an
 * event is written under its own wire code, followed by the canonical proof
 * list; an event with no proof keeps its 7C code and bytes exactly, so every
 * earlier history, and its heads, are unchanged:
 *
 * ```text
 * REGISTER_POLICY        u8(1) ‖ i64(at) ‖ segment(policy)
 * REGISTER_POLICY+proofs u8(8) ‖ i64(at) ‖ segment(policy) ‖ u16(n ≥ 1) ‖ SemanticProofRef₁ … ₙ
 * REGISTER_GRANT         u8(2) ‖ i64(at) ‖ segment(grant)
 * REGISTER_GRANT+proofs  u8(9) ‖ i64(at) ‖ segment(grant) ‖ u16(n ≥ 1) ‖ SemanticProofRef₁ … ₙ
 * ```
 *
 * **Semantic bindings (7D.3).** A registration whose grant or policy has a
 * module-defined term commits, for each such term, the exact definition it
 * is interpreted under (`SemanticTermBinding`, semantic.ts). Such an event
 * is written under a third pair of wire codes, carrying its bindings and
 * then its proofs (possibly none). An event without bindings keeps its 7C
 * or 7D.2 code and bytes exactly, so a history whose terms are all Core's is
 * unchanged:
 *
 * ```text
 * REGISTER_POLICY+bindings u8(10) ‖ i64(at) ‖ segment(policy) ‖ u16(m ≥ 1) ‖ SemanticTermBinding₁ … ₘ ‖ u16(n ≥ 0) ‖ SemanticProofRef₁ … ₙ
 * REGISTER_GRANT+bindings  u8(11) ‖ i64(at) ‖ segment(grant)  ‖ u16(m ≥ 1) ‖ SemanticTermBinding₁ … ₘ ‖ u16(n ≥ 0) ‖ SemanticProofRef₁ … ₙ
 * ```
 *
 * Every registration has exactly one encoding: no binding and no proof is
 * code 1 or 2; proofs only, 8 or 9; any binding, 10 or 11. Which bindings a
 * registration must carry — one per module-defined term, none otherwise —
 * is the reducer's rule, checked at commit and at every replay.
 */

import { ok, type ByteWriter } from '@mandate/kernel';
import {
  CoreReader,
  DecodeFailure,
  decodeAuthorityGrant,
  decodePrincipalPolicy,
  encodeAuthorityGrant,
  encodePrincipalPolicy,
  fail,
  parseDigest,
  parseNonZeroDigest,
  parseReservationGeneration,
  parseUnixSeconds,
  readCode,
  readNullable,
  readPartyInput,
  validatePrincipalId,
  writeCode,
  writeDigest,
  writeNullable,
  writeParty,
  type AuthorityGrant,
  type AuthorityId,
  type CoreResult,
  type DimensionId,
  type LedgerHeadDigest,
  type LedgerVersion,
  type ObservationId,
  type PrincipalId,
  type PrincipalPolicy,
  type PrincipalPolicyId,
  type ReservationGeneration,
  type ReservationId,
  type WireCodes,
  CORE_SCHEMA_VERSION,
  MAX_LINEAGE_LENGTH,
  keccakDigest,
  parseIdentifierAs,
} from '@mandate/core';
import { readChargePlanInput, validateChargePlan, writeChargePlan, type ChargePlan } from './charge-plan.ts';
import { LedgerTag, ledgerWriter, readSegment, writeSegment } from './encoding.ts';
import type { TargetRef } from './errors.ts';
import { MAX_BATCH_EVENTS, MAX_LEGS_PER_CONTRIBUTION, MAX_PLAN_CONTRIBUTIONS } from './limits.ts';
import { decodeRevocation, encodeRevocation, type Revocation } from './revocation.ts';
import {
  MAX_SEMANTIC_BINDINGS,
  MAX_SEMANTIC_PROOFS,
  readSemanticProofRef,
  readSemanticTermBinding,
  writeSemanticProofRef,
  writeSemanticTermBinding,
  type SemanticProofRef,
  type SemanticTermBinding,
} from './semantic.ts';
import { writeTargetRef } from './state.ts';

export interface EventLeg {
  readonly target: TargetRef;
  /** At the target dimension's decimals. */
  readonly amount: bigint;
  readonly epoch: bigint | null;
}

export type LedgerEvent =
  | {
      readonly kind: 'REGISTER_POLICY';
      readonly at: bigint;
      readonly policy: PrincipalPolicy;
      /** The definitions that proved each restated invariant no stronger (7D.2). Absent = none. */
      readonly proofs?: readonly SemanticProofRef[];
      /** The exact definition of each module-defined invariant (7D.3). Absent = none. */
      readonly bindings?: readonly SemanticTermBinding[];
    }
  | {
      readonly kind: 'REGISTER_GRANT';
      readonly at: bigint;
      readonly grant: AuthorityGrant;
      /** The definitions that proved each restated invariant no weaker (7D.2). Absent = none. */
      readonly proofs?: readonly SemanticProofRef[];
      /** The exact definition of each module-defined invariant (7D.3). Absent = none. */
      readonly bindings?: readonly SemanticTermBinding[];
    }
  | { readonly kind: 'REVOKE'; readonly at: bigint; readonly revocation: Revocation }
  | {
      readonly kind: 'RESERVE';
      readonly at: bigint;
      readonly plan: ChargePlan;
      /** Leaf to root, as resolved at the committing version. */
      readonly lineage: readonly AuthorityId[];
      readonly policy: PrincipalPolicyId;
      /** One list per contribution. */
      readonly legs: readonly (readonly EventLeg[])[];
    }
  | AccountingEvent<'CONSUME'>
  | AccountingEvent<'CLOSE'>
  | AccountingEvent<'RESTORE'>;

export interface AccountingEvent<K extends 'CONSUME' | 'CLOSE' | 'RESTORE'> {
  readonly kind: K;
  readonly at: bigint;
  readonly reservation: ReservationId;
  /** Restated explicitly: an effect for generation `g` can never be read as one for `g + 1`. */
  readonly generation: ReservationGeneration;
  /** The observation this is the effect of. Not validated in 7C. */
  readonly evidence: ObservationId;
  /** Per contribution, at the contribution's decimals: consumed, released or restored. */
  readonly amounts: readonly bigint[];
}

export type LedgerEventKind = LedgerEvent['kind'];

/** Wire kinds: every event kind, plus the proof-carrying (7D.2) and binding-carrying (7D.3) forms of the two registrations. */
type WireKind = LedgerEventKind | 'REGISTER_POLICY_PROVEN' | 'REGISTER_GRANT_PROVEN' | 'REGISTER_POLICY_BOUND' | 'REGISTER_GRANT_BOUND';

const EVENT_CODE: WireCodes<WireKind> = {
  REGISTER_POLICY: 1,
  REGISTER_GRANT: 2,
  REVOKE: 3,
  RESERVE: 4,
  CONSUME: 5,
  CLOSE: 6,
  RESTORE: 7,
  REGISTER_POLICY_PROVEN: 8,
  REGISTER_GRANT_PROVEN: 9,
  REGISTER_POLICY_BOUND: 10,
  REGISTER_GRANT_BOUND: 11,
};

function wireKind(e: LedgerEvent): WireKind {
  if (e.kind === 'REGISTER_POLICY' && (e.bindings?.length ?? 0) > 0) return 'REGISTER_POLICY_BOUND';
  if (e.kind === 'REGISTER_GRANT' && (e.bindings?.length ?? 0) > 0) return 'REGISTER_GRANT_BOUND';
  if (e.kind === 'REGISTER_POLICY' && (e.proofs?.length ?? 0) > 0) return 'REGISTER_POLICY_PROVEN';
  if (e.kind === 'REGISTER_GRANT' && (e.proofs?.length ?? 0) > 0) return 'REGISTER_GRANT_PROVEN';
  return e.kind;
}

/** The semantic suffix of a registration: nothing (codes 1, 2), proofs (8, 9), or bindings then proofs (10, 11). */
function writeSemantics(w: ByteWriter, bindings: readonly SemanticTermBinding[] | undefined, proofs: readonly SemanticProofRef[] | undefined): void {
  const b = bindings ?? [];
  const p = proofs ?? [];
  if (b.length > 0) {
    w.u16(b.length);
    for (const x of b) writeSemanticTermBinding(w, x);
    w.u16(p.length);
  } else if (p.length > 0) w.u16(p.length);
  for (const x of p) writeSemanticProofRef(w, x);
}

const TARGET_CODE = { NODE: 1, POLICY: 2 } as const;

// --- Writing -------------------------------------------------------------------

function writeLeg(w: ByteWriter, leg: EventLeg): void {
  writeTargetRef(w, leg.target);
  w.u256(leg.amount);
  writeNullable(w, leg.epoch, (x, e) => x.u64(e));
}

export function writeEventBody(w: ByteWriter, e: LedgerEvent): void {
  writeCode(w, EVENT_CODE, wireKind(e));
  w.i64(e.at);
  switch (e.kind) {
    case 'REGISTER_POLICY':
      writeSegment(w, encodePrincipalPolicy(e.policy));
      writeSemantics(w, e.bindings, e.proofs);
      return;
    case 'REGISTER_GRANT':
      writeSegment(w, encodeAuthorityGrant(e.grant));
      writeSemantics(w, e.bindings, e.proofs);
      return;
    case 'REVOKE':
      writeSegment(w, encodeRevocation(e.revocation));
      return;
    case 'RESERVE':
      writeChargePlan(w, e.plan);
      w.u16(e.lineage.length);
      for (const id of e.lineage) writeDigest(w, id);
      writeDigest(w, e.policy);
      w.u16(e.legs.length);
      for (const legs of e.legs) {
        w.u16(legs.length);
        for (const leg of legs) writeLeg(w, leg);
      }
      return;
    case 'CONSUME':
    case 'CLOSE':
    case 'RESTORE':
      writeDigest(w, e.reservation);
      w.u64(e.generation);
      writeDigest(w, e.evidence);
      w.u16(e.amounts.length);
      for (const a of e.amounts) w.u256(a);
      return;
  }
}

/** A single event as a tagged object: for receipts and tests. A batch embeds event bodies. */
export function encodeLedgerEvent(e: LedgerEvent): Uint8Array {
  const w = ledgerWriter(LedgerTag.LEDGER_EVENT);
  writeEventBody(w, e);
  return w.finish();
}

export function encodeBatch(principal: PrincipalId, version: LedgerVersion, previousHead: LedgerHeadDigest, events: readonly LedgerEvent[]): Uint8Array {
  const w = ledgerWriter(LedgerTag.LEDGER_BATCH);
  writeParty(w, principal);
  w.u64(version);
  writeDigest(w, previousHead);
  w.u16(events.length);
  for (const e of events) writeEventBody(w, e);
  return w.finish();
}

export function batchHead(encodedBatch: Uint8Array): LedgerHeadDigest {
  return keccakDigest<LedgerHeadDigest>(encodedBatch);
}

// --- Reading -------------------------------------------------------------------

function decodeEmbedded<T>(r: CoreReader, decode: (bytes: Uint8Array) => CoreResult<T>): T {
  const d = decode(readSegment(r));
  if (!d.ok) throw new DecodeFailure(d.error.code);
  return d.value;
}

function must<T>(v: CoreResult<T>): T {
  if (!v.ok) throw new DecodeFailure(v.error.code);
  return v.value;
}

function readTargetRef(r: CoreReader): TargetRef {
  const kind = readCode(r, TARGET_CODE);
  const digest = r.digest();
  const dimensionId = must(parseIdentifierAs<DimensionId>(r.str(), 'dimensionId'));
  return kind === 'NODE'
    ? { kind, authority: must(parseDigest<AuthorityId>(digest, 'target')), dimensionId }
    : { kind, policy: must(parseDigest<PrincipalPolicyId>(digest, 'target')), dimensionId };
}

function readLeg(r: CoreReader): EventLeg {
  const target = readTargetRef(r);
  const amount = r.u256();
  const epoch = readNullable(r, (x) => x.u64());
  return { target, amount, epoch };
}

/** A proof-carrying form has at least one proof: an empty list has exactly one encoding, the 7C one. */
function readProofs(r: CoreReader, min = 1): SemanticProofRef[] {
  const n = r.u16();
  if (n < min || n > MAX_SEMANTIC_PROOFS) throw new DecodeFailure('ENCODING_MALFORMED');
  const out: SemanticProofRef[] = [];
  for (let i = 0; i < n; i += 1) out.push(readSemanticProofRef(r));
  return out;
}

/** A binding-carrying form has at least one binding, then its proofs — possibly none. */
function readBound(r: CoreReader): { bindings: SemanticTermBinding[]; proofs?: SemanticProofRef[] } {
  const n = r.u16();
  if (n === 0 || n > MAX_SEMANTIC_BINDINGS) throw new DecodeFailure('ENCODING_MALFORMED');
  const bindings: SemanticTermBinding[] = [];
  for (let i = 0; i < n; i += 1) bindings.push(readSemanticTermBinding(r));
  const proofs = readProofs(r, 0);
  return proofs.length > 0 ? { bindings, proofs } : { bindings };
}

function readEventBody(r: CoreReader): LedgerEvent {
  const kind = readCode(r, EVENT_CODE);
  const at = must(parseUnixSeconds(r.i64(), 'at'));
  switch (kind) {
    case 'REGISTER_POLICY':
      return { kind, at, policy: decodeEmbedded(r, decodePrincipalPolicy) };
    case 'REGISTER_GRANT':
      return { kind, at, grant: decodeEmbedded(r, decodeAuthorityGrant) };
    case 'REGISTER_POLICY_PROVEN': {
      const policy = decodeEmbedded(r, decodePrincipalPolicy);
      return { kind: 'REGISTER_POLICY', at, policy, proofs: readProofs(r) };
    }
    case 'REGISTER_GRANT_PROVEN': {
      const grant = decodeEmbedded(r, decodeAuthorityGrant);
      return { kind: 'REGISTER_GRANT', at, grant, proofs: readProofs(r) };
    }
    case 'REGISTER_POLICY_BOUND': {
      const policy = decodeEmbedded(r, decodePrincipalPolicy);
      return { kind: 'REGISTER_POLICY', at, policy, ...readBound(r) };
    }
    case 'REGISTER_GRANT_BOUND': {
      const grant = decodeEmbedded(r, decodeAuthorityGrant);
      return { kind: 'REGISTER_GRANT', at, grant, ...readBound(r) };
    }
    case 'REVOKE':
      return { kind, at, revocation: decodeEmbedded(r, decodeRevocation) };
    case 'RESERVE': {
      const planInput = readChargePlanInput(r);
      const plan = validateChargePlan(planInput);
      if (!plan.ok) throw new DecodeFailure(plan.error.code === 'MALFORMED' ? plan.error.core.code : 'ENCODING_MALFORMED');
      const lineage = r.list(MAX_LINEAGE_LENGTH, (x) => must(parseDigest<AuthorityId>(x.digest(), 'lineage')), false);
      const policy = must(parseDigest<PrincipalPolicyId>(r.digest(), 'policy'));
      const legs = r.list(plan.value.contributions.length, (x) => x.list(MAX_LEGS_PER_CONTRIBUTION, readLeg, false), false);
      return { kind, at, plan: plan.value, lineage, policy, legs };
    }
    case 'CONSUME':
    case 'CLOSE':
    case 'RESTORE': {
      const reservation = must(parseDigest<ReservationId>(r.digest(), 'reservation'));
      const generation = must(parseReservationGeneration(r.u64(), 'generation'));
      const evidence = must(parseNonZeroDigest<ObservationId>(r.digest(), 'evidence'));
      const amounts = r.list(MAX_PLAN_CONTRIBUTIONS, (x) => x.u256(), false);
      return { kind, at, reservation, generation, evidence, amounts };
    }
  }
}

export interface DecodedBatch {
  readonly principal: PrincipalId;
  readonly version: LedgerVersion;
  readonly previousHead: LedgerHeadDigest;
  readonly events: readonly LedgerEvent[];
}

/** Decode a stored batch. Structure only: whether it extends a ledger is the reducer's replay check. */
export function decodeBatch(bytes: Uint8Array): CoreResult<DecodedBatch> {
  if (!(bytes instanceof Uint8Array)) return fail('WRONG_TYPE', 'bytes');
  const r = new CoreReader(bytes);
  try {
    if (r.str() !== LedgerTag.LEDGER_BATCH) return fail('ENCODING_WRONG_TAG', 'bytes@0');
    if (r.u16() !== CORE_SCHEMA_VERSION) return fail('ENCODING_UNSUPPORTED_VERSION', `bytes@${r.offset - 2}`);
    const principal = must(validatePrincipalId(readPartyInput(r), 'principal'));
    const version = r.u64() as LedgerVersion;
    const previousHead = must(parseDigest<LedgerHeadDigest>(r.digest(), 'previousHead'));
    const events = r.list(MAX_BATCH_EVENTS, readEventBody, false);
    r.finish();
    return ok({ principal, version, previousHead, events });
  } catch (e) {
    if (e instanceof DecodeFailure) return fail(e.code, `bytes@${r.offset}`);
    throw e;
  }
}
