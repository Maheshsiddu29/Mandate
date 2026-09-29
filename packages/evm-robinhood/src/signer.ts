/**
 * The Robinhood gate signer's public surface (Phase 7E.3).
 *
 * One typed operation and a recovery pass — nothing else:
 *
 * - `issueAuthorizedBuy(authorization, request)` — the staged boundary of
 *   issuance.ts: ADMIT_ATTEMPT before any key is used, custody's own check of
 *   the committed attempt, exact calldata, preflight, submission.
 * - `recover()` — after a restart, every admitted attempt whose issuance was
 *   interrupted is marked `OUTCOME_UNKNOWN`. Nothing is resubmitted, re-signed
 *   or released; the gate's replay key still guarantees at most one settlement.
 *
 * There is no `sign(bytes)`, no key accessor and no generic transaction
 * sender. What a caller gets back is an attempt id, the gate mandate digest,
 * the execution commitment, a transaction hash and an issuance state.
 */

import type { AttemptRecord } from '@mandate/ledger';
import type { AuthorizationRecord } from '@mandate/control';
import { issue, type GateSignerDeps, type IssueOutcome, type IssueRequest } from './issuance.ts';

export type { GateCall, GateChain, GateSignerConfig, GateSignerDeps, IssueOutcome, IssueRequest, IssueStage } from './issuance.ts';

export interface RecoveryReport {
  readonly unrecorded: number;
  readonly interrupted: number;
}

export class GateSigner {
  readonly #deps: GateSignerDeps;

  constructor(deps: GateSignerDeps) {
    this.#deps = deps;
  }

  issueAuthorizedBuy(authorization: AuthorizationRecord, request: IssueRequest): Promise<IssueOutcome> {
    return issue(this.#deps, authorization, request);
  }

  recover(): RecoveryReport {
    const d = this.#deps;
    const state = d.store.readCommitted(d.config.principal).state;
    let unrecorded = 0;
    let interrupted = 0;
    for (const a of state.attempts.values() as Iterable<AttemptRecord>) {
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
