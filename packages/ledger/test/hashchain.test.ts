/**
 * The event log's canonical encoding and hash chain (authority-ledger.md
 * §13): the same history always yields the same head; any change to order,
 * content or membership yields a different one; stored batches replay to the
 * same state; and a replay refuses anything that does not extend the chain.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reservationIdFor, type AuthorityGrant, type LedgerHeadDigest } from '@mandate/core';
import {
  applyBatch,
  decodeBatch,
  encodeBatch,
  encodeLedgerEvent,
  encodeLedgerState,
  genesisHead,
  replay,
  replayEncoded,
  type LedgerEvent,
  type LedgerState,
} from '../src/index.ts';
import { AGENT_A, AGENT_B, ALL_MODULES, DELEGATE, PRINCIPAL, PRINCIPAL_2, T0, capital, child, contribution, dim, plan, policy, revocation, root, units } from './support/grants.ts';
import { closeEvent, consumeEvent, genesis, reservationOf, reserveEvent, restoreEvent, step } from './support/steps.ts';

const r = root({ holder: AGENT_A, terms: [ALL_MODULES, DELEGATE(1), dim('capital', units(1_000))] });
const c = child(r, { holder: AGENT_B, terms: [ALL_MODULES, dim('capital', units(500))] });
const reg = (g: AuthorityGrant, at = T0): LedgerEvent => ({ kind: 'REGISTER_GRANT', at, grant: g });
const pol = (sequence = 1n): LedgerEvent => ({ kind: 'REGISTER_POLICY', at: T0, policy: policy([dim('global', units(800))], sequence) });

/** A history exercising every event kind, as batches. */
function history(): LedgerEvent[][] {
  const batches: LedgerEvent[][] = [[pol()], [reg(r), reg(c)]];
  let s = replayOk(batches);
  const p = plan({ authority: c, contributions: [contribution(capital(units(100)))] });
  batches.push([reserveEvent(s, p)]);
  s = replayOk(batches);
  const rec = reservationOf(s, reservationIdFor(p.action, p.generation));
  batches.push([consumeEvent(rec, [units(60)]), closeEvent({ ...rec, demands: rec.demands.map((d) => ({ ...d, consumed: units(60) })) })]);
  s = replayOk(batches);
  batches.push([restoreEvent(reservationOf(s, rec.id), [units(20)])]);
  batches.push([{ kind: 'REVOKE', at: T0, revocation: revocation(c, AGENT_A) }]);
  return batches;
}

function replayOk(batches: readonly (readonly LedgerEvent[])[]): LedgerState {
  const s = replay(PRINCIPAL, batches);
  if (!s.ok) assert.fail(`${s.error.code} at ${s.error.path}`);
  return s.value;
}

