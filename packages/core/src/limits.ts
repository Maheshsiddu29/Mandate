/**
 * Collection bounds and Core constants (architecture.md §8: "Every Core
 * collection has a declared bound enforced at parse, at the encoder's count
 * width").
 *
 * Every list is written with a `u16` count, and every bound below is at most
 * `u16` maximum, so no parser accepts more than its encoder can represent.
 * The values are 7B choices, recorded in ADR 0020; raising one is a schema
 * change, not a configuration change.
 */

/**
 * Maximum `DELEGATE` depth a grant may carry (authority-model.md §5 rule 7:
 * "the total depth is also bounded by a Core constant fixed in 7B"). A lineage
 * therefore has at most `MAX_DELEGATION_DEPTH + 1` nodes.
 */
export const MAX_DELEGATION_DEPTH = 7;
export const MAX_LINEAGE_LENGTH = MAX_DELEGATION_DEPTH + 1;

export const MAX_GRANT_TERMS = 128;
export const MAX_POLICY_TERMS = 128;
export const MAX_SET_MEMBERS = 256;
export const MAX_INVARIANT_SCOPE = 16;
export const MAX_INVARIANT_PARAMS_BYTES = 1024;
export const MAX_ADMITTED_SOURCES = 32;
export const MAX_ACTION_RESOURCES = 64;
export const MAX_STATE_BINDINGS = 64;

/** Action payloads are hashed, never parsed, by Core. The bound caps the work a hostile payload can cause. */
export const MAX_ACTION_PAYLOAD_BYTES = 1_048_576;

/** Kernel `Amount` and `Price` decimals range (INV-18), reused. */
export const MAX_DECIMALS = 38;
