/**
 * @mandate/registry — canonical asset and representation registry.
 *
 * Answers two questions the kernel deliberately cannot: what real financial
 * asset did the principal mean, and which concrete tokenized representations may
 * legitimately be considered for satisfying that mandate.
 *
 * It depends on `@mandate/kernel` and nothing else, and it performs no I/O — no
 * network, no filesystem, no clock, no randomness (ADR 0004). Phase 3 adapters
 * do the I/O and hand this package values, so a synthetic world and a mainnet
 * fixture flow through one resolution and admissibility path rather than two.
 *
 * It resolves and it filters. It does not authorize: the deterministic verifier
 * remains the sole authorization authority, and this package's output is an
 * input to it, re-checked from scratch.
 */

export * from './reason-codes.ts';
export * from './claims.ts';
export * from './semantics.ts';
export * from './asset-id.ts';
export * from './asset.ts';
export * from './reference.ts';
export * from './asset-index.ts';
export * from './representation-id.ts';
export * from './representation.ts';
export * from './snapshot.ts';
export * from './registry.ts';
