/**
 * The control world plus what 7E.1 issuance tests need: seeded store jitter
 * for concurrency, and re-exports. Deterministic and offline.
 */

import type { InMemoryStoreHooks } from '@mandate/ledger';
import { int, prng, ticks } from './builders.ts';

export * from './world.ts';

/** Random read/commit delays from a fixed seed, so concurrent calls interleave reproducibly. */
export function jitter(seed: number, maxTicks = 3): InMemoryStoreHooks {
  const rand = prng(seed);
  return { delay: () => ticks(int(rand, 0, maxTicks)) };
}
