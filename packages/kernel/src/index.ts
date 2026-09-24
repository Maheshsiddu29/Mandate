/**
 * @mandate/kernel — the deterministic, model-free mandate verification kernel.
 *
 * This package contains the only component in Mandate that authorizes an
 * execution (design section 10). It is pure, total, fail-closed, model-free and
 * order-independent, and it performs no I/O: every input is a value and every
 * output is a value.
 *
 * It has no dependency on adapters, registries, model clients, chain clients or
 * UI, and later phases add those as packages that depend on this one — never
 * the reverse (ADR 0003).
 */

export * from './result.ts';
export * from './reason-codes.ts';
export * from './identifiers.ts';
export * from './bytes.ts';
export * from './time.ts';
export * from './units.ts';
export * from './trust.ts';
export * from './mandate.ts';
export * from './candidate.ts';
export * from './state.ts';
