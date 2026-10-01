/**
 * Randomness — the only module in this package that reads it.
 *
 * Used for identifiers that must be unguessable and unique across server
 * restarts: session ids and the one-time challenges a principal's wallet
 * signs. Tests substitute a deterministic source.
 */

import { randomBytes } from 'node:crypto';

export interface Entropy {
  /** 32 cryptographically random bytes, 0x-prefixed lowercase hex. */
  bytes32(): string;
}

export const realEntropy: Entropy = {
  bytes32: () => `0x${randomBytes(32).toString('hex')}`,
};

/** Deterministic, for tests: each call returns the next counter value as 32 bytes. */
export class CountingEntropy implements Entropy {
  #n = 0n;
  readonly #salt: bigint;

  constructor(salt = 0n) {
    this.#salt = salt;
  }

  bytes32(): string {
    this.#n += 1n;
    return `0x${((this.#salt << 128n) + this.#n).toString(16).padStart(64, '0')}`;
  }
}
