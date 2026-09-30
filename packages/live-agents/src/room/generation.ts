/**
 * Room generations.
 *
 * Every negotiation round is `(roomId, generation)`. A reply is used only
 * if it answers the current generation of a Room that is still open; a
 * reply to an earlier generation is STALE and one after finalization is
 * IGNORED. Neither changes anything: no request, no allocation, no
 * reservation, no receipt, and a finalized Room never reopens.
 */

export type ReplyStatus = 'CURRENT' | 'STALE' | 'FINALIZED';

export class GenerationGate {
  readonly roomId: string;
  #generation = 0;
  #open = false;
  #finalized = false;

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  get generation(): number {
    return this.#generation;
  }

  get finalized(): boolean {
    return this.#finalized;
  }

  /** Start the next generation. A finalized Room cannot. */
  open(): number {
    if (this.#finalized) throw new Error(`room ${this.roomId} is finalized`);
    this.#generation += 1;
    this.#open = true;
    return this.#generation;
  }

  /** The current generation takes no more replies; the Room may still open another. */
  closeGeneration(): void {
    this.#open = false;
  }

  finalize(): void {
    this.#open = false;
    this.#finalized = true;
  }

  classify(roomId: string, generation: number): ReplyStatus {
    if (this.#finalized) return 'FINALIZED';
    return this.#open && roomId === this.roomId && generation === this.#generation ? 'CURRENT' : 'STALE';
  }
}