function encoded(batches: readonly (readonly LedgerEvent[])[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let s = genesis();
  for (const b of batches) {
    const r0 = applyBatch(s, b);
    assert.ok(r0.ok);
    out.push(r0.value.encoded);
    s = r0.value.state;
  }
  return out;
}

describe('hash chain', () => {
  it('the same history always yields the same head and the same state', () => {
    const x = replayOk(history());
    const y = replayOk(history());
    assert.equal(x.head, y.head);
    assert.equal(x.version, 6n);
    assert.deepEqual(encodeLedgerState(x), encodeLedgerState(y));
  });

  it('a different order of events yields a different head', () => {
    const b1 = root({ holder: AGENT_A, nonce: 1n });
    const b2 = root({ holder: AGENT_B, nonce: 2n });
    const x = replayOk([[pol()], [reg(b1), reg(b2)]]);
    const y = replayOk([[pol()], [reg(b2), reg(b1)]]);
    assert.notEqual(x.head, y.head);
    // …even though the graph they describe is the same.
    assert.deepEqual(x.nodes.sortedKeys(), y.nodes.sortedKeys());
  });

  it('a different payload in any event yields a different head', () => {
    const base = replayOk([[pol()], [reg(root({ nonce: 1n }))]]);
    assert.notEqual(replayOk([[pol()], [reg(root({ nonce: 2n }))]]).head, base.head);
    assert.notEqual(replayOk([[pol()], [reg(root({ nonce: 1n }), T0 + 1n)]]).head, base.head);
    assert.notEqual(replayOk([[pol(2n)], [reg(root({ nonce: 1n }))]]).head, base.head);
  });

  it('removing or inserting an event, or moving a batch boundary, yields a different head', () => {
    const b1 = root({ holder: AGENT_A, nonce: 1n });
    const b2 = root({ holder: AGENT_B, nonce: 2n });
    const full = replayOk([[pol()], [reg(b1), reg(b2)]]);
    assert.notEqual(replayOk([[pol()], [reg(b1)]]).head, full.head);
    assert.notEqual(replayOk([[pol()], [reg(b1)], [reg(b2)]]).head, full.head);
    assert.notEqual(replayOk([[pol(), reg(b1), reg(b2)]]).head, full.head);
  });

  it('every principal has its own genesis, so equal histories of two principals never share a head', () => {
    assert.notEqual(genesisHead(PRINCIPAL), genesisHead(PRINCIPAL_2));
    const x = replayOk([[pol()]]);
    const y = replay(PRINCIPAL_2, [[{ kind: 'REGISTER_POLICY', at: T0, policy: policy([], 1n, { kind: PRINCIPAL_2.kind, value: PRINCIPAL_2.value }) }]]);
    assert.ok(y.ok);
    assert.notEqual(x.head, y.value.head);
  });

  it('each head is the keccak-256 of a batch that commits to principal, version and previous head', () => {
    const batches = history();
    const bytes = encoded(batches);
    let previous: LedgerHeadDigest = genesisHead(PRINCIPAL);
    for (let i = 0; i < bytes.length; i += 1) {
      const d = decodeBatch(bytes[i] as Uint8Array);
      assert.ok(d.ok);
      assert.equal(d.value.version, BigInt(i + 1));
      assert.equal(d.value.previousHead, previous);
      assert.deepEqual(encodeBatch(d.value.principal, d.value.version, d.value.previousHead, d.value.events), bytes[i]);
      previous = replayOk(batches.slice(0, i + 1)).head;
    }
  });
});

describe('replay from the stored log', () => {
  it('decodes every event kind canonically and replays to the identical state', () => {
    const batches = history();
    const incremental = replayOk(batches);
    const fromBytes = replayEncoded(PRINCIPAL, encoded(batches));
    assert.ok(fromBytes.ok);
    assert.deepEqual(encodeLedgerState(fromBytes.value), encodeLedgerState(incremental));
    const kinds = new Set(batches.flat().map((e) => e.kind));
    assert.deepEqual([...kinds].sort(), ['CLOSE', 'CONSUME', 'REGISTER_GRANT', 'REGISTER_POLICY', 'RESERVE', 'RESTORE', 'REVOKE']);
    for (const e of batches.flat()) assert.ok(encodeLedgerEvent(e).length > 0);
  });

  it('refuses a batch that does not extend the chain, is for another principal, skips a version or was altered', () => {
    const bytes = encoded(history());
    const code = (bs: Uint8Array[]): string => {
      const out = replayEncoded(PRINCIPAL, bs);
      return out.ok ? 'OK' : out.error.code;
    };
    assert.equal(code(bytes), 'OK');
    assert.equal(code([bytes[0] as Uint8Array, bytes[2] as Uint8Array]), 'LEDGER_CHAIN_BROKEN'); // a removed batch
    assert.equal(code([bytes[1] as Uint8Array]), 'LEDGER_CHAIN_BROKEN'); // not from genesis
    const other = replayEncoded(PRINCIPAL_2, bytes.slice(0, 1));
    assert.ok(!other.ok && other.error.code === 'LEDGER_CHAIN_BROKEN');
    // Flip one byte in every position of the second batch: never silently accepted as the original history.
    const original = replayOk(history());
    const target = bytes[1] as Uint8Array;
    for (let i = 0; i < target.length; i += 1) {
      const t = target.slice();
      t[i] = (t[i] as number) ^ 0x01;
      const out = replayEncoded(PRINCIPAL, [bytes[0] as Uint8Array, t, ...bytes.slice(2)]);
      assert.ok(!out.ok || out.value.head !== original.head, `byte ${i}`);
    }
  });

  it('refuses a stored batch with trailing bytes or a wrong tag', () => {
    const b = (encoded(history())[0] as Uint8Array);
    const trailing = new Uint8Array(b.length + 1);
    trailing.set(b);
    const t = decodeBatch(trailing);
    assert.ok(!t.ok && t.error.code === 'ENCODING_TRAILING_BYTES');
    const wrong = b.slice();
    wrong[5] = (wrong[5] as number) ^ 0x20;
    assert.equal(decodeBatch(wrong).ok, false);
  });

  it('a refused event anywhere in a batch leaves the whole batch unapplied', () => {
    const s = step(genesis(), [pol()]);
    const bad = applyBatch(s, [reg(r), reg(c), reg(c)]); // the duplicate is refused…
    assert.ok(!bad.ok && bad.error.code === 'AUTHORITY_ALREADY_REGISTERED' && bad.error.path.startsWith('events[2]'));
    // …and neither of the valid registrations before it exists. (The input state is immutable.)
    assert.equal(s.nodes.size, 0);
    assert.equal(s.version, 1n);
    const empty = applyBatch(s, []);
    assert.ok(!empty.ok && empty.error.code === 'BATCH_EMPTY');
    const huge = applyBatch(s, Array.from({ length: 257 }, () => pol(2n)));
    assert.ok(!huge.ok && huge.error.code === 'BATCH_TOO_LARGE');
  });
});
