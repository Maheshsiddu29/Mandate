/**
 * Replay semantics: the consumption state machine.
 *
 * Deliberately separate from the verifier. `verify` is pure and reads replay
 * state as an explicit input; it never mutates anything. This module defines
 * the transitions a stateful caller applies, as pure functions over a record —
 * so the *rules* live in the kernel and are testable, while the *store* lives
 * outside it and can be a database, a chain, or a file.
 *
 * Full semantics, including what is deliberately deferred, are in
 * `docs/replay-semantics.md`.
 *
 * Summary:
 *
 * - The replay key is the mandate digest. Nothing else is keyed on.
 * - A mandate is single-use in Phase 1.
 * - Reserve before signing. Every outcome is then applied by one transition,
 *   `RECONCILE`, which requires a validated observation of what happened
 *   (ADR 0018). An attempt that neither settles nor is observed to fail leaves
 *   the mandate reserved until its reservation lapses, and a lapsed reservation
 *   quarantines rather than freeing the authorization.
 *
 * ## Totality at this boundary
 *
 * `applyTransition` is caller-facing and every field of its request is
 * caller-controlled. TypeScript's unions and brands are erased at run time
 * (ADR 0003), so a `ReplayTransition` or a `ReconciledOutcome` typed at a call
 * site is just a string in the running program — and a string from JSON is not
 * even that. So the request is *parsed* at run time before any branch is taken,
 * and every unrecognized value produces a typed error rather than falling through
 * a switch and returning `undefined` (finding N-4).
 *
 * The totality claim here is the same as the verifier's (V-2): it covers parsed,
 * plain values — what `JSON.parse` can produce, plus the kernel's own value types.
 * It is not a defence against a hostile host object whose property getters throw
 * or mutate, and it does not try to be.
 */

import { type Result, ok, err } from './result.ts';
import { parseBytes32, type Bytes32 } from './bytes.ts';
import { ReplayStatus } from './state.ts';
import { parseIdentifier, type Identifier } from './identifiers.ts';
import { parseUnixSeconds, type UnixSeconds } from './time.ts';
import type { CanonicalMandate } from './mandate.ts';
import { mandateDigest } from './encoding/digest.ts';

/**
 * The replay key is the mandate digest, and nothing else.
 *
 * The digest already covers the nonce, so two mandates that differ only in
 * nonce have different keys and are independently spendable — which is what the
 * nonce is for. Keying on the mandate id instead would let a principal reissue
 * the same id with different terms and reuse a spent authorization; keying on
 * the nonce alone would collide across principals.
 */
export function replayKey(mandate: CanonicalMandate): Bytes32 {
  return mandateDigest(mandate);
}

/**
 * What reconciliation established about an attempt.
 *
 * There is deliberately no `UNKNOWN` member. A reconciliation that could not
 * establish the outcome does not apply a transition at all — the record stays
 * where it is — because an enum member meaning "still don't know" would be a
 * place for a caller to pass its uncertainty off as a decision.
 *
 * Because the member list is erased at run time, `parseReconciledOutcome` below
 * is what actually enforces it (finding N-3).
 */
export const ReconciledOutcome = {
  SETTLED: 'SETTLED',
  FAILED: 'FAILED',
} as const;
export type ReconciledOutcome = (typeof ReconciledOutcome)[keyof typeof ReconciledOutcome];

/**
 * An observed execution outcome, with enough provenance to be auditable.
 *
 * This is the object that makes "only an observation restores an authorization"
 * more than a comment (finding N-5). Before Phase 5R.1, `RELEASE` was a bare
 * command: a caller that had observed nothing could restore permission by
 * asserting a transition, and the record kept no trace of what justified it.
 *
 * It is a *validated assertion*, not a proof. Verifying that `reference` really
 * settled or really failed needs chain observation, which is Phase 6. What this
 * shape buys now is that the assertion must be complete, well-formed, attributed
 * to a source and attached to a specific reference — and that it is recorded on
 * the resulting record, so an unsubstantiated restore is visible afterwards
 * rather than indistinguishable from a substantiated one.
 */
export interface ExecutionObservation {
  readonly outcome: ReconciledOutcome;
  /** When the outcome was observed. */
  readonly observedAtUnixSeconds: UnixSeconds;
  /** Who observed it. Belongs to the trusted computing base alongside the store. */
  readonly sourceId: Identifier;
  /** What was observed: the transaction or settlement reference the outcome is about. */
  readonly reference: Bytes32;
}

