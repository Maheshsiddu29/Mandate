/**
 * The default executor (portfolio-mandate.md §15): what happens to a
 * reserved child in an offline run.
 *
 * - **FIXTURE domains** — `ADMIT_ATTEMPT`, the portfolio's `checkBeforeSign`,
 *   then a labelled `SIMULATED` settlement (fixture-execution.ts).
 * - **Every other domain** — the child is handed to that domain's existing
 *   signer (Robinhood: `robinhood-gate-signer`; Lighter: the venue signer),
 *   which admits its own attempt for its own exact artifact. This executor
 *   does not pretend to be it: the result is `AWAITING_DOMAIN_SIGNER`,
 *   `OFFCHAIN_ONLY`, 0 transactions, and it carries the integration's own
 *   evidence class separately.
 */

import type { Identifier } from '@mandate/kernel';
import type { AuthorizationRecord } from '@mandate/control';
import { bindingFor } from '../binding.ts';
import type { ChildAuthorizationDigest } from '../child.ts';
import type { ExecutionResult } from '../receipt.ts';
import { reason } from '../reasons.ts';
import type { PortfolioCore } from '../reservation.ts';
import type { ChildExecutor } from '../run.ts';
import type { VerifiedChild } from '../verifier.ts';
import { executeFixtureChild } from './fixture-execution.ts';

export function defaultExecutor(core: PortfolioCore): ChildExecutor {
  return async (v: VerifiedChild, record: AuthorizationRecord, at: bigint, verified: ReadonlySet<string>): Promise<ExecutionResult> => {
    const b = bindingFor(core.compiled.bindings, v.candidate.kind);
    if ('refused' in b) return { child: v.digest, status: 'FAILED', evidence: 'OFFCHAIN_ONLY', integration: 'unbound' as Identifier, integrationEvidence: 'OFFCHAIN_ONLY', attempt: null, artifact: null, transactions: 0, reasons: [b.refused] };
    const base = { child: v.digest, integration: b.integration, integrationEvidence: b.evidence };
    if (b.evidence !== 'FIXTURE') {
      return { ...base, status: 'AWAITING_DOMAIN_SIGNER', evidence: 'OFFCHAIN_ONLY', attempt: null, artifact: null, transactions: 0, reasons: [] };
    }
    const x = await executeFixtureChild(core, verified as ReadonlySet<ChildAuthorizationDigest>, v.child, v.candidate, record, at);
    if (!x.ok) return { ...base, status: 'FAILED', evidence: 'OFFCHAIN_ONLY', attempt: null, artifact: null, transactions: 0, reasons: x.error.length > 0 ? x.error : [reason('ATTEMPT_NOT_COMMITTED')] };
    return { ...base, status: 'SETTLED', evidence: 'SIMULATED', attempt: x.value.attempt.attempt, artifact: x.value.artifact, transactions: 0, reasons: [] };
  };
}
