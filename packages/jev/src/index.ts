/**
 * @mandate/jev — the optional, advisory Jev decision layer.
 *
 * This package may influence *which* already-valid route is preferred. It can
 * never influence *whether* a route is valid: it is called only after the
 * admissible set is closed, it receives a projection rather than a candidate,
 * it returns a name that is used solely as a local array key, and its choice is
 * re-verified by the kernel before any handoff (ADR 0012).
 *
 * The deterministic router remains the baseline and the fallback. Nothing in
 * `@mandate/kernel`, `@mandate/registry` or `@mandate/router` imports this
 * package, and structural tests in all four packages enforce that.
 */

export * from './types.ts';
export * from './parse.ts';
export * from './client.ts';
