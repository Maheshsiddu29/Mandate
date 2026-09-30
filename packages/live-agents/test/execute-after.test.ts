/**
 * `executeAfter: 0n` (B.5, re-examined in B.5.2): live runs execute at the
 * reservation instant. Does any protocol security property need
 * `executeAfter > now`? No — and these tests pin down why.
 *
 * `executeAfter` is `runPortfolio`'s scheduling offset: the protocol time at
 * which the domain executor admits its attempt. The only time rules the
 * protocol applies there are (a) the ledger never accepts an event earlier
 * than its latest one (`at < lastAt` → EVALUATION_TIME_REGRESSED; equal is
 * accepted), and (b) an attempt must fall before the authorization's
 * ceiling (`t >= validUntil` → AUTHORIZATION_EXPIRED). Neither has a lower
 * bound: nothing requires a delay between reservation and attempt. The
 * judge demo's 5 s is a narrative gap in a scripted timeline, and a
 * positive offset in a live session is what breaks the ledger's time order.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPortfolio, type SignedProposal } from '@mandate/portfolio';
import { LIVE_EXECUTE_AFTER_SECONDS, FixedProposalStrategy, countingExecutor } from '../src/mandate/portfolio-adapter.ts';
import { buildProposal } from '../src/mandate/proposal-builder.ts';
import { DOMAIN_AGENTS } from '../src/agents/index.ts';
import type { LiveSession } from '../src/session.ts';
import { abstain, propose, scriptedSession } from './support/session.ts';

function signedSwap(session: LiveSession, atoms: bigint, sequence: bigint, now: bigint): SignedProposal {
  const active = session.versions.active;
  if (active === null) assert.fail('no active version');
  const signer = session.signers.get('swap');
  const c = DOMAIN_AGENTS.swap.candidates.find((x) => x.id === 'route-a');
  if (signer === undefined || c === undefined) assert.fail('no swap agent');
  const b = buildProposal({ mandate: active.mandate, bindings: active.compiled.bindings, agent: signer.party, candidate: c.build(atoms, now), sizeAtoms: atoms, minimumAtoms: atoms, sequence, now });
  if (!b.ok) assert.fail(b.error);
  return signer.sign(b.proposal);
}

describe('executeAfter = 0 in live runs', () => {
  it('is the value the live path uses', () => {
    assert.equal(LIVE_EXECUTE_AFTER_SECONDS, 0n);
  });

  it('an attempt admitted at the reservation instant is accepted: the fixture child settles (SIMULATED) with 0 transactions', async () => {
    const s = await scriptedSession({ swap: { text: propose('route-a', 200) }, stock: { text: abstain } });
    const run = await s.session.run();
    assert.equal(run.status, 'AUTHORIZED');
    const [authorized] = s.of('PORTFOLIO_AUTHORIZED');
    assert.deepEqual(authorized?.data['executions'], [{ status: 'SETTLED', evidence: 'SIMULATED', integration: 'swap-fixture.v1' }]);
    assert.equal(run.transactions, 0);
  });

  it('a positive offset puts a ledger event in the future: the next reservation inside it is refused EVALUATION_TIME_REGRESSED', async () => {
    const s = await scriptedSession({ stock: { text: abstain } }, undefined, {});
    await s.session.run();
    const active = s.session.versions.active;
    if (active === null) assert.fail('no active version');
    const now = s.time.now;
    const first = await runPortfolio({ core: active.core, signature: active.signature, now, agents: [new FixedProposalStrategy(signedSwap(s.session, 100_000_000n, 90n, now))], execute: countingExecutor(active.core).execute, executeAfter: 5n });
    assert.equal(first.reservations[0]?.status, 'RESERVED');
    const second = await runPortfolio({ core: active.core, signature: active.signature, now: now + 1n, agents: [new FixedProposalStrategy(signedSwap(s.session, 100_000_000n, 91n, now + 1n))], execute: countingExecutor(active.core).execute, executeAfter: 0n });
    assert.equal(second.reservations[0]?.status, 'REFUSED');
    assert.match(second.reservations[0]?.reasons.map((r) => r.code).join(',') ?? '', /EVALUATION_TIME_REGRESSED/);
  });

  it('with the live offset of 0 the same sequence reserves both', async () => {
    const s = await scriptedSession({ stock: { text: abstain } });
    await s.session.run();
    const active = s.session.versions.active;
    if (active === null) assert.fail('no active version');
    const now = s.time.now;
    const first = await runPortfolio({ core: active.core, signature: active.signature, now, agents: [new FixedProposalStrategy(signedSwap(s.session, 100_000_000n, 90n, now))], execute: countingExecutor(active.core).execute, executeAfter: LIVE_EXECUTE_AFTER_SECONDS });
    const second = await runPortfolio({ core: active.core, signature: active.signature, now: now + 1n, agents: [new FixedProposalStrategy(signedSwap(s.session, 100_000_000n, 91n, now + 1n))], execute: countingExecutor(active.core).execute, executeAfter: LIVE_EXECUTE_AFTER_SECONDS });
    assert.equal(first.reservations[0]?.status, 'RESERVED');
    assert.equal(second.reservations[0]?.status, 'RESERVED');
  });
});