export const ReplayTransition = {
  /** Taken after a PASS and before anything is signed. */
  RESERVE: 'RESERVE',
  /**
   * Taken when a reservation has passed its own expiry without resolving.
   *
   * Moves the record to `QUARANTINED`, which the verifier refuses. It marks the
   * authorization as needing reconciliation; it does not decide what happened.
   */
  QUARANTINE: 'QUARANTINE',
  /**
   * The only transition that applies an outcome, and the only one that can leave
   * `RESERVED` or `QUARANTINED`.
   *
   * It requires a validated `ExecutionObservation`: `SETTLED` consumes the
   * authorization, `FAILED` returns it to `UNUSED`. Nothing else can do either.
   */
  RECONCILE: 'RECONCILE',
} as const;
export type ReplayTransition = (typeof ReplayTransition)[keyof typeof ReplayTransition];

/**
 * Transition names this kernel once had and no longer accepts.
 *
 * Kept as data so the refusal is a named, tested behaviour rather than an
 * accident of a switch statement, and so an integrator upgrading across the
 * change gets `UNKNOWN_TRANSITION` from a total function instead of `undefined`
 * from a partial one.
 *
 * - `RECLAIM` returned a lapsed reservation to `UNUSED` on a timer, which is what
 *   finding F-1 was ([ADR 0015](../../../docs/adr/0015-replay-quarantine-and-reconciliation.md)).
 * - `COMMIT` and `RELEASE` asserted settlement and failure with no observation
 *   behind them, and `RELEASE` in particular restored permission on a bare
 *   command (finding N-5). Both are now `RECONCILE` carrying an observation
 *   ([ADR 0018](../../../docs/adr/0018-observed-execution-outcomes.md)).
 */
export const RETIRED_REPLAY_TRANSITIONS: readonly string[] = ['RECLAIM', 'COMMIT', 'RELEASE'];

export const ReplayError = {
  /** The record itself is not well-formed: a bad key, status or timestamp. */
  MALFORMED_RECORD: 'MALFORMED_RECORD',
  /** The transition is not a member of the vocabulary — including a retired one. */
  UNKNOWN_TRANSITION: 'UNKNOWN_TRANSITION',
  /** The record's status could not be established, so nothing may be asserted over it. */
  UNKNOWN_STATE: 'UNKNOWN_STATE',
  NOT_RESERVABLE: 'NOT_RESERVABLE',
  /** A transition valid only from a live reservation was applied elsewhere. */
  NOT_RESERVED: 'NOT_RESERVED',
  /** `RECONCILE` was applied to a record with no attempt to reconcile. */
  NOT_RESOLVABLE: 'NOT_RESOLVABLE',
  ALREADY_CONSUMED: 'ALREADY_CONSUMED',
  RESERVATION_NOT_EXPIRED: 'RESERVATION_NOT_EXPIRED',
  /** `RECONCILE` was applied without stating what was observed. */
  OBSERVATION_REQUIRED: 'OBSERVATION_REQUIRED',
  /** The observation is present but not well-formed, including an unrecognized outcome. */
  OBSERVATION_INVALID: 'OBSERVATION_INVALID',
} as const;
export type ReplayError = (typeof ReplayError)[keyof typeof ReplayError];

export interface ReplayRecord {
  readonly key: Bytes32;
  readonly status: ReplayStatus;
  /** When the current status was entered. */
  readonly updatedAtUnixSeconds: UnixSeconds;
  /** Set when RESERVED: the instant after which the reservation may be reclaimed. */
  readonly reservationExpiresAtUnixSeconds: UnixSeconds | null;
  /**
   * The observation that moved this record to a resolved status, or null.
   *
   * Non-null exactly on records that `RECONCILE` produced. A `CONSUMED` or
   * `UNUSED` record carrying null was never resolved by an observation — it is a
   * starting state or a spend recorded before this field existed — and that is
   * the distinction an auditor needs in order to tell a substantiated restore
   * from an asserted one.
   */
  readonly resolution: ExecutionObservation | null;
}

export function unusedRecord(key: Bytes32, at: UnixSeconds): ReplayRecord {
  return {
    key,
    status: ReplayStatus.UNUSED,
    updatedAtUnixSeconds: at,
    reservationExpiresAtUnixSeconds: null,
    resolution: null,
  };
}

