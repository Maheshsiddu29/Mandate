/**
 * Judge-demo playback source.
 *
 * The transcript is a build-time asset produced by `npm run web:demo:generate`.
 * This module does not run the protocol, read the filesystem, or contact a network.
 */

import { derivePresentation, finalAgents, finalEvidence, finalReceipts, finalRoomRounds, summaryOf, toEventView } from './normalize.ts';
import type {
  AgentView,
  DemoEventView,
  DemoSummary,
  EvidenceView,
  JudgeTranscript,
  MandateDemoProvider,
  Presentation,
  ReceiptView,
  RoomRoundView,
} from './types.ts';

export class JudgeDemoProvider implements MandateDemoProvider {
  readonly transcript: JudgeTranscript;

  constructor(source: JudgeTranscript) {
    this.transcript = source;
  }

  getSummary(): Promise<DemoSummary> {
    return Promise.resolve(summaryOf(this.transcript));
  }

  getEvents(): Promise<readonly DemoEventView[]> {
    return Promise.resolve(this.transcript.events.map(toEventView));
  }

  getAgents(): Promise<readonly AgentView[]> {
    return Promise.resolve(finalAgents(this.transcript));
  }

  getRoomRounds(): Promise<readonly RoomRoundView[]> {
    return Promise.resolve(finalRoomRounds(this.transcript));
  }

  getReceipts(): Promise<readonly ReceiptView[]> {
    return Promise.resolve(finalReceipts(this.transcript));
  }

  getEvidence(): Promise<readonly EvidenceView[]> {
    return Promise.resolve(finalEvidence(this.transcript));
  }

  present(shownCount: number): Presentation {
    return derivePresentation(this.transcript, this.transcript.events.slice(0, shownCount));
  }
}
