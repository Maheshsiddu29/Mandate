/**
 * Issuance attempts: the `ADMIT_ATTEMPT` transition (reservations-reconciliation.md
 * §4, §10a; implementation-7d.md §22.6; Phase 7E.1).
 *
 * An attempt is the ledger's durable statement that an enforcement adapter
 * may now create **one exact external artifact** for one reservation
 * generation. It is committed *before* any signing key is used, so after a
 * crash the ledger still knows an artifact may exist, and `NEVER_ISSUED` can
 * no longer close the generation (7D.1 R5).
 *
 * The ledger stays venue-independent. What it records about the artifact is
 * opaque, typed identity chosen by the adapter:
 *
 * - `artifact` — the exact artifact's own identity (for a venue that hashes an
 *   unsigned transaction before signing, that hash): a kind identifier and
 *   1–64 raw bytes. It is unique across the principal's whole history.
 * - `slot` — the venue's replay slot, if it has one (a nonce per signer key):
 *   a scope identifier and a sequence number. At most one attempt ever binds
 *   a slot, so the ledger never authorizes two different artifacts for one
 *   slot (REPLAY-1, execution half).
 *
 * The attempt id is derived, never trusted: `H(tag, reservation, generation,
 * action, module, adapter, authorization, ordinal)`. The reducer recomputes
 * it, as it re-derives a `RESERVE` event's legs.
 *
 * **One live attempt per reservation.** An admitted attempt stays live until
 * its outcome is established by evidence — reconciliation, which is 7F. So in
 * 7E a second `ADMIT_ATTEMPT` for the same reservation is always refused
 * (`ATTEMPT_UNRESOLVED`); time never frees it (TIME-1).
 *
 * ```text
 * ADMIT_ATTEMPT  u8(12) ‖ i64(at) ‖ bytes32(attempt) ‖ u16(ordinal) ‖ bytes32(reservation) ‖ u64(generation)
 *                ‖ bytes32(action) ‖ bytes32(authorization) ‖ ModuleRef ‖ AdapterRef ‖ ResourceId(venueAccount)
 *                ‖ str(artifact.kind) ‖ u8(n) ‖ artifact.id[n] ‖ nullable(str(slot.scope) ‖ u64(slot.sequence))
 *                ‖ i64(validUntil) ‖ bytes32(requirements) ‖ bytes32(revalidation)
 * ```
 */

import { ok, type ByteWriter, type Identifier } from '@mandate/kernel';
import {
  CoreReader,
  DecodeFailure,
  moduleRefsEqual,
  parseDigest,
  parseIdentifierAs,
  parseNonZeroDigest,
  parseReservationGeneration,
  parseUnixSeconds,
  readAdapterRefInput,
  readModuleRefInput,
  readNullable,
  readResourceIdInput,
  validateAdapterRef,
  validateModuleRef,
  validateResourceId,
  writeAdapterRef,
  writeDigest,
  writeModuleRef,
  writeNullable,
  writeResourceId,
  type AccountId,
  type ActionId,
  type AdapterRef,
  type CoreResult,
  type Digest32,
  type ExecutionAuthorizationId,
  type LedgerVersion,
  type ModuleRef,
  type ReservationGeneration,
  type ReservationId,
  type Tagged,
} from '@mandate/core';
import { LedgerTag, ledgerDigest, ledgerWriter } from './encoding.ts';
import { refuse, type LedgerResult } from './errors.ts';
import { checkLineageValid, resolveLineage } from './graph.ts';
import type { LedgerState } from './state.ts';

export type AttemptId = Tagged<Digest32, 'AttemptId'>;

/** The largest artifact identity the ledger records, in bytes. */
export const MAX_ARTIFACT_ID_BYTES = 64;
/** Attempts per reservation. In 7E only the first can ever be admitted; the bound is for 7F retries. */
export const MAX_ATTEMPTS_PER_RESERVATION = 16;

