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

import type { Identifier } from '@mandate/kernel';
import {
  proposalDigest,
  reserveChild,
  screenProposal,
  verificationTranscript,
  verifyTranscript,
  type ChildAuthorizationDigest,
  type PortfolioCandidate,
  type PortfolioCore,
  type PortfolioMandate,
  type PortfolioRun,
  type ProposalDigest,
  type Reason,
  type SignedProposal,
  type VerificationTranscript,
  type VerifierResult,
} from '@mandate/portfolio';
import { runDemo, type DemoRun } from '@mandate/portfolio/demo';
import { INITIAL_TIME, REPLAY_PROBE_TIME } from './scenario.ts';

export type LedgerSnapshot = Awaited<ReturnType<PortfolioCore['engine']['read']>>;

/** One verified child presented to the reservation boundary a second time. */
export interface ReplayProbe {
  readonly child: ChildAuthorizationDigest;
  readonly agent: string;
  readonly outcome: 'RESERVED' | 'REFUSED';
  readonly reasons: readonly Reason[];
}

/**
 * A Mandate Room output forged to also accept a proposal the room refused,
 * handed to the real verifier. The verifier must refuse it: the Room has no
 * authority to lose.
 */
export interface RoomForgery {
  readonly proposal: ProposalDigest;
  readonly result: VerifierResult;
}

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
  /** Scene 5: the initial Room's output, forged to also accept the blocked stock look-alike. */
  readonly roomForgery: RoomForgery | null;
  /** Scene 5: every reserved child of the initial run, presented again through `reserveChild`. */
  readonly replay: readonly ReplayProbe[];
  readonly afterReplay: LedgerSnapshot;
}

/** The verifier's complete input for a run, exactly as `runPortfolio` assembles it. */
export function transcriptOf(core: PortfolioCore, signature: string, run: PortfolioRun, now: bigint): VerificationTranscript {
  return verificationTranscript({
    mandate: core.compiled.mandate,
    signature,
    bindings: core.compiled.bindings,
    availability: run.before,
    now,
    candidate: run.room.candidate,
    proposals: run.room.proposals,
    releases: run.room.signedReleases,
  });
}

/**
 * `transcript` with `signed` added to what the room accepted, committed for
 * its derived demand, as a compromised room would hand it over; then the
 * verifier. Pure: nothing touches the ledger.
 */
export function forgeRoomAcceptance(mandate: PortfolioMandate, core: PortfolioCore, transcript: VerificationTranscript, signed: SignedProposal): RoomForgery {
  const digest = proposalDigest(signed.proposal);
  const demand = screenProposal(mandate, core.compiled.bindings, signed, transcript.verifiedAt).demand;
  const candidate: PortfolioCandidate = {
    portfolioMandate: transcript.candidate.portfolioMandate,
    accepted: [...transcript.candidate.accepted, digest].sort(),
    allocationLog: [...transcript.candidate.allocationLog, { kind: 'COMMIT', agent: signed.proposal.agent, id: digest as string as Identifier, amounts: demand }],
  };
  const proposals = transcript.proposals.some((s) => proposalDigest(s.proposal) === digest) ? transcript.proposals : [...transcript.proposals, signed];
  return { proposal: digest, result: verifyTranscript(mandate, core.compiled.bindings, { ...transcript, candidate, proposals }) };
}

export async function runJudgeProtocol(): Promise<JudgeProtocol> {
  const initial = await runDemo();
  const core = initial.core;
  const mandate = core.compiled.mandate;
  const initialTranscript = transcriptOf(core, initial.signature, initial, INITIAL_TIME);
  const afterInitial = await core.engine.read(mandate.principal);

  // A compromised room "accepts" the stock agent's same-ticker look-alike, which it had refused.
  const refused = new Set(initial.room.decisions.filter((d) => d.outcome === 'REJECTED').map((d) => d.proposal as string));
  const lookalike = initial.room.proposals.find((s) => s.proposal.candidate.kind === 'STOCK_BUY' && refused.has(proposalDigest(s.proposal)));
  const roomForgery = lookalike === undefined ? null : forgeRoomAcceptance(mandate, core, initialTranscript, lookalike);

  // The same verified children, again: one signed proposal is one Core action, so the ledger must refuse.
  const replay: ReplayProbe[] = [];
  if (initial.verification.status === 'VERIFIED') {
    for (const v of initial.verification.children) {
      const r = await reserveChild(core, initialTranscript, v.digest, REPLAY_PROBE_TIME);
      replay.push({ child: v.digest, agent: v.child.agent.value, outcome: r.status, reasons: r.status === 'REFUSED' ? r.reasons : [] });
    }
  }
  const afterReplay = await core.engine.read(mandate.principal);

  return { core, mandate, signature: initial.signature, initial, initialTranscript, afterInitial, roomForgery, replay, afterReplay };
}
