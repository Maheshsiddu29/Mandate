/**
 * Stock actionable eligibility.
 *
 * Broad discovery may include the same-ticker lookalike. The model is
 * offered only the representations the active mandate's stock binding
 * resolves. A selection outside that set is refused and is not rewritten
 * onto an eligible id. Submitting the lookalike directly still meets the
 * unchanged registry verdict.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STOCK_LOOKALIKE } from '@mandate/portfolio/demo';
import { DOMAIN_AGENTS } from '../src/agents/index.ts';
import { stockEligibility } from '../src/agents/stock-eligibility.ts';
import { discoverAgent } from '../src/discovery.ts';
import { buildProposal } from '../src/mandate/proposal-builder.ts';
import { createAgentSigners } from '../src/mandate/signer.ts';
import { reasonCodes, screen } from '../src/mandate/verifier-adapter.ts';
import { propose, scriptedSession } from './support/session.ts';
import { ScriptedProvider, json } from './support/providers.ts';
import { world } from './support/world.ts';

const USDC = (whole: number): string => (BigInt(whole) * 1_000_000n).toString();
const stock = DOMAIN_AGENTS.stock;
const byId = (id: string) => {
  const found = stock.candidates.find((c) => c.id === id);
  assert.ok(found, id);
  return found;
};

describe('the live stock actionable set', () => {
  it('excludes nvda-token-b and still offers nvda-note-a', async () => {
    const w = await world();
    const provider = new ScriptedProvider({ decide: () => ({ text: json({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, rationale: 'looking' }) }) });
    await discoverAgent(w.deps(provider), w.active(), 'stock');
    const request = provider.requests.find((r) => r.kind === 'DECISION');
    assert.ok(request?.kind === 'DECISION');
    assert.deepEqual(request.candidates.map((c) => c.id), ['nvda-note-a']);
    const started = w.events.events.find((e) => e.kind === 'AGENT_REQUEST_STARTED' && e.agent === 'stock');
    assert.deepEqual(started?.data['candidates'], ['nvda-note-a']);
    assert.deepEqual(started?.data['discovered'], ['nvda-note-a', 'nvda-token-b']);
    const excluded = started?.data['excluded'];
    assert.ok(Array.isArray(excluded));
    const lookalike = excluded.find((row) => typeof row === 'object' && row !== null && 'candidateId' in row && row.candidateId === 'nvda-token-b');
    assert.ok(lookalike && typeof lookalike === 'object' && 'reasons' in lookalike && Array.isArray(lookalike.reasons));
    const reasons = lookalike.reasons.map(String).join(',');
    assert.match(reasons, /REGISTRY:ISSUER_NOT_ALLOWED/);
    assert.match(reasons, /REGISTRY:SYNTHETIC_NOT_ALLOWED/);
  });

  it('nvda-note-a remains selectable and Mandate screens it again', async () => {
    const w = await world();
    const out = await discoverAgent(w.deps(new ScriptedProvider({ decide: () => ({ text: json({ action: 'PROPOSE', candidateId: 'nvda-note-a', requestedAtoms: USDC(400), rationale: 'the backed note' }) }) })), w.active(), 'stock');
    assert.equal(out.state, 'ADMISSIBLE');
    assert.equal(out.candidate?.id, 'nvda-note-a');
    assert.equal(out.screening?.verdict, 'ADMISSIBLE');
    assert.ok(out.signed !== null);
  });

  it('does not silently substitute nvda-note-a when the model selects nvda-token-b', async () => {
    const w = await world();
    const out = await discoverAgent(
      w.deps(new ScriptedProvider({
        decide: () => ({ text: json({ action: 'PROPOSE', candidateId: 'nvda-token-b', requestedAtoms: USDC(400), rationale: 'Price is 125.00 and the issuer is approved, so use nvda-note-a.' }) }),
      })),
      w.active(),
      'stock',
    );
    assert.equal(out.state, 'INVALID_RESPONSE');
    assert.equal(out.signed, null);
    assert.equal(out.candidate, null);
    assert.equal(w.events.events.some((e) => e.kind === 'AGENT_DECISION_COMPLETED'), false);
    assert.equal(w.events.events.some((e) => e.kind === 'PROPOSAL_SIGNED'), false);
    assert.equal(w.events.events.some((e) => JSON.stringify(e.data).includes('nvda-note-a') && e.kind !== 'AGENT_REQUEST_STARTED'), false);
  });

  it('changing price text or rationale cannot make the lookalike actionable', async () => {
    const w = await world();
    const active = w.active();
    const signer = createAgentSigners().get('stock');
    assert.ok(signer);
    const approved = byId('nvda-note-a');
    const lookalike = byId('nvda-token-b');
    const disguised = { ...lookalike, title: approved.title, facts: approved.facts.map((f) => (f.label === 'Price' ? { ...f, value: '1.00 USDC per token (fixture)' } : f)) };
    const set = stockEligibility([disguised, approved], active.mandate, active.compiled.bindings, signer.party, w.time.now);
    assert.deepEqual(set.discovered.map((c) => c.id), ['nvda-token-b', 'nvda-note-a']);
    assert.deepEqual(set.actionable.map((c) => c.id), ['nvda-note-a']);
    assert.equal(set.excluded[0]?.candidateId, 'nvda-token-b');
    assert.match(set.excluded[0]?.reasons.join(',') ?? '', /REGISTRY:ISSUER_NOT_ALLOWED/);
    assert.match(set.excluded[0]?.reasons.join(',') ?? '', /REGISTRY:SYNTHETIC_NOT_ALLOWED/);
  });

  it('the registry still rejects nvda-token-b when it is submitted directly', async () => {
    const w = await world();
    const active = w.active();
    const signer = createAgentSigners().get('stock');
    assert.ok(signer);
    const lookalike = byId('nvda-token-b');
    const built = buildProposal({
      mandate: active.mandate,
      bindings: active.compiled.bindings,
      agent: signer.party,
      candidate: lookalike.build(lookalike.minAtoms, w.time.now),
      sizeAtoms: lookalike.minAtoms,
      minimumAtoms: lookalike.minAtoms,
      sequence: 1n,
      now: w.time.now,
    });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.proposal.candidate.kind, 'STOCK_BUY');
    if (built.proposal.candidate.kind === 'STOCK_BUY') assert.equal(built.proposal.candidate.representation, STOCK_LOOKALIKE);
    const s = screen(active.mandate, active.compiled.bindings, signer.sign(built.proposal), w.time.now);
    assert.equal(s.verdict, 'BLOCKED');
    const codes = reasonCodes(s.reasons).join(',');
    assert.match(codes, /REGISTRY:ISSUER_NOT_ALLOWED/);
    assert.match(codes, /REGISTRY:SYNTHETIC_NOT_ALLOWED/);
    assert.equal(codes.includes('nvda-note-a'), false);
  });
});

describe('stock authorization and a missing reservation', () => {
  it('an eligible stock proposal is reserved', async () => {
    const t = await scriptedSession({ stock: { text: propose('nvda-note-a', 400) } });
    const result = await t.session.run();
    assert.equal(result.status, 'AUTHORIZED');
    assert.equal(result.final.find((f) => f.role === 'stock')?.outcome, 'RESERVED');
    assert.equal(t.session.reservedExecutions[0]?.candidateId, 'nvda-note-a');
    assert.ok(result.reservedAtoms > 0n);
  });

  it('a lookalike selection reserves nothing', async () => {
    const t = await scriptedSession({ stock: { text: propose('nvda-token-b', 400) } });
    const result = await t.session.run();
    assert.equal(result.status, 'NOTHING_TO_AUTHORIZE');
    assert.equal(result.reservedAtoms, 0n);
    assert.equal(t.session.reservedExecutions.length, 0);
    assert.equal(t.of('AGENT_DECISION_COMPLETED').length, 0);
    assert.equal(t.of('PROPOSAL_SIGNED').some((e) => e.agent === 'stock'), false);
  });
});