export interface ArtifactIdentity {
  /** What kind of identity `id` is, in the adapter's vocabulary (e.g. an L2 transaction hash). */
  readonly kind: Identifier;
  /** 1–64 bytes. */
  readonly id: Uint8Array;
}

export interface VenueSlot {
  /** The replay domain: e.g. one signer key on one venue account. */
  readonly scope: Identifier;
  /** The position in it: e.g. the nonce. */
  readonly sequence: bigint;
}

export interface AttemptAdmission {
  readonly attempt: AttemptId;
  /** 1 for the first attempt of a reservation. */
  readonly ordinal: number;
  readonly reservation: ReservationId;
  readonly generation: ReservationGeneration;
  readonly action: ActionId;
  /** Core's `ExecutionAuthorization` the attempt is issued under. */
  readonly authorization: ExecutionAuthorizationId;
  readonly module: ModuleRef;
  readonly adapter: AdapterRef;
  readonly venueAccount: AccountId;
  readonly artifact: ArtifactIdentity;
  readonly slot: VenueSlot | null;
  /** No artifact of this attempt may be valid at or after this instant (EXEC-3). */
  readonly validUntil: bigint;
  /** Digest of the ordered pre-execution results the attempt was admitted on. */
  readonly requirements: Digest32;
  /** The revalidation the attempt was admitted on. */
  readonly revalidation: Digest32;
}

export type AttemptStatus = 'ADMITTED';

export interface AttemptRecord extends AttemptAdmission {
  readonly admittedAt: LedgerVersion;
  readonly admittedTime: bigint;
  /** 7E: every admitted attempt is live until evidence resolves it (7F). */
  readonly status: AttemptStatus;
}

// --- Identity ----------------------------------------------------------------------

export interface AttemptIdInput {
  readonly reservation: ReservationId;
  readonly generation: ReservationGeneration;
  readonly action: ActionId;
  readonly module: ModuleRef;
  readonly adapter: AdapterRef;
  readonly authorization: ExecutionAuthorizationId;
  readonly ordinal: number;
}

export function attemptIdFor(a: AttemptIdInput): AttemptId {
  const w = ledgerWriter(LedgerTag.ATTEMPT);
  writeDigest(w, a.reservation);
  w.u64(a.generation);
  writeDigest(w, a.action);
  writeModuleRef(w, a.module);
  writeAdapterRef(w, a.adapter);
  writeDigest(w, a.authorization);
  w.u16(a.ordinal);
  return ledgerDigest<AttemptId>(w);
}

export function artifactKey(a: ArtifactIdentity): string {
  let hex = '';
  for (const b of a.id) hex += b.toString(16).padStart(2, '0');
  return JSON.stringify([a.kind, hex]);
}

export function slotKey(s: VenueSlot): string {
  return JSON.stringify([s.scope, s.sequence.toString()]);
}

// --- Codec ---------------------------------------------------------------------------

export function writeAttemptAdmission(w: ByteWriter, a: AttemptAdmission): void {
  writeDigest(w, a.attempt);
  w.u16(a.ordinal);
  writeDigest(w, a.reservation);
  w.u64(a.generation);
  writeDigest(w, a.action);
  writeDigest(w, a.authorization);
  writeModuleRef(w, a.module);
  writeAdapterRef(w, a.adapter);
  writeResourceId(w, a.venueAccount);
  w.str(a.artifact.kind).u8(a.artifact.id.length);
  for (const b of a.artifact.id) w.u8(b);
  writeNullable(w, a.slot, (x, s) => x.str(s.scope).u64(s.sequence));
  w.i64(a.validUntil);
  writeDigest(w, a.requirements);
  writeDigest(w, a.revalidation);
}

function must<T>(v: CoreResult<T>): T {
  if (!v.ok) throw new DecodeFailure(v.error.code);
  return v.value;
}

