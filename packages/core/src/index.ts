/**
 * @mandate/core — the Mandate Core v1 representation layer (Phase 7B).
 *
 * Canonical identifiers, typed economic quantities, authority terms, grants
 * and the principal policy, action and state envelopes, state bindings, and
 * reservation, execution and receipt references — each with a strict
 * validator, one canonical encoding and a domain-separated digest.
 *
 * What is not here: the authority ledger, the meet, admission, projection,
 * invariant evaluation, reconciliation, signatures, adapters and any I/O. Core
 * depends only on the kernel and its pinned hash library (ADR 0020), and
 * nothing depends on Core yet.
 */

export type { Tagged } from './brand.ts';
export * from './errors.ts';
export * from './primitives.ts';
export * from './encoding.ts';
export * from './limits.ts';
export * from './identifiers.ts';
export * from './quantity.ts';
export * from './module.ts';
export * from './state.ts';
export * from './terms.ts';
export * from './authority.ts';
export * from './action.ts';
export * from './execution.ts';
export * from './receipt.ts';
