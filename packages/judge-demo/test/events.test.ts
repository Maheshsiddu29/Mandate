/** The MANDATE_JUDGE_DEMO.V1 contract: exact amounts, JSON-ready values, sequencing and the presentation digest. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog, JUDGE_DEMO_SCHEMA, canonicalJson, decimalText, jsonOf, presentationDigest } from '../src/index.ts';

describe('the judge event contract', () => {
  it('writes amounts as exact decimal text, never a float', () => {
    assert.equal(decimalText(1_900_000_000n, 6), '1900');
    assert.equal(decimalText(200_400_000n, 6), '200.4');
    assert.equal(decimalText(1n, 6), '0.000001');
    assert.equal(decimalText(0n, 6), '0');
    assert.equal(decimalText(-2_500_000n, 6), '-2.5');
    assert.equal(decimalText(42n, 0), '42');
  });

  it('converts protocol values to JSON: bigints as decimal text, maps as objects; refuses what JSON cannot carry', () => {
    assert.deepEqual(jsonOf({ a: 2n ** 70n, b: [1n, 'x', null, true], c: new Map([['k', 3n]]), d: undefined }), { a: '1180591620717411303424', b: ['1', 'x', null, true], c: { k: '3' } });
    assert.throws(() => jsonOf({ f: () => 1 }));
    assert.throws(() => jsonOf(0.5));
  });

  it('canonical JSON does not depend on key order', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } }), canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 }));
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it('numbers events in order, tags the schema, and refuses to go back a scene', () => {
    const log = new EventLog();
    log.scene(1);
    log.emit({ kind: 'PORTFOLIO_CREATED', status: 'CREATED', message: 'one' });
    log.scene(3);
    const e = log.emit({ kind: 'RESOURCE_CONFLICT', status: 'CONFLICT', message: 'two', reasons: [{ code: 'X', subject: '' }] });
    assert.equal(e.sequence, 1);
    assert.equal(e.scene, 3);
    assert.equal(e.schema, JUDGE_DEMO_SCHEMA);
    assert.deepEqual([e.run, e.agent, e.proposal, e.requested, e.evidence], [null, null, null, [], null]);
    assert.throws(() => log.scene(2));
  });

  it('the presentation digest is deterministic and changes with any event', () => {
    const make = (message: string) => {
      const log = new EventLog();
      log.emit({ kind: 'PORTFOLIO_CREATED', status: 'CREATED', message, data: { n: '1' } });
      return log.events;
    };
    assert.equal(presentationDigest(make('a')), presentationDigest(make('a')));
    assert.notEqual(presentationDigest(make('a')), presentationDigest(make('b')));
    assert.match(presentationDigest(make('a')), /^0x[0-9a-f]{64}$/);
  });
});