export function readAttemptAdmission(r: CoreReader): AttemptAdmission {
  const attempt = must(parseNonZeroDigest<AttemptId>(r.digest(), 'attempt'));
  const ordinal = r.u16();
  const reservation = must(parseDigest<ReservationId>(r.digest(), 'reservation'));
  const generation = must(parseReservationGeneration(r.u64(), 'generation'));
  const action = must(parseDigest<ActionId>(r.digest(), 'action'));
  const authorization = must(parseNonZeroDigest<ExecutionAuthorizationId>(r.digest(), 'authorization'));
  const module = must(validateModuleRef(readModuleRefInput(r), 'module'));
  const adapter = must(validateAdapterRef(readAdapterRefInput(r), 'adapter'));
  const venueAccount = must(validateResourceId(readResourceIdInput(r), ['ACCOUNT'] as const, 'venueAccount'));
  const kind = must(parseIdentifierAs<Identifier>(r.str(), 'artifact.kind'));
  const n = r.u8();
  const id = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) id[i] = r.u8();
  const slot = readNullable(r, (x) => ({ scope: must(parseIdentifierAs<Identifier>(x.str(), 'slot.scope')), sequence: x.u64() }));
  const validUntil = must(parseUnixSeconds(r.i64(), 'validUntil'));
  const requirements = must(parseNonZeroDigest<Digest32>(r.digest(), 'requirements'));
  const revalidation = must(parseNonZeroDigest<Digest32>(r.digest(), 'revalidation'));
  const admission: AttemptAdmission = { attempt, ordinal, reservation, generation, action, authorization, module, adapter, venueAccount, artifact: { kind, id }, slot, validUntil, requirements, revalidation };
  const shape = checkAdmissionShape(admission, 'admission');
  if (!shape.ok) throw new DecodeFailure('ENCODING_MALFORMED');
  return admission;
}

/** Structural rules every admission obeys, whatever the state. */
export function checkAdmissionShape(a: AttemptAdmission, path: string): LedgerResult<true> {
  if (!Number.isSafeInteger(a.ordinal) || a.ordinal < 1 || a.ordinal > MAX_ATTEMPTS_PER_RESERVATION) return refuse('ATTEMPT_SHAPE_INVALID', `${path}.ordinal`);
  if (!(a.artifact.id instanceof Uint8Array) || a.artifact.id.length === 0 || a.artifact.id.length > MAX_ARTIFACT_ID_BYTES) return refuse('ATTEMPT_SHAPE_INVALID', `${path}.artifact.id`);
  if (a.slot !== null && (a.slot.sequence < 0n || a.slot.sequence > 0xffff_ffff_ffff_ffffn)) return refuse('ATTEMPT_SHAPE_INVALID', `${path}.slot.sequence`);
  // Everything committed must decode again at replay: identifiers and the account are re-validated here, not trusted.
  if (!parseIdentifierAs<Identifier>(a.artifact.kind, 'kind').ok) return refuse('ATTEMPT_SHAPE_INVALID', `${path}.artifact.kind`);
  if (a.slot !== null && !parseIdentifierAs<Identifier>(a.slot.scope, 'scope').ok) return refuse('ATTEMPT_SHAPE_INVALID', `${path}.slot.scope`);
  const account = validateResourceId({ domain: a.venueAccount.domain, kind: a.venueAccount.kind, localId: a.venueAccount.localId }, ['ACCOUNT'] as const, 'venueAccount');
  if (!account.ok) return refuse('ATTEMPT_SHAPE_INVALID', `${path}.venueAccount`);
  if (typeof a.validUntil !== 'bigint' || !parseUnixSeconds(a.validUntil, 'validUntil').ok) return refuse('ATTEMPT_SHAPE_INVALID', `${path}.validUntil`);
  return ok(true);
}

// --- The transition ------------------------------------------------------------------

