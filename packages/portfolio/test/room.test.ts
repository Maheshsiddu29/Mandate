/**
 * The Mandate Room: deterministic, bounded, authority-free coordination.
 * It accepts, refuses, asks to reduce, applies releases and reassigns lots —
 * and nothing else. Its output is only ever an input to the verifier.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { amountOf, entryOf, fullAvailability, runMandateRoom, validateAgentProposal, agentProposalInputOf, proposalDigest, proposalSigningHash, type AgentMessage, type RoomOutcome, type SignedProposal } from '../src/index.ts';
import { DEMO_T0, IMPOSTOR_COLLECTION, STOCK_LOOKALIKE, UNKNOWN_ROUTER, USDC, demoBindings, demoKey, demoMandate, demoParty, signPrehash } from '../src/demo/index.ts';
import { NOW, nftBuy, perpOpen, stockBuy, swap, yieldDeposit } from './support/candidates.ts';
import { ScriptedAgent, principalSignature, proposal, release } from './support/world.ts';

const m = demoMandate();
const bindings = demoBindings();
const run = (agents: ScriptedAgent[], o: { signature?: string; now?: bigint; mandate?: typeof m } = {}): RoomOutcome =>
  runMandateRoom({ mandate: o.mandate ?? m, signature: o.signature ?? principalSignature(o.mandate ?? m), bindings, availability: fullAvailability(o.mandate ?? m), now: o.now ?? NOW, agents });
const propose = (signed: SignedProposal): AgentMessage => ({ kind: 'PROPOSE', signed });
const outcomeOf = (o: RoomOutcome, role: string, round?: number) => o.decisions.filter((d) => d.agent === demoParty(role).value && (round === undefined || d.round === round)).map((d) => d.outcome);
const codesOf = (o: RoomOutcome, role: string) => [...new Set(o.decisions.filter((d) => d.agent === demoParty(role).value).flatMap((d) => d.reasons.map((r) => r.code)))].sort();

describe('the room will not coordinate under a mandate the principal did not sign, or out of its window', () => {
  it('refuses a missing or forged principal signature, an expired mandate and one not yet valid', () => {
    const forged = signPrehash(new Uint8Array(32), demoKey('stock'));
    assert.deepEqual(run([], { signature: forged }).reasons.map((r) => r.code), ['PORTFOLIO_MANDATE_SIGNATURE_INVALID']);
    assert.deepEqual(run([], { now: m.expiresAt }).reasons.map((r) => r.code), ['PORTFOLIO_MANDATE_EXPIRED']);
    assert.deepEqual(run([], { now: m.notBefore - 1n }).reasons.map((r) => r.code), ['PORTFOLIO_MANDATE_NOT_YET_VALID']);
    assert.equal(run([], { now: m.expiresAt }).status, 'REFUSED');
  });
});

describe('accept, reduce, reject', () => {
  it('a proposal its agent’s preferred allocation covers is accepted and committed', () => {
    const o = run([new ScriptedAgent('swap', [[1, propose(proposal(m, 'swap', swap({ amount: USDC(250n) })))]])]);
    assert.deepEqual(outcomeOf(o, 'swap'), ['ACCEPTED']);
    assert.equal(entryOf(o.book, demoParty('swap') as never, 'portfolio-notional')?.committed, USDC(250n));
    assert.equal(o.candidate.accepted.length, 1);
  });

  it('identity and scope failures are rejected with every reason, and cost nothing', () => {
    const o = run([
      new ScriptedAgent('stock', [[1, propose(proposal(m, 'stock', stockBuy({ representation: STOCK_LOOKALIKE })))]]),
      new ScriptedAgent('swap', [[1, propose(proposal(m, 'swap', swap({ router: UNKNOWN_ROUTER })))]]),
      new ScriptedAgent('nft', [[1, propose(proposal(m, 'nft', nftBuy({ collection: IMPOSTOR_COLLECTION })))]]),
    ]);
    assert.deepEqual(outcomeOf(o, 'stock'), ['REJECTED']);
    assert.ok(codesOf(o, 'stock').includes('REGISTRY:ISSUER_NOT_ALLOWED'));
    assert.deepEqual(codesOf(o, 'swap'), ['VENUE_NOT_ALLOWED']);
    assert.deepEqual(codesOf(o, 'nft'), ['ASSET_NOT_ALLOWED', 'REPRESENTATION_NOT_ALLOWED']);
    assert.equal(o.book.log.length, 0, 'no allocation moved');
    assert.equal(o.candidate.accepted.length, 0);
  });

  it('a locally valid action above a portfolio-wide limit is asked to reduce, with the most it could obtain', () => {
    const o = run([new ScriptedAgent('perps', [[1, propose(proposal(m, 'perps', perpOpen({ usdc: 600n }), { minimum: false }))]])]);
    const d = o.decisions[0];
    assert.equal(d?.outcome, 'REDUCE_REQUESTED');
    assert.deepEqual(d?.reasons, [{ code: 'PORTFOLIO_LIMIT_EXCEEDED', subject: 'derivative-notional' }]);
    assert.equal(amountOf(d?.target ?? [], 'derivative-notional'), USDC(400n));
  });

  it('a request needing more than the lots hold is asked to reduce to what they hold; below its minimum it is rejected', () => {
    // Yield holds 500 preferred and every other allocation is someone's: 700 cannot be covered.
    const o = run([new ScriptedAgent('yield', [[1, propose(proposal(m, 'yield', yieldDeposit({ amount: USDC(700n) }), { minimum: false }))]])]);
    assert.deepEqual(outcomeOf(o, 'yield'), ['REDUCE_REQUESTED']);
    assert.equal(amountOf(o.decisions[0]?.target ?? [], 'portfolio-notional'), USDC(500n));
    const strict = run([new ScriptedAgent('yield', [[1, propose(proposal(m, 'yield', yieldDeposit({ amount: USDC(700n) })))]])]);
    assert.deepEqual(outcomeOf(strict, 'yield'), ['REJECTED']);
    assert.ok(codesOf(strict, 'yield').includes('ALLOCATION_INSUFFICIENT'));
  });
});

describe('release and reassignment', () => {
  it('a released allocation is reassigned in the same round, by utility, never beyond it', () => {
    const o = run([
      new ScriptedAgent('nft', [[1, { kind: 'RELEASE', signed: release(m, 'nft', [['portfolio-notional', 250n]]) }]]),
      new ScriptedAgent('stock', [[1, propose(proposal(m, 'stock', stockBuy({ tenths: 48n }), { utilityBps: 900n }))]]),
      new ScriptedAgent('swap', [[1, propose(proposal(m, 'swap', swap({ amount: USDC(300n) }), { utilityBps: 800n }))]]),
      new ScriptedAgent('yield', [[1, propose(proposal(m, 'yield', yieldDeposit({ amount: USDC(700n) }), { utilityBps: 100n, minimum: false }))]]),
    ]);
    assert.deepEqual(o.releases.map((r) => r.applied), [true]);
    assert.deepEqual(outcomeOf(o, 'stock'), ['ACCEPTED']);
    assert.deepEqual(outcomeOf(o, 'swap'), ['ACCEPTED']);
    // 250 released − 100 (stock) − 50 (swap) = 100 left for yield: 500 + 100.
    assert.deepEqual(outcomeOf(o, 'yield'), ['REDUCE_REQUESTED']);
    assert.equal(amountOf(o.decisions.find((d) => d.agent === demoParty('yield').value)?.target ?? [], 'portfolio-notional'), USDC(600n));
    const lot = o.book.lots.find((l) => l.from !== null && l.resource === 'portfolio-notional');
    assert.equal(lot?.remaining, USDC(100n));
  });

  it('with the order of utility reversed, the lot goes the other way — ranking orders claims, it does not create any', () => {
    const o = run([
      new ScriptedAgent('nft', [[1, { kind: 'RELEASE', signed: release(m, 'nft', [['portfolio-notional', 250n]]) }]]),
      new ScriptedAgent('stock', [[1, propose(proposal(m, 'stock', stockBuy({ tenths: 48n }), { utilityBps: 100n, minimum: false }))]]),
      new ScriptedAgent('yield', [[1, propose(proposal(m, 'yield', yieldDeposit({ amount: USDC(700n) }), { utilityBps: 900n }))]]),
    ]);
    assert.deepEqual(outcomeOf(o, 'yield'), ['ACCEPTED']);
    assert.deepEqual(outcomeOf(o, 'stock'), ['REDUCE_REQUESTED']);
    assert.equal(o.book.lots.find((l) => l.from !== null)?.remaining, USDC(50n));
  });

  it('a double release, a forged release and a release of more than is unused are refused', () => {
    const r1 = release(m, 'nft', [['portfolio-notional', 100n]], 1n);
    const forged = { release: release(m, 'nft', [['portfolio-notional', 100n]], 2n).release, signature: release(m, 'stock', [['portfolio-notional', 100n]], 2n).signature };
    const o = run([
      new ScriptedAgent('nft', [[1, { kind: 'RELEASE', signed: r1 }], [2, { kind: 'RELEASE', signed: r1 }], [3, { kind: 'RELEASE', signed: forged }], [4, { kind: 'RELEASE', signed: release(m, 'nft', [['portfolio-notional', 151n]], 5n) }]]),
    ]);
    assert.deepEqual(o.releases.map((r) => [r.round, r.applied, r.reasons.map((x) => x.code).join(',')]), [
      [1, true, ''],
      [2, false, 'RELEASE_ALREADY_APPLIED'],
      [3, false, 'AGENT_SIGNATURE_INVALID'],
      [4, false, 'RELEASE_EXCEEDS_UNUSED'],
    ]);
  });
});

describe('authentication and replay in the room', () => {
  it('an outsider’s proposal is AGENT_UNKNOWN; a proposal signed by another agent’s key is AGENT_SIGNATURE_INVALID', () => {
    const own = proposal(m, 'swap', swap());
    const outsider = validateAgentProposal({ ...agentProposalInputOf(own.proposal), agent: demoParty('outsider') });
    assert.ok(outsider.ok);
    const signedByOutsider = { proposal: outsider.value, signature: signPrehash(proposalSigningHash(proposalDigest(outsider.value)), demoKey('outsider')) };
    const wrongKey = { proposal: own.proposal, signature: signPrehash(proposalSigningHash(proposalDigest(own.proposal)), demoKey('stock')) };
    const o = run([new ScriptedAgent('outsider', [[1, propose(signedByOutsider)]]), new ScriptedAgent('swap', [[1, propose(wrongKey)]])]);
    assert.deepEqual(codesOf(o, 'outsider'), ['AGENT_UNKNOWN']);
    assert.deepEqual(codesOf(o, 'swap'), ['AGENT_SIGNATURE_INVALID']);
  });

  it('an agent cannot speak for another: a swap agent relaying the stock agent’s proposal is refused', () => {
    const stockSigned = proposal(m, 'stock', stockBuy());
    const o = run([new ScriptedAgent('swap', [[1, propose(stockSigned)]])]);
    assert.deepEqual(o.decisions.map((d) => d.reasons.map((r) => r.code)), [['AGENT_SIGNATURE_INVALID']]);
  });

  it('the same proposal twice, and an older sequence, are PROPOSAL_REPLAYED', () => {
    const p2 = proposal(m, 'swap', swap({ amount: USDC(100n) }), { sequence: 2n });
    const p1 = proposal(m, 'swap', swap({ amount: USDC(101n) }), { sequence: 1n });
    const o = run([new ScriptedAgent('swap', [[1, propose(p2)], [2, propose(p2)], [3, propose(p1)]])]);
    assert.deepEqual(o.decisions.map((d) => [d.round, d.outcome, d.reasons.map((r) => r.code).join(',')]), [
      [1, 'ACCEPTED', ''],
      [2, 'REJECTED', 'PROPOSAL_REPLAYED'],
      [3, 'REJECTED', 'PROPOSAL_REPLAYED'],
    ]);
  });

  it('stale proposals, unknown critical extensions, misdeclared demand and an impossible minimum are refused by name', () => {
    const stale = proposal(m, 'swap', swap(), { expiresAt: NOW });
    const base = proposal(m, 'yield', yieldDeposit({ amount: USDC(100n) }));
    const withExt = validateAgentProposal({ ...agentProposalInputOf(base.proposal), criticalExtensions: ['mev-protection'] });
    const understated = validateAgentProposal({ ...agentProposalInputOf(base.proposal), sequence: 2n, requested: [{ resource: 'portfolio-notional', atoms: 1n }], minimum: [] });
    const minimum = validateAgentProposal({ ...agentProposalInputOf(base.proposal), sequence: 3n, minimum: [{ resource: 'portfolio-notional', atoms: USDC(101n) }] });
    assert.ok(withExt.ok && understated.ok && minimum.ok);
    const sign = (p: typeof withExt.value) => ({ proposal: p, signature: signPrehash(proposalSigningHash(proposalDigest(p)), demoKey('yield')) });
    const o = run([
      new ScriptedAgent('swap', [[1, propose(stale)]]),
      new ScriptedAgent('yield', [[1, propose(sign(withExt.value))], [2, propose(sign(understated.value))], [3, propose(sign(minimum.value))]]),
    ]);
    assert.deepEqual(codesOf(o, 'swap'), ['PROPOSAL_EXPIRED']);
    assert.deepEqual(o.decisions.filter((d) => d.agent === demoParty('yield').value).map((d) => d.reasons.map((r) => r.code).join(',')), ['PROPOSAL_EXTENSION_UNKNOWN', 'PROPOSAL_RESOURCES_MISDECLARED', 'PROPOSAL_MINIMUM_INVALID']);
  });

  it('a proposal bound to another mandate is PORTFOLIO_MANDATE_DIGEST_MISMATCH', () => {
    const other = demoMandate({ nonce: 2n });
    const o = run([new ScriptedAgent('swap', [[1, propose(proposal(other, 'swap', swap()))]])]);
    assert.deepEqual(codesOf(o, 'swap'), ['PORTFOLIO_MANDATE_DIGEST_MISMATCH']);
  });
});

describe('determinism and bounds', () => {
  it('the order agents are listed in never changes the outcome', () => {
    const agents = () => [
      new ScriptedAgent('nft', [[1, { kind: 'RELEASE', signed: release(m, 'nft', [['portfolio-notional', 250n]]) }]]),
      new ScriptedAgent('stock', [[1, propose(proposal(m, 'stock', stockBuy(), { utilityBps: 5n }))]]),
      new ScriptedAgent('swap', [[1, propose(proposal(m, 'swap', swap({ amount: USDC(300n) }), { utilityBps: 5n }))]]),
      new ScriptedAgent('yield', [[1, propose(proposal(m, 'yield', yieldDeposit({ amount: USDC(700n) }), { utilityBps: 5n, minimum: false }))]]),
    ];
    const a = run(agents());
    const b = run(agents().reverse());
    assert.deepEqual(b.decisions, a.decisions);
    assert.deepEqual(b.candidate, a.candidate);
  });

  it('stops after a round in which every agent idles, and never runs past its bound', () => {
    assert.equal(run([new ScriptedAgent('swap', [])]).rounds, 0);
    const chatty = new ScriptedAgent('swap', Array.from({ length: 20 }, (_, i) => [i + 1, propose(proposal(m, 'swap', swap({ amount: BigInt(i + 1) * 1_000_000n }), { sequence: BigInt(i + 1) }))] as const));
    assert.equal(run([chatty]).rounds, 8);
  });

  it('a coalition of all five agents at their hard maxima cannot take more than the principal allowed', () => {
    const o = run([
      new ScriptedAgent('stock', [[1, propose(proposal(m, 'stock', stockBuy({ tenths: 64n }), { minimum: false }))]]),
      new ScriptedAgent('swap', [[1, propose(proposal(m, 'swap', swap({ amount: USDC(500n) }), { minimum: false }))]]),
      new ScriptedAgent('nft', [[1, propose(proposal(m, 'nft', nftBuy({ price: USDC(400n) }), { minimum: false }))]]),
      new ScriptedAgent('yield', [[1, propose(proposal(m, 'yield', yieldDeposit({ amount: USDC(800n) }), { minimum: false }))]]),
      new ScriptedAgent('perps', [[1, propose(proposal(m, 'perps', perpOpen({ usdc: 400n }), { minimum: false }))]]),
    ]);
    const committed = o.book.entries.filter((e) => e.resource === 'portfolio-notional').reduce((s, e) => s + e.committed, 0n);
    assert.ok(committed <= USDC(2_000n), `committed ${committed}`);
    for (const e of o.book.entries) assert.ok(e.committed <= e.allocated);
    assert.ok(o.decisions.some((d) => d.outcome !== 'ACCEPTED'), 'somebody was held back');
    assert.equal(o.candidate.accepted.length, o.decisions.filter((d) => d.outcome === 'ACCEPTED').length);
    assert.equal(DEMO_T0 < NOW, true);
  });
});
