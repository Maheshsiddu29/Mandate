/**
 * A local circuit breaker for the advisory layer.
 *
 * The problem it solves is latency, not safety. Every Jev failure already falls
 * back to the deterministic candidate, so a sustained outage is safe — but it is
 * not free: each decision waits out the full deadline before falling back, and
 * the trading path pays that on every order for as long as the outage lasts.
 *
 * So this is deliberately the smallest thing that works:
 *
 * - **Pure and in-process.** A counter and two timestamps. No store, no shared
 *   state, no distributed coordination. A caller that runs several processes
 *   gets several independent breakers, which is fine: each one is only
 *   protecting its own latency budget.
 * - **It cannot change a decision.** Opening the circuit produces
 *   `CIRCUIT_OPEN`, which selects index 0 — byte-identical to what
 *   `JEV_DISABLED` produces. The permitted-execution set is unaffected, and so
 *   is the selected candidate whenever Jev would have failed anyway.
 * - **It reads the clock from its caller.** Like everything else in this
 *   repository, time is a parameter.
 *
 * Abstention is a success, not a failure: a model that declines to advise is
 * working correctly and must not open the circuit.
 */

export interface CircuitPolicy {
  /** Consecutive failures that open the circuit. */
  readonly failureThreshold: number;
  /** How long it stays open before one probe is allowed through. */
  readonly cooldownMs: number;
}

export const DEFAULT_CIRCUIT_POLICY: CircuitPolicy = {
  failureThreshold: 5,
  cooldownMs: 30_000,
};

export const CircuitState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  /** One probe is permitted; its outcome closes or re-opens the circuit. */
  HALF_OPEN: 'HALF_OPEN',
} as const;
export type CircuitState = (typeof CircuitState)[keyof typeof CircuitState];

export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly openedAtMs: number | null;
}

/**
 * Mutable, single-process, and owned by whoever constructs it.
 *
 * It is not passed to the router and nothing in the kernel can observe it.
 */
export class AdvisoryCircuit {
  readonly #policy: CircuitPolicy;
  #consecutiveFailures = 0;
  #openedAtMs: number | null = null;
  #probeInFlight = false;

  constructor(policy: CircuitPolicy = DEFAULT_CIRCUIT_POLICY) {
    if (!Number.isSafeInteger(policy.failureThreshold) || policy.failureThreshold < 1) {
      throw new Error('failureThreshold must be a positive integer');
    }
    if (!Number.isFinite(policy.cooldownMs) || policy.cooldownMs < 0) {
      throw new Error('cooldownMs must be a non-negative number');
    }
    this.#policy = policy;
  }

  state(nowMs: number): CircuitState {
    if (this.#openedAtMs === null) return CircuitState.CLOSED;
    if (nowMs - this.#openedAtMs >= this.#policy.cooldownMs) return CircuitState.HALF_OPEN;
    return CircuitState.OPEN;
  }

  /**
   * Whether a call should be attempted now.
   *
   * In `HALF_OPEN` exactly one probe is admitted until it reports back, so a
   * long outage does not produce a burst of concurrent probes each cooldown.
   */
  shouldAttempt(nowMs: number): boolean {
    const state = this.state(nowMs);
    if (state === CircuitState.CLOSED) return true;
    if (state === CircuitState.OPEN) return false;
    if (this.#probeInFlight) return false;
    this.#probeInFlight = true;
    return true;
  }

  /** A usable answer arrived, including an explicit abstention. */
  recordSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#openedAtMs = null;
    this.#probeInFlight = false;
  }

  /** The call did not produce a usable answer, for any reason. */
  recordFailure(nowMs: number): void {
    this.#probeInFlight = false;
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= this.#policy.failureThreshold) this.#openedAtMs = nowMs;
  }

  snapshot(nowMs: number): CircuitSnapshot {
    return {
      state: this.state(nowMs),
      consecutiveFailures: this.#consecutiveFailures,
      openedAtMs: this.#openedAtMs,
    };
  }
}
