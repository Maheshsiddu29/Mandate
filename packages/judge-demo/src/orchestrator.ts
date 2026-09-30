/**
 * The judge demo: run the protocol once, then narrate it.
 *
 * ```text
 * runJudgeProtocol()  real Mandate code, offline, one ledger      (protocol.ts)
 *   → scenes 1…10     events read from what the protocol returned  (*-scenes.ts)
 *   → transcript      MANDATE_JUDGE_DEMO.V1, deterministic          (events.ts)
 * ```
 */

import { sceneContext } from './context.ts';
import { EventLog, JUDGE_DEMO_SCHEMA, JUDGE_DEMO_SCHEMA_VERSION, presentationDigest, type JudgeEvent } from './events.ts';
import { addVectors, type ResourceVector } from '@mandate/portfolio';
import { emitAttack } from './attack-scenes.ts';
import { emitCompliant, emitFaultIsolation } from './continuation-scenes.ts';
import { emitAgentSearch, emitPortfolioCreated, emitResourceConflict } from './portfolio-scenes.ts';
import { proposalEntries } from './proposals.ts';
import { runJudgeProtocol, type JudgeProtocol } from './protocol.ts';
import { emitRoom } from './room.ts';
import { INITIAL_TIME, REPLAY_PROBE_TIME } from './scenario.ts';
import { emitReplayProbe, emitVerification } from './verification.ts';

export interface JudgeTranscript {
  readonly schema: typeof JUDGE_DEMO_SCHEMA;
  readonly version: typeof JUDGE_DEMO_SCHEMA_VERSION;
  /** The transcript is presentation data. Its commitments are the receipt digests inside it. */
  readonly presentationOnly: true;
  readonly events: readonly JudgeEvent[];
  /** Drift detector for UI builds; not a protocol commitment. */
  readonly presentationDigest: string;
}

export interface JudgeDemo {
  readonly protocol: JudgeProtocol;
  readonly transcript: JudgeTranscript;
}

const sum = (vs: readonly ResourceVector[]): ResourceVector => vs.reduce<ResourceVector>((v, w) => addVectors(v, w), []);

export async function runJudgeDemo(): Promise<JudgeDemo> {
  const protocol = await runJudgeProtocol();
  const log = new EventLog();
  const x = sceneContext(log, protocol);
  const initial = proposalEntries(protocol.mandate, protocol.core.compiled.bindings, protocol.initial.room, INITIAL_TIME);
  emitPortfolioCreated(x);
  emitAgentSearch(x, initial);
  emitResourceConflict(x, initial);

  log.scene(4);
  const p = protocol;
  emitRoom(x, { run: 'initial', time: INITIAL_TIME, room: p.initial.room, entries: initial });

  log.scene(5);
  const firstRound = initial.filter((e) => e.decision.round === 1).map((e) => e.signed.proposal.requested);
  emitVerification(x, { run: 'initial', time: INITIAL_TIME, result: p.initial, requested: sum(firstRound), ledgerBefore: null, ledgerAfter: p.afterInitial, forgery: p.roomForgery });
  emitReplayProbe(x, p.replay, REPLAY_PROBE_TIME, p.afterInitial, p.afterReplay);

  emitAttack(x);
  emitFaultIsolation(x);
  emitCompliant(x);
  return {
    protocol,
    transcript: { schema: JUDGE_DEMO_SCHEMA, version: JUDGE_DEMO_SCHEMA_VERSION, presentationOnly: true, events: log.events, presentationDigest: presentationDigest(log.events) },
  };
}