export interface TransitionRequest {
  readonly current: ReplayRecord;
  /**
   * Taken as `unknown` on purpose: this is the value the finding was about. A
   * typed parameter documents intent and enforces nothing at run time, so it is
   * parsed below and an unrecognized name is `UNKNOWN_TRANSITION`.
   */
  readonly transition: ReplayTransition | unknown;
  readonly nowUnixSeconds: UnixSeconds;
  /**
   * Required for RESERVE. The caller sets how long the reservation holds; it
   * should not outlive the mandate's own expiry, and `applyTransition` clamps
   * it to `mandateExpiresAtUnixSeconds`.
   */
  readonly reservationSeconds?: bigint;
  readonly mandateExpiresAtUnixSeconds?: UnixSeconds;
  /**
   * Required for RECONCILE, and meaningless for every other transition.
   *
   * `unknown` for the same reason as `transition`: the outcome inside it arrives
   * from a runtime source and is validated, never trusted for having a type.
   */
  readonly observation?: unknown;
}

/** Recognize a transition name at run time. Anything else, including a retired name, fails. */
export function parseReplayTransition(raw: unknown): Result<ReplayTransition, ReplayError> {
  if (typeof raw !== 'string') return err(ReplayError.UNKNOWN_TRANSITION);
  if (!Object.prototype.hasOwnProperty.call(ReplayTransition, raw)) return err(ReplayError.UNKNOWN_TRANSITION);
  return ok(ReplayTransition[raw as keyof typeof ReplayTransition]);
}

/**
 * Recognize a reconciliation outcome at run time (finding N-3).
 *
 * `SETTLED` and `FAILED` are the only accepted values, matched exactly. There is
 * no branch here in which an unrecognized value becomes `FAILED`: before Phase
 * 5R.1 the caller's value was compared against `SETTLED` and *everything else*
 * fell through to the restore path, so `'settled'`, `'UNKNOWN'`, `0`, `''`, `{}`
 * and `undefined` all returned the authorization to `UNUSED`.
 */
export function parseReconciledOutcome(raw: unknown): Result<ReconciledOutcome, ReplayError> {
  if (typeof raw !== 'string') return err(ReplayError.OBSERVATION_INVALID);
  if (!Object.prototype.hasOwnProperty.call(ReconciledOutcome, raw)) return err(ReplayError.OBSERVATION_INVALID);
  return ok(ReconciledOutcome[raw as keyof typeof ReconciledOutcome]);
}

/** Parse an observed execution outcome. Every field is required; nothing is defaulted. */
export function parseExecutionObservation(raw: unknown): Result<ExecutionObservation, ReplayError> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return err(ReplayError.OBSERVATION_INVALID);
  const r = raw as Record<string, unknown>;
  const known = new Set(['outcome', 'observedAtUnixSeconds', 'sourceId', 'reference']);
  for (const key of Object.keys(r)) if (!known.has(key)) return err(ReplayError.OBSERVATION_INVALID);
  const outcome = parseReconciledOutcome(r['outcome']);
  if (!outcome.ok) return outcome;
  const observedAt = parseUnixSeconds(r['observedAtUnixSeconds'], 'MALFORMED_TRUSTED_STATE');
  if (!observedAt.ok) return err(ReplayError.OBSERVATION_INVALID);
  const sourceId = parseIdentifier(r['sourceId']);
  if (!sourceId.ok) return err(ReplayError.OBSERVATION_INVALID);
  const reference = parseBytes32(r['reference'], 'MALFORMED_TRUSTED_STATE');
  if (!reference.ok) return err(ReplayError.OBSERVATION_INVALID);
  return ok({
    outcome: outcome.value,
    observedAtUnixSeconds: observedAt.value,
    sourceId: sourceId.value,
    reference: reference.value,
  });
}

/** Validate the stored record before anything is asserted over it. */
function parseReplayRecord(raw: ReplayRecord): Result<ReplayRecord, ReplayError> {
  if (typeof raw !== 'object' || raw === null) return err(ReplayError.MALFORMED_RECORD);
  const key = parseBytes32(raw.key, 'MALFORMED_TRUSTED_STATE');
  if (!key.ok) return err(ReplayError.MALFORMED_RECORD);
  if (typeof raw.status !== 'string' || !Object.prototype.hasOwnProperty.call(ReplayStatus, raw.status)) {
    return err(ReplayError.MALFORMED_RECORD);
  }
  if (typeof raw.updatedAtUnixSeconds !== 'bigint') return err(ReplayError.MALFORMED_RECORD);
  const expiry = raw.reservationExpiresAtUnixSeconds;
  if (expiry !== null && typeof expiry !== 'bigint') return err(ReplayError.MALFORMED_RECORD);
  return ok(raw);
}

/**
 * Pure state transition. The caller persists the result; this function stores
 * nothing and reads no clock.
 *
 * Total over plain values: every caller-controlled field is parsed before a
 * branch is taken, and the switch over the parsed transition is exhaustive, so
 * adding a future member is a compile error rather than a silent fall-through
 * that returns `undefined`.
 */
