/**
 * Ledger bounds (architecture.md §8: every collection bounded at parse, at
 * the width of the count its encoder writes).
 *
 * Lineage depth is Core's `MAX_LINEAGE_LENGTH` (8) and terms per grant or
 * policy are Core's `MAX_GRANT_TERMS` / `MAX_POLICY_TERMS` (128); the ledger
 * reuses them and adds only what it introduces. The frozen specification
 * fixes none of the values below. They are 7C schema constants chosen to be
 * generous for any real action, well inside the `u16` counts the encoder
 * writes, and measured by `npm run ledger:benchmark`; raising one is a schema
 * change, recorded as an open question in implementation-7c.md.
 */

import { MAX_GRANT_TERMS, MAX_LINEAGE_LENGTH, MAX_POLICY_TERMS } from '@mandate/core';

/** Typed contributions one charge plan may carry (as many as an action may name resources). */
export const MAX_PLAN_CONTRIBUTIONS = 64;

/** Events in one atomic batch. */
export const MAX_BATCH_EVENTS = 256;

/** An embedded canonical object (grant, policy, revocation) inside an event. Bounds hostile decode work. */
export const MAX_EMBEDDED_BYTES = 4_194_304;

/** Upper bound on a caller's bounded retry policy: the engine never loops unboundedly on CAS conflicts. */
export const MAX_COMMIT_ATTEMPTS = 32;

/**
 * Legs one contribution can have: at most every dimension of every lineage
 * node and of the policy. Derived from Core's bounds, not chosen.
 */
export const MAX_LEGS_PER_CONTRIBUTION = MAX_LINEAGE_LENGTH * MAX_GRANT_TERMS + MAX_POLICY_TERMS;
