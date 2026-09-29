/**
 * The Portfolio Verifier trusts nothing the room produced; the receipt is
 * canonical. A room — honest, buggy or compromised — cannot create
 * authority: whatever it hands over is re-derived from signed inputs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  amountOf,
  defaultExecutor,
  fullAvailability,
  portfolioMandateDigest,
  proposalDigest,
  runMandateRoom,
  runPortfolio,
  verifyPortfolio,
  type AgentMessage,
  type AllocationOp,
  type PortfolioCandidate,
  type RoomOutcome,
  type SignedProposal,
  type VerifierInput,
} from '../src/index.ts';
import { STOCK_LOOKALIKE, USDC, demoBindings, demoMandate, demoParty } from '../src/demo/index.ts';
import { NOW, nftBuy, perpOpen, stockBuy, swap, yieldDeposit } from './support/candidates.ts';
import { ScriptedAgent, principalSignature, proposal, release, world } from './support/world.ts';

const m = demoMandate();
const bindings = demoBindings();
const propose = (signed: SignedProposal): AgentMessage => ({ kind: 'PROPOSE', signed });
const codes = (r: ReturnType<typeof verifyPortfolio>) => (r.status === 'REFUSED' ? [...new Set(r.reasons.map((x) => x.code))].sort() : []);

/** A short honest negotiation: NFT releases, stock and swap claim from it, a look-alike is refused. */
function honest(): { room: RoomOutcome; input: VerifierInput } {
  const agents = [
    new ScriptedAgent('nft', [[1, { kind: 'RELEASE', signed: release(m, 'nft', [['portfolio-notional', 250n]]) }]]),
    new ScriptedAgent('stock', [[1, propose(proposal(m, 'stock', stockBuy({ representation: STOCK_LOOKALIKE }), { sequence: 1n }))], [2, propose(proposal(m, 'stock', stockBuy({ tenths: 48n }), { sequence: 2n, utilityBps: 900n }))]]),
    new ScriptedAgent('swap', [[2, propose(proposal(m, 'swap', swap({ amount: USDC(300n) }), { utilityBps: 800n }))]]),
  ];
  const room = runMandateRoom({ mandate: m, signature: principalSignature(m), bindings, availability: fullAvailability(m), now: NOW, agents });
  return { room, input: { mandate: m, signature: principalSignature(m), bindings, availability: fullAvailability(m), now: NOW, candidate: room.candidate, proposals: room.proposals, releases: room.signedReleases } };
}

const tampered = (input: VerifierInput, candidate: Partial<PortfolioCandidate>): VerifierInput => ({ ...input, candidate: { ...input.candidate, ...candidate } });

describe('the verifier re-derives an honest room', () => {
  it('verifies the room’s candidate and derives one child per accepted proposal, in canonical order', () => {
    const { room, input } = honest();
    assert.equal(room.candidate.accepted.length, 2);
    const v = verifyPortfolio(input);
    assert.equal(v.status, 'VERIFIED');
    assert.ok(v.status === 'VERIFIED');
    assert.equal(v.children.length, 2);
    assert.deepEqual(v.children.map((c) => c.digest), [...v.children.map((c) => c.digest)].sort());
    assert.equal(amountOf(v.approved, 'portfolio-notional'), USDC(900n));
  });

  it('refuses outright under a forged principal signature or an expired mandate', () => {
    const { input } = honest();
    assert.deepEqual(codes(verifyPortfolio({ ...input, signature: release(m, 'stock', [['portfolio-notional', 1n]]).signature })), ['PORTFOLIO_MANDATE_SIGNATURE_INVALID']);
    assert.deepEqual(codes(verifyPortfolio({ ...input, now: m.expiresAt })), ['PORTFOLIO_MANDATE_EXPIRED']);
  });
});