/**
 * `ADMIT_ATTEMPT` against `s` at time `at`, committed at `version`. Pure.
 * What it requires of the ledger (the adapter and the control engine check
 * the rest — revalidation, pre-execution requirements, module and adapter
 * status — before proposing it):
 *
 * 1. the reservation exists, is `ACTIVE`, and the admission restates exactly
 *    its generation, action and module;
 * 2. the attempt id is the derived one, for the next ordinal;
 * 3. no attempt of this reservation is live;
 * 4. neither the artifact identity nor the venue slot was ever bound before;
 * 5. the artifact expires after `at`;
 * 6. the lineage is still valid at `at` — not revoked, not expired.
 */
export function applyAdmitAttempt(s: LedgerState, a: AttemptAdmission, at: bigint, version: LedgerVersion): LedgerResult<LedgerState> {
  const shape = checkAdmissionShape(a, 'admission');
  if (!shape.ok) return shape;
  const r = s.reservations.get(a.reservation);
  if (r === undefined) return refuse('RESERVATION_UNKNOWN', 'admission.reservation');
  if (r.generation !== a.generation) return refuse('RESERVATION_ID_MISMATCH', 'admission.generation');
  if (r.action !== a.action) return refuse('ATTEMPT_BINDING_MISMATCH', 'admission.action');
  if (!moduleRefsEqual(r.module, a.module)) return refuse('ATTEMPT_BINDING_MISMATCH', 'admission.module');
  if (r.status !== 'ACTIVE') return refuse('RESERVATION_CLOSED', 'admission.reservation');

  const prior = s.reservationAttempts.get(a.reservation) ?? [];
  if (prior.some((id) => (s.attempts.get(id) as AttemptRecord).status === 'ADMITTED')) return refuse('ATTEMPT_UNRESOLVED', 'admission.reservation');
  if (a.ordinal !== prior.length + 1) return refuse('ATTEMPT_ID_MISMATCH', 'admission.ordinal');
  const derived = attemptIdFor(a);
  if (derived !== a.attempt) return refuse('ATTEMPT_ID_MISMATCH', 'admission.attempt');
  if (s.attempts.has(a.attempt)) return refuse('ATTEMPT_ID_MISMATCH', 'admission.attempt');

  const aKey = artifactKey(a.artifact);
  if (s.attemptArtifacts.has(aKey)) return refuse('ARTIFACT_REUSED', 'admission.artifact');
  const sKey = a.slot === null ? null : slotKey(a.slot);
  if (sKey !== null && s.attemptSlots.has(sKey)) return refuse('VENUE_SLOT_REUSED', 'admission.slot');
  if (a.validUntil <= at) return refuse('ATTEMPT_EXPIRED', 'admission.validUntil');

  const lineage = resolveLineage(s, r.authority, 'admission.lineage');
  if (!lineage.ok) return lineage;
  const valid = checkLineageValid(s, lineage.value, at, 'admission.lineage');
  if (!valid.ok) return valid;

  const record: AttemptRecord = { ...a, artifact: { kind: a.artifact.kind, id: new Uint8Array(a.artifact.id) }, admittedAt: version, admittedTime: at, status: 'ADMITTED' };
  return ok({
    ...s,
    attempts: s.attempts.set(a.attempt, record),
    attemptArtifacts: s.attemptArtifacts.set(aKey, a.attempt),
    attemptSlots: sKey === null ? s.attemptSlots : s.attemptSlots.set(sKey, a.attempt),
    reservationAttempts: s.reservationAttempts.set(a.reservation, [...prior, a.attempt]),
  });
}

/** The attempts ever admitted for a reservation, in order. */
export function attemptsOf(s: LedgerState, reservation: ReservationId): readonly AttemptRecord[] {
  return (s.reservationAttempts.get(reservation) ?? []).map((id) => s.attempts.get(id) as AttemptRecord);
}

/** Whether any attempt was ever admitted for a reservation — the fact that forbids `NEVER_ISSUED`. */
export function anyAttemptAdmitted(s: LedgerState, reservation: ReservationId): boolean {
  return (s.reservationAttempts.get(reservation)?.length ?? 0) > 0;
}
