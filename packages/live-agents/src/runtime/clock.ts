/**
 * Time for the live runtime.
 *
 * Durations come from a monotonic clock (`performance.now`), never from the
 * wall clock; wall time only labels events. Protocol time — the `now` the
 * frozen Mandate code takes as a parameter — is derived from the monotonic
 * clock and anchored at the demonstration epoch (`protocolClock`), so real
 * latency ages quotes exactly as much as it really took.
 *
 * This module is the only place the package reads a clock; tests may
 * substitute `ManualClock`.
 */

import { DEMO_NOW } from '@mandate/portfolio/demo';

export interface Clock {
  /** Monotonic milliseconds. */
  nowMs(): number;
  /** Wall-clock ISO timestamp, for labelling only. */
  wallIso(): string;
  /** Wall-clock milliseconds since the Unix epoch: only for expiries that must outlive a process (wallet challenges, restored protocol time). */
  wallMs(): number;
  /** Resolves after `ms`, or rejects when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}

function abortable(ms: number, signal: AbortSignal | undefined, schedule: (fn: () => void, ms: number) => () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new AbortedError());
      return;
    }
    const onAbort = () => {
      cancel();
      reject(new AbortedError());
    };
    const cancel = schedule(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const realClock: Clock = {
  nowMs: () => performance.now(),
  wallIso: () => new Date().toISOString(),
  wallMs: () => Date.now(),
  sleep: (ms, signal) =>
    abortable(ms, signal, (fn, t) => {
      const h = setTimeout(fn, t);
      return () => clearTimeout(h);
    }),
};

/**
 * A clock tests move by hand. `sleep` resolves when `advance` passes its
 * deadline; wall time is a fixed epoch plus the monotonic time.
 */
export class ManualClock implements Clock {
  #now = 0;
  #timers: { at: number; fn: () => void }[] = [];

  nowMs(): number {
    return this.#now;
  }

  wallIso(): string {
    return new Date(this.wallMs()).toISOString();
  }

  wallMs(): number {
    return Date.UTC(2026, 8, 30) + this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return abortable(ms, signal, (fn, t) => {
      const timer = { at: this.#now + t, fn };
      this.#timers.push(timer);
      return () => {
        this.#timers = this.#timers.filter((x) => x !== timer);
      };
    });
  }

  /** Move time forward, firing every timer that falls due, in order. */
  async advance(ms: number): Promise<void> {
    const end = this.#now + ms;
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.#now = due.at;
      due.fn();
      await new Promise<void>((r) => setImmediate(r));
    }
    this.#now = end;
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** Protocol time: the demonstration epoch plus whole elapsed seconds since `startMs`. */
export function protocolClock(clock: Clock, startMs: number, anchor: bigint = DEMO_NOW): () => bigint {
  return () => anchor + BigInt(Math.floor((clock.nowMs() - startMs) / 1000));
}
