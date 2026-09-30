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
import { emitAgentSearch, emitPortfolioCreated, emitResourceConflict } from './portfolio-scenes.ts';
import { proposalEntries } from './proposals.ts';
import { runJudgeProtocol, type JudgeProtocol } from './protocol.ts';
import { INITIAL_TIME } from './scenario.ts';

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

export async function runJudgeDemo(): Promise<JudgeDemo> {
  const protocol = await runJudgeProtocol();
  const log = new EventLog();
  const x = sceneContext(log, protocol);
  const initial = proposalEntries(protocol.mandate, protocol.core.compiled.bindings, protocol.initial.room, INITIAL_TIME);
  emitPortfolioCreated(x);
  emitAgentSearch(x, initial);
  emitResourceConflict(x, initial);
  return {
    protocol,
    transcript: { schema: JUDGE_DEMO_SCHEMA, version: JUDGE_DEMO_SCHEMA_VERSION, presentationOnly: true, events: log.events, presentationDigest: presentationDigest(log.events) },
  };
}
