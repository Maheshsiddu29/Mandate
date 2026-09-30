import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIVE_EVENT_KINDS, LIVE_SCHEMA, type LiveEvent } from '../src/telemetry/events.ts';
import { containsKey } from './support/world.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/live.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function run(args: readonly string[], env: { readonly [k: string]: string | undefined } = {}) {
  const base = { ...process.env };
  delete base['OPENAI_API_KEY'];
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000 });
}

describe('the command-line runner', () => {
  it('agents:stub --json prints the whole MANDATE_LIVE_AI.V1 stream, in order, with no key', () => {
    const r = run(['--provider=stub', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as LiveEvent);
    assert.deepEqual(events.map((e) => e.sequence), events.map((_, i) => i));
    assert.ok(events.every((e) => e.schema === LIVE_SCHEMA && (LIVE_EVENT_KINDS as readonly string[]).includes(e.kind)));
    assert.equal(events[0]?.kind, 'SESSION_STARTED');
    assert.equal(events.at(-1)?.kind, 'SESSION_COMPLETED');
    for (const k of ['PROPOSAL_BLOCKED', 'ROOM_FINALIZED', 'PORTFOLIO_AUTHORIZED', 'POLICY_STRESS_PROPOSAL_BLOCKED', 'POLICY_STRESS_PROPOSAL_AUTHORIZED']) assert.ok(events.some((e) => e.kind === k), k);
    assert.equal(containsKey(r.stdout), false);
  });

  it('the live mode refuses to run without OPENAI_API_KEY and exits 2', () => {
    const r = run(['--provider=openai']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /OPENAI_API_KEY is not set/);
    assert.equal(r.stdout.includes('SESSION_STARTED'), false);
  });

  it('a prompt with unresolved issues is never authorized: exit 3', () => {
    const r = run(['--provider=stub', '--prompt=Deploy everything but keep $500 free, only safe stocks']);
    assert.equal(r.status, 3, r.stderr);
    assert.doesNotMatch(r.stdout, /MANDATE_VERSION_AUTHORIZED/);
  });
});
