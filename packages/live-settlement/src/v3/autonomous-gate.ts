/**
 * V3 autonomous settlement gate — distinct from V2 SendGate.
 *
 * Authority is the human-signed reusable V3 delegation. It does not accept the
 * V2 browser Execute intent or the CLI send phrase. Local pause clears the
 * ability to produce new delegate signatures without claiming onchain revoke.
 */

export type AutonomousGateState = 'ARMED' | 'PAUSED' | 'DISARMED';

export class AutonomousSettlementGate {
  #state: AutonomousGateState = 'DISARMED';

  get state(): AutonomousGateState {
    return this.#state;
  }

  /** Arm only after a verified V3 principal delegation is active in-process. */
  arm(): void {
    this.#state = 'ARMED';
  }

  /** Local pause: stop new delegate signatures immediately. */
  pause(): void {
    if (this.#state === 'ARMED') this.#state = 'PAUSED';
  }

  resume(): void {
    if (this.#state === 'PAUSED') this.#state = 'ARMED';
  }

  disarm(): void {
    this.#state = 'DISARMED';
  }

  /** True when automatic settlement may request a Mandate delegate signature. */
  mayAuthorizeExecution(): boolean {
    return this.#state === 'ARMED';
  }
}
