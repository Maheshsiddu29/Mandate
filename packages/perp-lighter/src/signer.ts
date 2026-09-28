/**
 * The Lighter Venue Signer's public surface (Phase 7E.1; signer-architecture.md).
 *
 * Two typed operations and a recovery pass — nothing else:
 *
 * - `issueAuthorizedPerpOrder(authorization, request)`
 * - `issueAuthorizedCancel(authorization, request)`
 * - `recover()` — after a restart, every admitted attempt whose issuance was
 *   interrupted is marked `OUTCOME_UNKNOWN`. Nothing is resubmitted, nothing
 *   is re-signed, no fresh attempt is created, nothing is released.
 *
 * There is no `sign(bytes)`, no `signTransaction`, no key accessor and no
 * SDK client. The signer verifies the exact authorization, module, adapter,
 * account and generation itself; Control re-reads and revalidates the
 * reservation and commits `ADMIT_ATTEMPT` before custody may sign; the signed
 * transaction stays inside the signer (journal, venue). What a caller gets
 * back is an attempt id, the venue transaction hash and an issuance state.
 */

import type { AttemptRecord } from '@mandate/ledger';
import type { AuthorizationRecord } from '@mandate/control';
import { issue, type IssueOutcome, type IssueRequest, type SignerDeps } from './issuance.ts';

export type { IssueOutcome, IssueRequest, SignerConfig, SignerDeps, IssueStage } from './issuance.ts';

export interface RecoveryReport {
  /** Admitted attempts with no journal record: the process died between admission and recording. */
  readonly unrecorded: number;
  /** Attempts whose issuance was in progress (issued or sent) when the process died. */
  readonly interrupted: number;
}

export class VenueSigner {
  readonly #deps: SignerDeps;

  constructor(deps: SignerDeps) {
    this.#deps = deps;
  }

  issueAuthorizedPerpOrder(authorization: AuthorizationRecord, request: IssueRequest): Promise<IssueOutcome> {
    return issue(this.#deps, 'ORDER', authorization, request);
  }

  issueAuthorizedCancel(authorization: AuthorizationRecord, request: IssueRequest): Promise<IssueOutcome> {
    return issue(this.#deps, 'CANCEL', authorization, request);
  }

  /**
   * Mark every interrupted issuance `OUTCOME_UNKNOWN`. Only venue evidence
   * resolves it (7F); time does not.
   */
  recover(): RecoveryReport {
    const d = this.#deps;
    const state = d.store.readCommitted(d.config.principal).state;
    let unrecorded = 0;
    let interrupted = 0;
    for (const a of state.attempts.values() as AttemptRecord[]) {
      if (a.adapter.adapterDigest !== d.config.adapter.adapterDigest) continue;
      const rec = d.journal.get(a.attempt);
      if (rec === null) {
        if (d.journal.open(d.config.principal, a.attempt, 'OUTCOME_UNKNOWN', null, 'RECOVERED_UNRECORDED').ok) unrecorded += 1;
      } else if (rec.state === 'ARTIFACT_ISSUED' || rec.state === 'SUBMISSION_SENT') {
        if (d.journal.transition(a.attempt, 'OUTCOME_UNKNOWN', `RECOVERED_FROM_${rec.state}`).ok) interrupted += 1;
      }
    }
    return { unrecorded, interrupted };
  }
}
