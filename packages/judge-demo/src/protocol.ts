/**
 * The protocol run behind the judge demo. **Real Mandate code, once, in
 * order, against one ledger; offline; no transaction.**
 *
 * ```text
 * protocol run → deterministic event transcript → UI playback
 * ```
 *
 * Everything the transcript reports is read from what this returns. Each
 * later scene is a further call into the same frozen public API against the
 * same in-memory ledger — exactly how a Portfolio is used over time — and
 * ledger snapshots are taken wherever a scene reports ledger state, so the
 * transcript never has to re-run anything.
 */

import { verificationTranscript, type PortfolioCore, type PortfolioMandate, type VerificationTranscript } from '@mandate/portfolio';
import { runDemo, type DemoRun } from '@mandate/portfolio/demo';
import { INITIAL_TIME } from './scenario.ts';

export type LedgerSnapshot = Awaited<ReturnType<PortfolioCore['engine']['read']>>;

export interface JudgeProtocol {
  readonly core: PortfolioCore;
  readonly mandate: PortfolioMandate;
  /** The principal's signature over the mandate. */
  readonly signature: string;
  /** Scenes 1–5: the canonical demonstration, exactly `runDemo()`. */
  readonly initial: DemoRun;
  /** The verifier's complete input for the initial run, as `runPortfolio` built it. */
  readonly initialTranscript: VerificationTranscript;
  readonly afterInitial: LedgerSnapshot;
}

export async function runJudgeProtocol(): Promise<JudgeProtocol> {
  const initial = await runDemo();
  const core = initial.core;
  const mandate = core.compiled.mandate;
  const initialTranscript = verificationTranscript({
    mandate,
    signature: initial.signature,
    bindings: core.compiled.bindings,
    availability: initial.before,
    now: INITIAL_TIME,
    candidate: initial.room.candidate,
    proposals: initial.room.proposals,
    releases: initial.room.signedReleases,
  });
  const afterInitial = await core.engine.read(mandate.principal);
  return { core, mandate, signature: initial.signature, initial, initialTranscript, afterInitial };
}
