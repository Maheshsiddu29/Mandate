/**
 * Presentation cursor over a finished transcript.
 *
 * This mirrors `DemoPlayback` in `@mandate/judge-demo`: a cursor, no timer,
 * no protocol work. `previous` and `seek` replay that cursor from the start
 * so a restart cannot mutate the transcript.
 */

import type { JudgeDemoEvent } from './types.ts';

export type PlaybackState = 'IDLE' | 'PLAYING' | 'PAUSED' | 'FINISHED';

export class PresentationPlayback {
  readonly events: readonly JudgeDemoEvent[];
  #cursor = 0;
  #state: PlaybackState = 'IDLE';

  constructor(events: readonly JudgeDemoEvent[]) {
    this.events = events;
  }

  get state(): PlaybackState {
    return this.#state;
  }

  get position(): number {
    return this.#cursor;
  }

  get shown(): readonly JudgeDemoEvent[] {
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

  next(): JudgeDemoEvent | null {
    if (this.#state === 'FINISHED') return null;
    if (this.#state === 'IDLE') this.#state = 'PAUSED';
    const event = this.events[this.#cursor];
    if (event === undefined) {
      this.#state = 'FINISHED';
      return null;
    }
    this.#cursor += 1;
    if (this.#cursor === this.events.length) this.#state = 'FINISHED';
    return event;
  }

  restart(): void {
    this.#cursor = 0;
    this.#state = 'IDLE';
  }

  /** Step backward by replaying the transcript up to the previous event. */
  previous(): void {
    if (this.#cursor === 0) return;
    const target = this.#cursor - 1;
    const playing = this.#state === 'PLAYING';
    this.seek(target, playing ? 'PLAYING' : 'PAUSED');
  }

  /**
   * Show the first `position` events by replaying `next`. The transcript
   * array is not modified.
   */
  seek(position: number, state: PlaybackState = 'PAUSED'): void {
    const target = Math.max(0, Math.min(position, this.events.length));
    this.restart();
    if (target === 0) {
      this.#state = state === 'PLAYING' && this.events.length > 0 ? 'PLAYING' : 'IDLE';
      return;
    }
    this.start();
    for (let index = 0; index < target; index += 1) this.next();
    if (this.#state === 'FINISHED') return;
    if (state === 'PLAYING') this.#state = 'PLAYING';
    else if (state === 'PAUSED') this.#state = 'PAUSED';
  }

  /**
   * Land on the last event of a scene, paused. A chapter jump shows that
   * scene's outcome. Playback from there continues into the next scene.
   */
  seekScene(scene: number): number {
    let last = -1;
    for (let index = 0; index < this.events.length; index += 1) {
      if (this.events[index]?.scene === scene) last = index;
    }
    if (last < 0) return 0;
    this.seek(last + 1, 'PAUSED');
    return last + 1;
  }
}

/** How long the UI waits before the next presentation tick. Motion does not change which event appears. */
export function stepDelayMs(reducedMotion: boolean, sceneChanged: boolean): number {
  if (reducedMotion) return sceneChanged ? 1100 : 720;
  return sceneChanged ? 1280 : 760;
}