export function applyTransition(request: TransitionRequest): Result<ReplayRecord, ReplayError> {
  const parsedTransition = parseReplayTransition(request.transition);
  if (!parsedTransition.ok) return parsedTransition;
  const transition = parsedTransition.value;

  const parsedRecord = parseReplayRecord(request.current);
  if (!parsedRecord.ok) return parsedRecord;
  const current = parsedRecord.value;

  if (typeof request.nowUnixSeconds !== 'bigint') return err(ReplayError.MALFORMED_RECORD);
  const now = request.nowUnixSeconds;

  if (current.status === ReplayStatus.UNKNOWN) {
    // An unknown record cannot be transitioned into a known one by asserting a
    // transition over it. It has to be established first.
    return err(ReplayError.UNKNOWN_STATE);
  }

  // Consumption is terminal, under every transition, checked once rather than in
  // each case so no future case can forget it.
  if (current.status === ReplayStatus.CONSUMED) return err(ReplayError.ALREADY_CONSUMED);

  switch (transition) {
    case ReplayTransition.RESERVE: {
      if (current.status !== ReplayStatus.UNUSED) {
        // A reservation is held, or the record is quarantined and its outcome is
        // unestablished. Either way a second attempt must not take it.
        return err(ReplayError.NOT_RESERVABLE);
      }
      const hold = request.reservationSeconds;
      if (typeof hold !== 'bigint' || hold <= 0n) return err(ReplayError.NOT_RESERVABLE);
      let expiresAt = now + hold;
      const mandateExpiry = request.mandateExpiresAtUnixSeconds;
      if (mandateExpiry !== undefined && typeof mandateExpiry !== 'bigint') return err(ReplayError.MALFORMED_RECORD);
      // A reservation outliving the mandate would keep an already-dead
      // authorization locked for no benefit.
      if (mandateExpiry !== undefined && expiresAt > mandateExpiry) expiresAt = mandateExpiry;
      return ok({
        key: current.key,
        status: ReplayStatus.RESERVED,
        updatedAtUnixSeconds: now,
        reservationExpiresAtUnixSeconds: expiresAt,
        resolution: null,
      });
    }

    case ReplayTransition.QUARANTINE: {
      if (current.status !== ReplayStatus.RESERVED) return err(ReplayError.NOT_RESERVED);
      const expiry = current.reservationExpiresAtUnixSeconds;
      if (expiry === null || now < expiry) return err(ReplayError.RESERVATION_NOT_EXPIRED);
      // Quarantine, never UNUSED. The reservation expiring says the attempt
      // stopped reporting, not that it failed.
      return ok({
        key: current.key,
        status: ReplayStatus.QUARANTINED,
        updatedAtUnixSeconds: now,
        reservationExpiresAtUnixSeconds: null,
        resolution: null,
      });
    }

    case ReplayTransition.RECONCILE: {
      if (current.status !== ReplayStatus.RESERVED && current.status !== ReplayStatus.QUARANTINED) {
        // Nothing is in flight, so there is no outcome to apply. Reconciling an
        // UNUSED record would consume or re-permit an authorization no attempt
        // ever held.
        return err(ReplayError.NOT_RESOLVABLE);
      }
      if (request.observation === undefined || request.observation === null) {
        return err(ReplayError.OBSERVATION_REQUIRED);
      }
      const observation = parseExecutionObservation(request.observation);
      if (!observation.ok) return observation;
      const resolved = observation.value;
      if (resolved.outcome === ReconciledOutcome.SETTLED) {
        return ok({
          key: current.key,
          status: ReplayStatus.CONSUMED,
          updatedAtUnixSeconds: now,
          reservationExpiresAtUnixSeconds: null,
          resolution: resolved,
        });
      }
      // FAILED, and only FAILED, restores the authorization — carrying the
      // observation that justified it onto the record.
      return ok({
        key: current.key,
        status: ReplayStatus.UNUSED,
        updatedAtUnixSeconds: now,
        reservationExpiresAtUnixSeconds: null,
        resolution: resolved,
      });
    }

    default: {
      // Unreachable: `transition` is the parsed union and every member has a case
      // above. Present so that adding a member without a case fails to compile
      // rather than falling out of the switch as `undefined`.
      const exhaustive: never = transition;
      void exhaustive;
      return err(ReplayError.UNKNOWN_TRANSITION);
    }
  }
}

/**
 * Whether an authorization is available for a fresh attempt.
 *
 * `QUARANTINED` is unavailable, and that is the whole point of it: the only
 * statuses that permit a new attempt are the ones whose outcome is known.
 */
export function isAvailable(record: ReplayRecord): boolean {
  return record.status === ReplayStatus.UNUSED;
}
