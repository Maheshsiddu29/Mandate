/**
 * @mandate/execution-gate — the offchain half of the Phase 6 execution gate.
 *
 * The onchain gate is `contracts/src/MandateExecutionGate.sol`. This package
 * holds what the pipeline and the differential test need beside it:
 *
 * - the gate's wire form of a mandate and candidate (`wire.ts`);
 * - the execution commitment an agent signs (`commitment.ts`);
 * - exact bound conversion into funding-token atoms (`scale.ts`);
 * - the gate's refusal vocabulary as Solidity revert data (`errors.ts`);
 * - a reference model of `execute`, built on the kernel's own decoder and
 *   signature rule (`model.ts`);
 * - the rule that turns confirmed chain evidence into a kernel
 *   `ExecutionObservation` (`reconciliation.ts`).
 *
 * It performs no I/O and holds no key. Dependencies: `@mandate/kernel` and the
 * two `@noble` packages the kernel already pins (ADR 0019).
 */

export * from './wire.ts';
export * from './commitment.ts';
export * from './scale.ts';
export * from './errors.ts';
export * from './model.ts';
export * from './reconciliation.ts';
export * from './delegated.ts';
