/**
 * Scenes 4–5 against the real Room, verifier and ledger: every negotiation
 * event is one the Room recorded, security-invalid proposals never enter
 * it, the Room creates no authority, and what the demo calls reserved is
 * what the ledger holds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addVectors, amountOf, releaseDigest, verifyTranscript, type ResourceVector } from '@mandate/portfolio';
import { USDC, demoParty } from '@mandate/portfolio/demo';
import { claimsByCommit, type JudgeEvent } from '../src/index.ts';
import { judgeDemo } from './support/demo.ts';

const demo = judgeDemo();
const scene = (events: readonly JudgeEvent[], n: number, kind?: string) => events.filter((e) => e.scene === n && (kind === undefined || e.kind === kind));

describe('scene 4: the Mandate Room', () => {
  it('security-invalid proposals never enter negotiation, and the Room never accepted one', async () => {
    const { protocol, transcript } = await demo;
    const blocked = new Set(transcript.events.filter((e) => e.kind === 'PROPOSAL_BLOCKED').map((e) => e.proposal));
    assert.equal(blocked.size, 4);
    for (const e of scene(transcript.events, 4)) assert.ok(!blocked.has(e.proposal), `${e.kind} ${e.proposal}`);
    for (const d of protocol.initial.room.candidate.accepted) assert.ok(!blocked.has(d));
    const [opened] = scene(transcript.events, 4, 'MANDATE_ROOM_OPENED');
    assert.deepEqual([...(opened?.data['excludedAtScreening'] as readonly string[])].sort(), [...blocked].sort());
  });

  it('the resource conflict enters the Room: perps and yield are asked to reduce, by the Room’s own decisions', async () => {
    const { protocol, transcript } = await demo;
    const asked = scene(transcript.events, 4, 'AGENT_REDUCTION_REQUESTED');
    const decided = protocol.initial.room.decisions.filter((d) => d.outcome === 'REDUCE_REQUESTED');
    assert.deepEqual(asked.map((e) => e.proposal), decided.map((d) => d.proposal));
    assert.deepEqual(asked.map((e) => [e.agent?.label, e.round, e.reasons.map((r) => r.code).join()]), [
      ['perps', 1, 'PORTFOLIO_LIMIT_EXCEEDED'],
      ['yield', 2, 'ALLOCATION_INSUFFICIENT'],
    ]);
    for (const [i, e] of asked.entries()) assert.deepEqual(e.approved.map((a) => [a.resource, a.atoms]), (decided[i]?.target ?? []).map((t) => [t.resource, t.atoms.toString()]));
  });

  it('release, reduction and reassignment events are exactly the Room’s releases, resubmissions and CLAIM operations', async () => {
    const { protocol, transcript } = await demo;
    const room = protocol.initial.room;
    const released = scene(transcript.events, 4, 'AGENT_RELEASED_AUTHORITY');
    assert.deepEqual(released.map((e) => [e.agent?.label, e.round, e.artifacts[0]?.value]), room.releases.map((r) => ['nft', r.round, r.release]));
    const signed = room.signedReleases[0];
    assert.ok(signed !== undefined && releaseDigest(signed.release) === room.releases[0]?.release);
    assert.deepEqual(released[0]?.approved.map((a) => [a.resource, a.atoms]), signed.release.amounts.map((a) => [a.resource, a.atoms.toString()]));

    const reduced = scene(transcript.events, 4, 'AGENT_PROPOSAL_REDUCED');
    assert.deepEqual(reduced.map((e) => [e.agent?.label, (e.data['from'] as readonly { atoms: string; resource: string }[]).find((a) => a.resource === 'portfolio-notional')?.atoms, (e.data['to'] as readonly { atoms: string; resource: string }[]).find((a) => a.resource === 'portfolio-notional')?.atoms]), [
      ['perps', USDC(600n).toString(), USDC(400n).toString()],
      ['yield', USDC(700n).toString(), USDC(600n).toString()],
    ]);

    const claims = [...claimsByCommit(room.candidate.allocationLog).values()].flat();
    const reallocated = scene(transcript.events, 4, 'AUTHORITY_REALLOCATED');
    assert.deepEqual(reallocated.map((e) => e.data['claim']), claims.map((c) => c.id));
    // NFT's released 250 is reassigned exactly once: 100 + 50 + 100.
    const fromNft = reallocated.filter((e) => e.data['from'] === 'nft' && e.data['resource'] === 'portfolio-notional');
    assert.deepEqual(fromNft.map((e) => [e.agent?.label, e.data['atoms']]), [['stock', USDC(100n).toString()], ['swap', USDC(50n).toString()], ['yield', USDC(100n).toString()]]);
    assert.equal(fromNft.reduce((s, e) => s + BigInt(e.data['atoms'] as string), 0n), amountOf(signed.release.amounts, 'portfolio-notional'));
  });

  it('the Room creates no authority: what it proposes fits the mandate, and a forged acceptance is refused by the verifier', async () => {
    const { protocol, transcript } = await demo;
    const [proposed] = scene(transcript.events, 4, 'MANDATE_ROOM_PROPOSED_PORTFOLIO');
    assert.equal(proposed?.data['authorized'], false);
    const accepted = protocol.initial.room.decisions.filter((d) => d.outcome === 'ACCEPTED').reduce<ResourceVector>((v, d) => addVectors(v, d.demand), []);
    for (const a of accepted) assert.ok(a.atoms <= amountOf(protocol.mandate.limits, a.resource), a.resource);
    assert.equal(proposed?.approved.find((a) => a.resource === 'portfolio-notional')?.atoms, USDC(1_900n).toString());
    for (const e of scene(transcript.events, 4, 'PROPOSAL_ACCEPTED')) assert.equal(e.data['authorized'], false);

    const forgery = protocol.roomForgery;
    assert.ok(forgery !== null && forgery.result.status === 'REFUSED');
    const [refused] = transcript.events.filter((e) => e.kind === 'ROOM_FORGERY_REFUSED');
    assert.equal(refused?.status, 'REFUSED');
    assert.ok(refused?.reasons.some((r) => r.code === 'REGISTRY:ISSUER_NOT_ALLOWED'));
  });
});

describe('scene 5: independent reverification and reservation', () => {
  it('the proposed portfolio is re-verified from signed inputs alone, and every checklist line passes', async () => {
    const { protocol, transcript } = await demo;
    const again = verifyTranscript(protocol.mandate, protocol.core.compiled.bindings, protocol.initialTranscript);
    assert.equal(again.status, 'VERIFIED');
    assert.equal(protocol.initial.verification.status, 'VERIFIED');
    const [list] = scene(transcript.events, 5, 'VERIFIER_CHECKLIST');
    const items = list?.data['checklist'] as readonly { id: string; result: string }[];
    assert.ok(items.length >= 15);
    assert.deepEqual(items.filter((i) => i.result !== 'PASS'), []);
    for (const id of ['mandate', 'authentication', 'identity', 'venue-recipient', 'quote-freshness', 'resources', 'child-subset', 'candidate-binding', 'allocation-replay', 'releases-signed', 'claims-exact', 'global-limits', 'agent-limits', 'replay-identity', 'verdict', 'reservation-eligibility']) {
      assert.ok(items.some((i) => i.id === id), id);
    }
  });

  it('children and reservations are the verifier’s and the ledger’s: 1,900 of 2,000 reserved, 100 available', async () => {
    const { protocol, transcript } = await demo;
    const v = protocol.initial.verification;
    assert.ok(v.status === 'VERIFIED');
    assert.deepEqual(scene(transcript.events, 5, 'CHILD_AUTHORIZATION_CREATED').map((e) => e.artifacts[0]?.value), v.children.map((c) => c.digest));
    const reserved = scene(transcript.events, 5, 'RESOURCE_RESERVED');
    assert.equal(reserved.length, 4);
    const state = protocol.afterInitial.state;
    for (const e of reserved) {
      assert.equal(e.status, 'RESERVED');
      const id = e.artifacts.find((a) => a.name === 'reservation')?.value;
      const r = [...state.reservations.values()].find((x) => x.id === id);
      assert.ok(r !== undefined && r.status === 'ACTIVE', `reservation ${id}`);
      assert.equal(r.generation, 1n);
    }
    assert.equal(state.reservations.size, 4);
    const [auth] = scene(transcript.events, 5, 'PORTFOLIO_AUTHORIZED');
    assert.equal(auth?.status, 'AUTHORIZED');
    const pick = (k: string) => (auth?.data[k] as readonly { resource: string; atoms: string }[]).find((a) => a.resource === 'portfolio-notional')?.atoms;
    assert.equal(pick('reservedAfter'), USDC(1_900n).toString());
    assert.equal(pick('availableAfter'), USDC(100n).toString());
    assert.equal(pick('requested'), USDC(2_550n).toString());
    assert.deepEqual([auth?.data['children'], auth?.data['rejected'], auth?.data['adjusted'], auth?.data['transactions']], [4, 4, 2, 0]);
    assert.equal(amountOf(protocol.initial.after.reserved, 'portfolio-notional'), USDC(1_900n));
  });

  it('replay: the same verified children are refused by the ledger itself, and the ledger does not move', async () => {
    const { protocol, transcript } = await demo;
    assert.equal(protocol.replay.length, 4);
    for (const p of protocol.replay) {
      assert.equal(p.outcome, 'REFUSED');
      assert.ok(p.reasons.some((r) => r.code === 'LEDGER:REQUEST_INVALID/RESERVATION_EXISTS'), JSON.stringify(p.reasons));
    }
    assert.equal(protocol.afterReplay.version, protocol.afterInitial.version);
    assert.equal(transcript.events.find((e) => e.kind === 'REPLAY_REFUSED')?.status, 'REFUSED');
  });

  it('execution: fixtures are SIMULATED, stock and perps are handed to their signers, nothing is sent', async () => {
    const { transcript } = await demo;
    const handoffs = scene(transcript.events, 5, 'EXECUTION_HANDOFF');
    const byLabel = new Map(handoffs.map((e) => [e.agent?.label, e]));
    assert.deepEqual([byLabel.get('swap')?.evidence, byLabel.get('yield')?.evidence], ['SIMULATED', 'SIMULATED']);
    assert.deepEqual([byLabel.get('stock')?.evidence, byLabel.get('perps')?.evidence], ['OFFCHAIN_ONLY', 'OFFCHAIN_ONLY']);
    assert.equal(byLabel.get('stock')?.data['executionStatus'], 'AWAITING_DOMAIN_SIGNER');
    assert.equal(byLabel.get('stock')?.data['integrationEvidence'], 'LIVE_TESTNET');
    for (const e of handoffs) assert.equal(e.data['transactions'], 0);
    assert.equal(demoParty('stock').value, byLabel.get('stock')?.agent?.id);
  });
});
