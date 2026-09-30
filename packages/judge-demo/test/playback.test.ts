/** Judge-mode controls are a cursor over a finished transcript: no protocol state, no timer. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DemoPlayback, EventLog } from '../src/index.ts';

function events(n: number) {
  const log = new EventLog();
  for (let i = 0; i < n; i += 1) log.emit({ kind: 'PORTFOLIO_CREATED', status: 'INFO', message: `e${i}` });
  return log.events;
}

describe('judge-mode playback', () => {
  it('start, pause, resume, next and restart walk the same events in the same order', () => {
    const p = new DemoPlayback(events(3));
    assert.equal(p.state, 'IDLE');
    p.start();
    assert.equal(p.state, 'PLAYING');
    assert.equal(p.next()?.message, 'e0');
    p.pause();
    assert.equal(p.state, 'PAUSED');
    assert.equal(p.next()?.message, 'e1', 'single-step while paused');
    p.resume();
    assert.equal(p.state, 'PLAYING');
    assert.equal(p.next()?.message, 'e2');
    assert.equal(p.state, 'FINISHED');
    assert.equal(p.next(), null);
    assert.deepEqual(p.shown.map((e) => e.sequence), [0, 1, 2]);
    p.restart();
    assert.deepEqual([p.state, p.position], ['IDLE', 0]);
    assert.equal(p.next()?.message, 'e0', 'stepping from idle starts paused');
    assert.equal(p.state, 'PAUSED');
  });

  it('pause and resume are no-ops in the wrong state; an empty transcript finishes at once', () => {
    const p = new DemoPlayback(events(1));
    p.resume();
    assert.equal(p.state, 'IDLE');
    p.pause();
    assert.equal(p.state, 'IDLE');
    const empty = new DemoPlayback([]);
    empty.start();
    assert.equal(empty.state, 'FINISHED');
    assert.equal(empty.next(), null);
  });
});
