/**
 * @mandate/portfolio — Phase 7F: the Portfolio Mandate and multi-agent
 * coordination layer (docs/phase-7f).
 *
 * One principal, several specialized agents, several markets, one authority.
 * A principal-signed `PORTFOLIO_MANDATE.V1` declares typed resources, the
 * portfolio's authority, every agent's narrower authority and an allocation
 * mode. Agents propose exact action candidates; a deterministic Mandate Room
 * with no authority negotiates allocation; a Portfolio Verifier re-derives
 * everything; the result is compiled into Core grants and reserved through
 * the unchanged control engine (ADR 0027).
 *
 * Nothing here performs I/O, reads a clock or holds a key. Nothing below
 * depends on this package.
 */

export * from './reasons.ts';
export { PortfolioTag, PORTFOLIO_SCHEMA_VERSION, PORTFOLIO_RECEIPT_SCHEMA_VERSION, decodePortfolio, isCanonical } from './encoding.ts';
export * from './resources.ts';
export * from './scope.ts';
export * from './mandate.ts';
export * from './initial-allocation.ts';
export * from './mandate-v2.ts';
export * from './mandate-v3.ts';
export * from './candidate.ts';
export * from './proposal.ts';
export * from './release.ts';
export * from './authority.ts';
export * from './child.ts';
export * from './allocation.ts';
export * from './binding.ts';
export * from './domains/fixture.ts';
export * from './domains/stock.ts';
export * from './domains/perps.ts';
export * from './availability.ts';
export * from './compile.ts';
export * from './reservation.ts';
export * from './domains/fixture-execution.ts';
export * from './screen.ts';
export * from './room.ts';
export * from './verifier.ts';
export * from './receipt.ts';
export * from './status.ts';
export * from './run.ts';
export * from './domains/executors.ts';
export * from './domains/stock-custody.ts';
export * from './view.ts';