describe('the room cannot create authority', () => {
  it('a proposal the room “accepts” that the rules refuse is refused by the verifier with the rules’ own reasons', () => {
    const { room, input } = honest();
    const lookalike = room.decisions.find((d) => d.outcome === 'REJECTED');
    assert.ok(lookalike !== undefined);
    const r = verifyPortfolio(tampered(input, { accepted: [...input.candidate.accepted, lookalike.proposal].sort() }));
    assert.ok(codes(r).some((c) => c.startsWith('REGISTRY:')), JSON.stringify(codes(r)));
  });

  it('duplicated and unknown proposals in the candidate are refused', () => {
    const { input } = honest();
    const first = input.candidate.accepted[0] as string;
    assert.ok(codes(verifyPortfolio(tampered(input, { accepted: [first, first, ...input.candidate.accepted.slice(1)] as never }))).includes('CANDIDATE_PROPOSAL_DUPLICATED'));
    assert.ok(codes(verifyPortfolio(tampered(input, { accepted: [...input.candidate.accepted, `0x${'ab'.repeat(32)}`] as never }))).includes('CANDIDATE_PROPOSAL_UNKNOWN'));
  });

  it('an allocation log the rules forbid is refused: over-claiming a lot, a commit that differs from the demand, a release nobody signed, a missing commit', () => {
    const { input } = honest();
    const log = input.candidate.allocationLog;
    const claim = log.find((op) => op.kind === 'CLAIM') as Extract<AllocationOp, { kind: 'CLAIM' }>;
    const overClaim = log.map((op) => (op === claim ? { ...claim, amount: claim.amount + USDC(1_000n) } : op));
    assert.ok(codes(verifyPortfolio(tampered(input, { allocationLog: overClaim }))).includes('CANDIDATE_BOOK_MISMATCH'));
    const commit = log.find((op) => op.kind === 'COMMIT') as Extract<AllocationOp, { kind: 'COMMIT' }>;
    const bigger = log.map((op) => (op === commit ? { ...commit, amounts: commit.amounts.map((a) => ({ ...a, atoms: a.atoms - 1n })) } : op));
    const r1 = verifyPortfolio(tampered(input, { allocationLog: bigger }));
    assert.ok(r1.status === 'REFUSED' && r1.reasons.some((x) => x.subject.startsWith('commit-amount')), JSON.stringify(codes(r1)));
    const forgedRelease: AllocationOp = { kind: 'RELEASE', agent: demoParty('yield') as never, id: 'release/forged' as never, amounts: [{ resource: 'portfolio-notional', atoms: USDC(500n) }] as never };
    const r2 = verifyPortfolio({ ...tampered(input, { allocationLog: [forgedRelease, ...log] }) });
    assert.ok(r2.status === 'REFUSED' && r2.reasons.some((x) => x.subject.startsWith('release-unsigned')));
    const r3 = verifyPortfolio(tampered(input, { allocationLog: log.filter((op) => op !== commit) }));
    assert.ok(r3.status === 'REFUSED' && r3.reasons.some((x) => x.subject.startsWith('commit-missing')));
  });

  it('a forged coalition candidate — all five agents at their hard maxima, “accepted” — is refused', () => {
    const coalition = [
      proposal(m, 'stock', stockBuy({ tenths: 64n })),
      proposal(m, 'swap', swap({ amount: USDC(500n) })),
      proposal(m, 'nft', nftBuy({ price: USDC(400n) })),
      proposal(m, 'yield', yieldDeposit({ amount: USDC(800n) })),
      proposal(m, 'perps', perpOpen({ usdc: 400n })),
    ];
    const log: AllocationOp[] = coalition.map((s) => ({ kind: 'COMMIT', agent: s.proposal.agent, id: proposalDigest(s.proposal) as never, amounts: s.proposal.requested }));
    const r = verifyPortfolio({ mandate: m, signature: principalSignature(m), bindings, availability: fullAvailability(m), now: NOW, candidate: { portfolioMandate: portfolioMandateDigest(m), accepted: coalition.map((s) => proposalDigest(s.proposal)).sort(), allocationLog: log }, proposals: coalition, releases: [] });
    assert.equal(r.status, 'REFUSED');
    assert.ok(codes(r).includes('CANDIDATE_BOOK_MISMATCH'));
  });

  it('what the ledger no longer has room for is refused even when the room thought it had', () => {
    const { input } = honest();
    const tight = { ...input.availability, portfolio: input.availability.portfolio.map((a) => (a.resource === 'portfolio-notional' ? { ...a, atoms: USDC(800n) } : a)) };
    assert.ok(codes(verifyPortfolio({ ...input, availability: tight })).includes('PORTFOLIO_LIMIT_EXCEEDED'));
  });
});

describe('the receipt', () => {
  const agents = () => [
    new ScriptedAgent('nft', [[1, { kind: 'RELEASE', signed: release(m, 'nft', [['portfolio-notional', 250n]]) }]]),
    new ScriptedAgent('stock', [[1, propose(proposal(m, 'stock', stockBuy({ tenths: 48n }), { utilityBps: 900n }))]]),
    new ScriptedAgent('swap', [[1, propose(proposal(m, 'swap', swap({ amount: USDC(300n) }), { utilityBps: 800n }))]]),
    new ScriptedAgent('yield', [[1, propose(proposal(m, 'yield', yieldDeposit({ amount: USDC(450n) })))]]),
  ];

  it('is deterministic: two independent runs over fresh ledgers produce the same digest', async () => {
    const a = await world();
    const b = await world();
    const ra = await runPortfolio({ core: a.core, signature: principalSignature(m), now: NOW, agents: agents(), execute: defaultExecutor(a.core) });
    const rb = await runPortfolio({ core: b.core, signature: principalSignature(m), now: NOW, agents: agents().reverse(), execute: defaultExecutor(b.core) });
    assert.equal(ra.digest, rb.digest);
    assert.equal(ra.receipt.transactions, 0);
    assert.deepEqual(ra.receipt.executions.map((e) => e.status).sort(), ['AWAITING_DOMAIN_SIGNER', 'SETTLED', 'SETTLED']);
  });

  it('the order of the candidate’s selections and of the proposals cannot change what is verified', () => {
    const { input } = honest();
    const forward = verifyPortfolio(input);
    const reversed = verifyPortfolio({ ...input, candidate: { ...input.candidate, accepted: [...input.candidate.accepted].reverse() }, proposals: [...input.proposals].reverse(), releases: [...input.releases].reverse() });
    assert.deepEqual(reversed, forward);
  });

  it('records every refusal as an offchain refusal with zero transactions', async () => {
    const w = await world();
    const r = await runPortfolio({ core: w.core, signature: principalSignature(m), now: NOW, agents: [new ScriptedAgent('stock', [[1, propose(proposal(m, 'stock', stockBuy({ representation: STOCK_LOOKALIKE })))]])], execute: defaultExecutor(w.core) });
    assert.deepEqual(r.receipt.decisions.map((d) => [d.outcome, d.refusal]), [['REJECTED', 'OFFCHAIN_REFUSAL']]);
    assert.equal(r.receipt.transactions, 0);
    assert.deepEqual(r.receipt.representationDecisions.map((x) => x.status), ['EXCLUDED']);
    assert.equal(r.receipt.agents.find((a) => a.label === 'stock')?.status, 'BLOCKED');
  });
});
