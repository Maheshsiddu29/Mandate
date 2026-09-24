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
 * - Reserve before signing, commit after settlement is observed, release only
 *   when failure is observed. An attempt that neither commits nor releases
 *   leaves the mandate reserved until its expiry, which fails closed.
 */

import { type Result, ok, err } from './result.ts';
import type { Bytes32 } from './bytes.ts';
import { ReplayStatus } from './state.ts';
import type { UnixSeconds } from './time.ts';
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

export interface ReplayRecord {
  readonly key: Bytes32;
  readonly status: ReplayStatus;
  /** When the current status was entered. */
  readonly updatedAtUnixSeconds: UnixSeconds;
  /** Set when RESERVED: the instant after which the reservation may be reclaimed. */
  readonly reservationExpiresAtUnixSeconds: UnixSeconds | null;
}

export const ReplayTransition = {
  /** Taken after a PASS and before anything is signed. */
  RESERVE: 'RESERVE',
  /** Taken when settlement is observed. Terminal. */
  COMMIT: 'COMMIT',
  /** Taken only when failure is observed. Returns the mandate to UNUSED. */
  RELEASE: 'RELEASE',
  /** Taken when a reservation has passed its own expiry without resolving. */
  RECLAIM: 'RECLAIM',
} as const;
export type ReplayTransition = (typeof ReplayTransition)[keyof typeof ReplayTransition];

export const ReplayError = {
  NOT_RESERVABLE: 'NOT_RESERVABLE',
  NOT_RESERVED: 'NOT_RESERVED',
  ALREADY_CONSUMED: 'ALREADY_CONSUMED',
  UNKNOWN_STATE: 'UNKNOWN_STATE',
  RESERVATION_NOT_EXPIRED: 'RESERVATION_NOT_EXPIRED',
  KEY_MISMATCH: 'KEY_MISMATCH',
} as const;
export type ReplayError = (typeof ReplayError)[keyof typeof ReplayError];

export function unusedRecord(key: Bytes32, at: UnixSeconds): ReplayRecord {
  return { key, status: ReplayStatus.UNUSED, updatedAtUnixSeconds: at, reservationExpiresAtUnixSeconds: null };
}

export interface TransitionRequest {
  readonly current: ReplayRecord;
  readonly transition: ReplayTransition;
  readonly nowUnixSeconds: UnixSeconds;
  /**
   * Required for RESERVE. The caller sets how long the reservation holds; it
   * should not outlive the mandate's own expiry, and `applyTransition` clamps
   * it to `mandateExpiresAtUnixSeconds`.
   */
  readonly reservationSeconds?: bigint;
  readonly mandateExpiresAtUnixSeconds?: UnixSeconds;
}

/**
 * Pure state transition. The caller persists the result; this function stores
 * nothing and reads no clock.
 */
export function applyTransition(request: TransitionRequest): Result<ReplayRecord, ReplayError> {
  const { current, transition, nowUnixSeconds: now } = request;

  if (current.status === ReplayStatus.UNKNOWN) {
    // An unknown record cannot be transitioned into a known one by asserting a
    // transition over it. It has to be established first.
    return err(ReplayError.UNKNOWN_STATE);
  }

  switch (transition) {
    case ReplayTransition.RESERVE: {
      if (current.status === ReplayStatus.CONSUMED) return err(ReplayError.ALREADY_CONSUMED);
      if (current.status === ReplayStatus.RESERVED) return err(ReplayError.NOT_RESERVABLE);
      const hold = request.reservationSeconds ?? 0n;
      if (hold <= 0n) return err(ReplayError.NOT_RESERVABLE);
      let expiresAt = now + hold;
      const mandateExpiry = request.mandateExpiresAtUnixSeconds;
      // A reservation outliving the mandate would keep an already-dead
      // authorization locked for no benefit.
      if (mandateExpiry !== undefined && expiresAt > mandateExpiry) expiresAt = mandateExpiry;
      return ok({
        key: current.key,
        status: ReplayStatus.RESERVED,
        updatedAtUnixSeconds: now,
        reservationExpiresAtUnixSeconds: expiresAt,
      });
    }

    case ReplayTransition.COMMIT: {
      if (current.status === ReplayStatus.CONSUMED) return err(ReplayError.ALREADY_CONSUMED);
      // Commit only from a reservation this caller took. Committing straight
      // from UNUSED would mean consuming an authorization no attempt held.
      if (current.status !== ReplayStatus.RESERVED) return err(ReplayError.NOT_RESERVED);
      return ok({
        key: current.key,
        status: ReplayStatus.CONSUMED,
        updatedAtUnixSeconds: now,
        reservationExpiresAtUnixSeconds: null,
      });
    }

    case ReplayTransition.RELEASE: {
      if (current.status === ReplayStatus.CONSUMED) return err(ReplayError.ALREADY_CONSUMED);
      if (current.status !== ReplayStatus.RESERVED) return err(ReplayError.NOT_RESERVED);
      return ok(unusedRecord(current.key, now));
    }

    case ReplayTransition.RECLAIM: {
      if (current.status !== ReplayStatus.RESERVED) return err(ReplayError.NOT_RESERVED);
      const expiry = current.reservationExpiresAtUnixSeconds;
      if (expiry === null || now < expiry) return err(ReplayError.RESERVATION_NOT_EXPIRED);
      return ok(unusedRecord(current.key, now));
    }
  }
}
