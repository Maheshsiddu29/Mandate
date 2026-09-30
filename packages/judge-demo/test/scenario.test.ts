/**
 * Scenes 1–3 against the canonical run they narrate: the same five agents,
 * the same signed proposals, the same screening, the same receipt as the
 * committed Phase 7F demonstration corpus.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addVectors, amountOf, portfolioMandateDigest, proposalDigest, screenProposal, type ResourceVector } from '@mandate/portfolio';
import { DEMO_OPPORTUNITIES, USDC } from '@mandate/portfolio/demo';
import { INITIAL_TIME, ROLES, runJudgeDemo, type JudgeEvent } from '../src/index.ts';

const demo = runJudgeDemo();
const of = (events: readonly JudgeEvent[], kind: string) => events.filter((e) => e.kind === kind);
const corpus = JSON.parse(readFileSync(new URL('../../../corpus/portfolio-demo-v1/receipt.json', import.meta.url), 'utf8')) as { receiptDigest: string };

describe('scenes 1–3: the canonical portfolio', () => {
  it('runs the canonical demonstration itself: its receipt is the committed corpus receipt', async () => {
    const { protocol } = await demo;
    assert.equal(protocol.initial.digest, corpus.receiptDigest);
  });

  it('1 — one Portfolio Mandate, five agents, with the mandate’s own limits and digest', async () => {
    const { protocol, transcript } = await demo;
    const [created] = of(transcript.events, 'PORTFOLIO_CREATED');
    assert.ok(created !== undefined);
    assert.equal(created.sequence, 0);
    const m = protocol.mandate;
    assert.equal(m.agents.length, 5);
    assert.deepEqual(m.agents.map((a) => a.label).sort(), [...ROLES].sort());
    assert.equal(created.artifacts.find((a) => a.name === 'portfolioMandateDigest')?.value, portfolioMandateDigest(m));
    assert.equal(created.data['principalSignatureValid'], true);
    assert.deepEqual(created.data['mandateRefusals'], []);
    assert.equal(created.data['allocationMode'], m.allocationMode);
    assert.deepEqual((created.data['agents'] as readonly { label: string }[]).map((a) => a.label).sort(), [...ROLES].sort());
    assert.equal(amountOf(m.limits, 'portfolio-notional'), USDC(2_000n));
  });

  it('2 — five agents search, each with a real signed proposal, in the story’s order', async () => {
    const { transcript } = await demo;
    assert.deepEqual(of(transcript.events, 'AGENT_SEARCH_STARTED').map((e) => e.agent?.label), [...ROLES]);
    for (const e of of(transcript.events, 'PROPOSAL_DISCOVERED')) {
      assert.equal(e.data['signatureValid'], true, e.message);
      assert.equal(e.data['agentIsMember'], true, e.message);
    }
    for (const role of ROLES) assert.equal(of(transcript.events, 'AGENT_SEARCH_STARTED').find((e) => e.agent?.label === role)?.data['candidatesFound'], DEMO_OPPORTUNITIES[role]?.length);
  });

  it('the initial requests derive from the canonical data: 2,550 against 2,000', async () => {
    const { protocol, transcript } = await demo;
    const firstRound = protocol.initial.room.proposals.filter((s) => protocol.initial.room.decisions.find((d) => d.proposal === proposalDigest(s.proposal))?.round === 1);
    const total = firstRound.reduce<ResourceVector>((v, s) => addVectors(v, s.proposal.requested), []);
    assert.equal(amountOf(total, 'portfolio-notional'), USDC(2_550n));
    const opportunities = ROLES.reduce((s, r) => s + (DEMO_OPPORTUNITIES[r]?.[0]?.size ?? 0n), 0n);
    assert.equal(amountOf(total, 'portfolio-notional'), opportunities);
    const [conflict] = of(transcript.events, 'RESOURCE_CONFLICT');
    assert.deepEqual((conflict?.data['initialRequested'] as readonly { resource: string; atoms: string }[]).find((a) => a.resource === 'portfolio-notional')?.atoms, USDC(2_550n).toString());
  });

  it('every blocked proposal carries the real screening codes, and the room rejected it with exactly those', async () => {
    const { protocol, transcript } = await demo;
    const blocked = of(transcript.events, 'PROPOSAL_BLOCKED');
    assert.deepEqual(blocked.map((e) => [e.agent?.label, [...new Set(e.reasons.map((r) => r.code))].sort().join(',')]), [
      ['stock', 'REGISTRY:ISSUER_NOT_ALLOWED,REGISTRY:SYNTHETIC_NOT_ALLOWED'],
      ['swap', 'VENUE_NOT_ALLOWED'],
      ['nft', 'ASSET_NOT_ALLOWED,REPRESENTATION_NOT_ALLOWED'],
      ['yield', 'ASSET_NOT_ALLOWED,ISSUER_NOT_ALLOWED,REPRESENTATION_NOT_ALLOWED,VENUE_NOT_ALLOWED'],
    ]);
    for (const e of blocked) {
      const signed = protocol.initial.room.proposals.find((s) => proposalDigest(s.proposal) === e.proposal);
      assert.ok(signed !== undefined);
      const s = screenProposal(protocol.mandate, protocol.core.compiled.bindings, signed, INITIAL_TIME);
      assert.deepEqual(e.reasons, s.reasons.map((r) => ({ code: r.code, subject: r.subject })));
      assert.equal(s.quantityOnly, false);
      const d = protocol.initial.room.decisions.find((x) => x.proposal === e.proposal);
      assert.equal(d?.outcome, 'REJECTED');
      assert.equal(e.data['negotiated'], false);
      assert.equal(e.data['transactions'], 0);
    }
    const stock = blocked[0];
    assert.equal((stock?.data['registry'] as { status: string } | null)?.status, 'EXCLUDED');
    assert.match(stock?.message ?? '', /ticker is never identity/);
    assert.match(blocked[1]?.message ?? '', /better quote/);
    assert.match(blocked[3]?.message ?? '', /advertised APY/);
    assert.doesNotMatch(transcript.events.map((e) => e.message).join('\n'), /guaranteed (?!return)|guarantees/i);
  });

  it('perps is locally valid and in resource conflict — not blocked, not malicious; NFT has no compliant opportunity', async () => {
    const { transcript } = await demo;
    const perps = of(transcript.events, 'PROPOSAL_ADMISSIBLE').find((e) => e.agent?.label === 'perps');
    assert.equal(perps?.status, 'CONFLICT');
    assert.equal(perps?.data['verdict'], 'LOCALLY_VALID_RESOURCE_CONFLICT');
    assert.deepEqual(perps?.reasons.map((r) => r.code), ['PORTFOLIO_LIMIT_EXCEEDED']);
    assert.doesNotMatch(perps?.message ?? '', /BLOCKED/);
    assert.match(perps?.message ?? '', /LOCALLY VALID.*Not malicious/);
    assert.deepEqual(of(transcript.events, 'AGENT_NO_COMPLIANT_OPPORTUNITY').map((e) => e.agent?.label), ['nft']);
  });

  it('3 — the admissible demand exceeds the authority: a resource conflict, computed from the derived demands', async () => {
    const { protocol, transcript } = await demo;
    const [conflict] = of(transcript.events, 'RESOURCE_CONFLICT');
    assert.ok(conflict !== undefined);
    assert.equal(conflict.scene, 3);
    const exceeding = conflict.data['exceeding'] as readonly { resource: string; demand: string; limit: string }[];
    assert.deepEqual(exceeding.map((x) => [x.resource, x.demand, x.limit]), [
      ['portfolio-notional', USDC(2_200n).toString(), USDC(2_000n).toString()],
      ['derivative-notional', USDC(600n).toString(), USDC(400n).toString()],
    ]);
    assert.equal(amountOf(protocol.initial.before.portfolio, 'portfolio-notional'), USDC(2_000n));
    assert.equal(of(transcript.events, 'PORTFOLIO_BLOCKED' as never).length, 0);
  });
});
