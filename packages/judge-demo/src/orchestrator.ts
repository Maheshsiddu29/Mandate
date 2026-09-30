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
import { emitCompliant, emitFaultIsolation, emitPortfolioConflict } from './continuation-scenes.ts';
import { emitAgentSearch, emitPortfolioCreated, emitResourceConflict } from './portfolio-scenes.ts';
import { proposalEntries } from './proposals.ts';
import { runJudgeProtocol, type JudgeProtocol } from './protocol.ts';
import { emitRoom } from './room.ts';
import type { RobinhoodLiveEvidence } from './evidence.ts';
import { emitCompleted, emitLiveEvidence, emitReceipts, type ReceiptRun } from './receipt.ts';
import { ATTACK_TIME, COMPLIANT_TIME, CONFLICT_TIME, INITIAL_TIME, REPLAY_PROBE_TIME } from './scenario.ts';
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

/**
 * Evidence claims must be backed. A domain may be labelled LIVE_TESTNET only
 * when recorded testnet evidence exists for a chain its agents are
 * authorized on; and nothing executed in this run may be LIVE_TESTNET,
 * because this run sends nothing.
 */
export function checkEvidenceClaims(p: JudgeProtocol, evidence: RobinhoodLiveEvidence): void {
  for (const b of p.core.compiled.bindings) {
    if (b.evidence !== 'LIVE_TESTNET') continue;
    const chains = p.mandate.agents.filter((a) => a.scope.domains.includes(b.domain)).flatMap((a) => a.scope.chains as readonly string[]);
    if (!chains.includes(evidence.chain)) throw new Error(`${b.domain} is labelled LIVE_TESTNET without recorded evidence on its chain`);
  }
  for (const r of [p.initial, p.attack, p.compliant, p.conflict]) {
    for (const e of r.executions) if (e.evidence === 'LIVE_TESTNET' || e.transactions !== 0) throw new Error(`an execution in this offline run claims ${e.evidence} with ${e.transactions} transactions`);
  }
}

export interface JudgeDemoInput {
  /** The recorded Phase 7E.3 evidence (evidence-files.ts). */
  readonly evidence: RobinhoodLiveEvidence;
}

export async function runJudgeDemo(input: JudgeDemoInput): Promise<JudgeDemo> {
  const protocol = await runJudgeProtocol();
  checkEvidenceClaims(protocol, input.evidence);
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
  emitPortfolioConflict(x);

  log.scene(10);
  emitLiveEvidence(x, input.evidence);
  const runs: ReceiptRun[] = [
    { run: 'initial', time: INITIAL_TIME, receipt: p.initial.receipt, digest: p.initial.digest },
    { run: 'attack', time: ATTACK_TIME, receipt: p.attack.receipt, digest: p.attack.digest },
    { run: 'compliant', time: COMPLIANT_TIME, receipt: p.compliant.receipt, digest: p.compliant.digest },
    { run: 'conflict', time: CONFLICT_TIME, receipt: p.conflict.receipt, digest: p.conflict.digest },
  ];
  emitReceipts(x, runs);
  emitCompleted(x, runs, input.evidence);
  return {
    protocol,
    transcript: { schema: JUDGE_DEMO_SCHEMA, version: JUDGE_DEMO_SCHEMA_VERSION, presentationOnly: true, events: log.events, presentationDigest: presentationDigest(log.events) },
  };
}
