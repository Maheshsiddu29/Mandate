/**
 * Bounds on attacker-controlled cardinalities (architecture.md §8: every
 * collection bounded; action-state-model.md §8: a module is pure and total,
 * so its work must be bounded too).
 *
 * The principle is Core's: a bound is where a parser or evaluator refuses,
 * not where it truncates, and it is at least as generous as any honest input.
 * Where a Core or ledger bound already governs the same collection, it is
 * reused rather than re-chosen. The remaining values are 7D choices, sized
 * against the benchmark (`npm run control:benchmark`) so the worst case each
 * permits is still a bounded, measured cost; implementation-7d.md §15 records
 * the reasoning, and raising one is a schema decision.
 */

import { MAX_ACTION_PAYLOAD_BYTES, MAX_GRANT_TERMS, MAX_LINEAGE_LENGTH, MAX_POLICY_TERMS, MAX_STATE_BINDINGS } from '@mandate/core';
import { MAX_PLAN_CONTRIBUTIONS } from '@mandate/ledger';

/**
 * Admitted snapshots per authorization. An `ExecutionAuthorization` carries
 * at most `MAX_STATE_BINDINGS` bindings (Core), and every admitted snapshot
 * becomes one, so requirements across every participating module are bounded
 * by the same number.
 */
export const MAX_REQUIREMENTS = MAX_STATE_BINDINGS;

/** Snapshots a caller may supply. Extras are never admitted, but each costs a digest; twice the requirement bound. */
export const MAX_SUPPLIED_STATES = 2 * MAX_STATE_BINDINGS;

/** A supplied state payload is hashed and handed to one module to parse; the action payload's bound (Core) is reused. */
export const MAX_STATE_PAYLOAD_BYTES = MAX_ACTION_PAYLOAD_BYTES;

/**
 * Invariants evaluated for one action: every lineage node's and the policy's.
 * Core already bounds the maximum at `MAX_LINEAGE_LENGTH × MAX_GRANT_TERMS +
 * MAX_POLICY_TERMS` (1,152); this is that bound, stated, so a pathological
 * authority tree refuses by name instead of being silently expensive.
 */
export const MAX_INVARIANTS = MAX_LINEAGE_LENGTH * MAX_GRANT_TERMS + MAX_POLICY_TERMS;

/**
 * Unresolved reservations one decision projects. Projection is linear in
 * them (benchmark: 100 facts cost well under a millisecond), so the bound is
 * about refusing an unbounded principal rather than about speed. A principal
 * holding more open reservations than this is refused new authority —
 * liveness, never safety: an unconsidered reservation is never ignored.
 */
export const MAX_RESERVATION_FACTS = 4_096;

/** Modules consulted for one decision: the acting module, every invariant owner and every aggregate contributor. */
export const MAX_PARTICIPANTS = 32;

/** Economic facts one module projection may emit. */
export const MAX_PROJECTION_FACTS = 4 * MAX_RESERVATION_FACTS;

/** Module-owned invariant facts one projection may emit. */
export const MAX_INVARIANT_FACTS = 1_024;

/** Declared worst-case assumptions per projection. */
export const MAX_ASSUMPTIONS = 64;

/** A module's opaque projection payload. */
export const MAX_PROJECTION_PAYLOAD_BYTES = 1_048_576;

/** Ledger demands per action: exactly the ledger's contributions-per-plan bound. */
export const MAX_DEMANDS = MAX_PLAN_CONTRIBUTIONS;

/** Resources a projection or an action analysis may name (Core's per-action bound, plus the target). */
export const MAX_PROJECTION_RESOURCES = 1_024;

/** Configured sources, block heads and watermarks in one evaluation context. */
export const MAX_CONTEXT_ENTRIES = 4_096;

/** Levels on one declared finality ladder. */
export const MAX_FINALITY_LEVELS = 32;
