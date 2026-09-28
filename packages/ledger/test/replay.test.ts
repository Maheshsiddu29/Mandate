/**
 * LEDGER-6: every balance equals the fold of the event log from genesis.
 *
 * For randomized histories (the model generator's, run through the engine),
 * the state the store maintained incrementally is byte-identical to a full
 * replay of the stored events, to a full replay of the stored batch
 * encodings, and — at every tenth step — to a replay of the log up to that
 * version. Independently of replay, the cached target balances equal a
 * recomputation from the reservation records they summarize.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeLedgerState, rescaleExact, replay, replayEncoded, type LedgerState } from '../src/index.ts';
import { PRINCIPAL } from './support/grants.ts';
import { drive } from './support/drive.ts';

function recomputedTargets(s: LedgerState): Map<string, [bigint, bigint, bigint]> {
  const out = new Map<string, [bigint, bigint, bigint]>();
  for (const key of s.targets.sortedKeys()) out.set(key, [0n, 0n, 0n]);
  for (const r of s.reservations.values()) {
    for (const d of r.demands) {
      for (const l of d.legs) {
        const scale = (x: bigint): bigint => rescaleExact(x, d.contribution.quantity.decimals, l.decimals) as bigint;
        const t = out.get(l.key) as [bigint, bigint, bigint];
        if (r.status === 'ACTIVE') t[0] += scale(d.reserved - d.consumed);
        t[1] += scale(d.consumed);
        if (l.capacity) t[2] += scale(d.restored);
      }
    }
  }
  return out;
}

describe('replay equals incremental state', () => {
  it('from events, from stored bytes, and at every tenth version, for randomized histories', async () => {
    let versions = 0;
    for (let seed = 101; seed <= 130; seed += 1) {
      const checkpoints: { version: bigint; bytes: Uint8Array; head: string }[] = [];
      const run = await drive(seed, 100, (step) => {
        if (step.index % 10 === 0) checkpoints.push({ version: step.after.version, bytes: encodeLedgerState(step.after.state), head: step.after.head });
      });
      const final = await run.store.read(PRINCIPAL);
      const history = await run.store.history(PRINCIPAL);
      assert.equal(BigInt(history.length), final.version);
      versions += history.length;

      const fromEvents = replay(PRINCIPAL, history.map((b) => b.events));
      assert.ok(fromEvents.ok, `seed ${seed}`);
      assert.deepEqual(encodeLedgerState(fromEvents.value), encodeLedgerState(final.state), `seed ${seed}`);

      const fromBytes = replayEncoded(PRINCIPAL, history.map((b) => b.encoded));
      assert.ok(fromBytes.ok, `seed ${seed}`);
      assert.deepEqual(encodeLedgerState(fromBytes.value), encodeLedgerState(final.state), `seed ${seed}`);
      assert.equal(fromBytes.value.head, final.head);

      for (const c of checkpoints) {
        const prefix = replay(PRINCIPAL, history.slice(0, Number(c.version)).map((b) => b.events));
        assert.ok(prefix.ok);
        assert.equal(prefix.value.head, c.head, `seed ${seed} v${c.version}`);
        assert.deepEqual(encodeLedgerState(prefix.value), c.bytes, `seed ${seed} v${c.version}`);
      }

      // The cached balances are exactly the sum of what the reservation records say.
      const recomputed = recomputedTargets(final.state);
      for (const [key, [reserved, consumed, restored]] of recomputed) {
        const t = final.state.targets.get(key);
        assert.ok(t !== undefined);
        assert.deepEqual([t.reserved, t.consumed, t.restored], [reserved, consumed, restored], `seed ${seed} ${key}`);
      }
    }
    assert.ok(versions > 1_000, `only ${versions} committed versions replayed`);
  });
});
