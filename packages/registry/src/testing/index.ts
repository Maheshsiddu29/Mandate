/**
 * `@mandate/registry/testing` — synthetic registry worlds and development
 * fixtures. **TEST / SYNTHETIC.**
 *
 * Shipped as a labelled subpath rather than test-tree-only code because Phase 4's
 * route and simulation work needs the same builders, and because a synthetic world
 * and a real fixture must flow through one registry. There is no separate
 * simulation decision engine (ADR 0004).
 *
 * Nothing here is real market data, and nothing here is any real issuer's data.
 * See `fixtures.ts` for exactly which values are genuine public identifiers and
 * which are invented. Real data begins in Phase 3.
 */

export * from './fixtures.ts';
export * from './worlds.ts';
