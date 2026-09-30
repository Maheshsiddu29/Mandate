/**
 * Judge-mode playback controls over a finished transcript.
 *
 * ```text
 * protocol run → deterministic event transcript → UI playback
 * ```
 *
 * The protocol runs once; this is only a cursor over its events. Nothing
 * here re-runs, advances or mutates protocol state, and there is no timer:
 * the UI decides when to call `next()` (an animation frame, a key press, an
 * interval while `playing`). `start`, `pause`, `resume`, `next` and
 * `restart` are the controls the future UI exposes.
 */

import type { JudgeEvent } from './events.ts';

export type PlaybackState = 'IDLE' | 'PLAYING' | 'PAUSED' | 'FINISHED';

export class DemoPlayback {
  readonly events: readonly JudgeEvent[];
  #cursor = 0;
  #state: PlaybackState = 'IDLE';

  constructor(events: readonly JudgeEvent[]) {
    this.events = events;
  }

  get state(): PlaybackState {
    return this.#state;
  }

  /** How many events have been shown. */
  get position(): number {
    return this.#cursor;
  }

  /** Every event shown so far, in order. */
  get shown(): readonly JudgeEvent[] {
    return this.events.slice(0, this.#cursor);
  }

  start(): void {
    if (this.#state === 'IDLE') this.#state = this.events.length === 0 ? 'FINISHED' : 'PLAYING';
  }

  pause(): void {
    if (this.#state === 'PLAYING') this.#state = 'PAUSED';
  }

  resume(): void {
    if (this.#state === 'PAUSED') this.#state = 'PLAYING';
  }

  /**
   * The next event, or `null` when there is none. Stepping is allowed while
   * paused (single-step) and from idle (it starts paused); it is how a UI
   * advances while playing, too.
   */
  next(): JudgeEvent | null {
    if (this.#state === 'FINISHED') return null;
    if (this.#state === 'IDLE') this.#state = 'PAUSED';
    const e = this.events[this.#cursor];
    if (e === undefined) {
      this.#state = 'FINISHED';
      return null;
    }
    this.#cursor += 1;
    if (this.#cursor === this.events.length) this.#state = 'FINISHED';
    return e;
  }

  restart(): void {
    this.#cursor = 0;
    this.#state = 'IDLE';
  }
}
