/**
 * The transcript is a deterministic function of the canonical inputs:
 * same events, order, reason codes, results, receipts and bytes, in one
 * process and across processes. It carries no wall clock, no bigint, no
 * private key, and running it touches no network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { DEMO_ROLES, demoKey } from '@mandate/portfolio/demo';
import { EVENT_KINDS, EVENT_STATUSES, JUDGE_DEMO_SCHEMA, SCENES, presentationDigest, renderText } from '../src/index.ts';
import { judgeDemo } from './support/demo.ts';

const REPO = new URL('../../../', import.meta.url);
const script = (json: boolean) => execFileSync(process.execPath, ['packages/judge-demo/scripts/judge-demo.ts', ...(json ? ['--json'] : [])], { cwd: REPO, encoding: 'utf8', env: {} });

describe('determinism', () => {
  it('two runs in one process produce the same transcript, event for event', async () => {
    const [a, b] = await Promise.all([judgeDemo(), judgeDemo()]);
    assert.deepEqual(a.transcript, b.transcript);
    assert.equal(a.transcript.presentationDigest, presentationDigest(b.transcript.events));
    assert.equal(a.transcript.events.length, b.transcript.events.length);
    assert.deepEqual(a.transcript.events.map((e) => e.reasons), b.transcript.events.map((e) => e.reasons));
    assert.deepEqual([a.protocol.initial.digest, a.protocol.attack.digest, a.protocol.compliant.digest, a.protocol.conflict.digest], [b.protocol.initial.digest, b.protocol.attack.digest, b.protocol.compliant.digest, b.protocol.conflict.digest]);
  });

  it('the runner prints byte-identical output across processes, and the JSON is the transcript', async () => {
    const first = script(true);
    assert.equal(script(true), first);
    const { transcript } = await judgeDemo();
    assert.deepEqual(JSON.parse(first), JSON.parse(JSON.stringify(transcript)));
    assert.equal(script(false), renderText(transcript));
  });

  it('events are well formed: contiguous sequence, scenes 1–10 in order, closed kinds and statuses, logical time only', async () => {
    const { transcript } = await judgeDemo();
    const events = transcript.events;
    assert.deepEqual(events.map((e) => e.sequence), events.map((_, i) => i));
    assert.deepEqual([...new Set(events.map((e) => e.scene))], SCENES.map((s) => s.scene));
    for (const e of events) {
      assert.equal(e.schema, JUDGE_DEMO_SCHEMA);
      assert.ok((EVENT_KINDS as readonly string[]).includes(e.kind), e.kind);
      assert.ok((EVENT_STATUSES as readonly string[]).includes(e.status), e.status);
      if (e.protocolTime !== null) assert.match(e.protocolTime, /^[0-9]+$/);
    }
    const text = JSON.stringify(transcript);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'no wall-clock timestamp');
    assert.equal(events[0]?.kind, 'PORTFOLIO_CREATED');
    assert.equal(events[events.length - 1]?.kind, 'DEMO_COMPLETED');
  });

  it('no private key appears in the transcript, the JSON or the text output', async () => {
    const outputs = [script(true), script(false), JSON.stringify((await judgeDemo()).transcript)].map((s) => s.toLowerCase());
    const keys = DEMO_ROLES.map((r) => demoKey(r).toLowerCase().replace(/^0x/, ''));
    const disposable = new URL('.robinhood-testnet/keys.json', REPO);
    if (existsSync(disposable)) {
      const recorded = JSON.parse(readFileSync(disposable, 'utf8')) as { [role: string]: { privateKey?: string } };
      for (const k of Object.values(recorded)) if (typeof k.privateKey === 'string') keys.push(k.privateKey.toLowerCase().replace(/^0x/, ''));
    }
    for (const out of outputs) for (const k of keys) assert.ok(!out.includes(k), 'a private key leaked into the output');
  });

  it('the default demo is offline and sends nothing: network access would throw, and every run records 0 transactions', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error('the judge demo attempted network access');
    };
    try {
      const { protocol, transcript } = await judgeDemo();
      for (const r of [protocol.initial, protocol.attack, protocol.compliant, protocol.conflict]) {
        assert.equal(r.receipt.transactions, 0);
        for (const e of r.executions) assert.equal(e.transactions, 0);
      }
      assert.equal(transcript.events.find((e) => e.kind === 'DEMO_COMPLETED')?.data['transactions'], 0);
    } finally {
      globalThis.fetch = real;
    }
  });
});
