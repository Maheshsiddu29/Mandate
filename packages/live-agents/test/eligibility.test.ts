/**
 * Discovered ≠ actionable ≠ authorized.
 *
 * Eligibility (src/agents/eligibility.ts) decides which discovered
 * candidates a model may optimize over; Mandate's screening decides what is
 * authorized. These tests pin both halves: the filter follows the active
 * mandate and the registry, never a name; and every forbidden action that
 * reaches Mandate anyway — through a bypassed filter — is still refused, with
 * zero reservations.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { candidateDigest, validateActionCandidate } from '@mandate/portfolio';
import { STOCK_APPROVED, STOCK_LOOKALIKE, STOCK_SERIES_C } from '@mandate/portfolio/demo';
import { DOMAIN_AGENTS, STOCK_AGENT, SWAP_AGENT, YIELD_AGENT } from '../src/agents/index.ts';
import { actionableCandidates, assessCandidate, STATIC_SCOPE_CODES } from '../src/agents/eligibility.ts';
import { presetDraft, PRESETS, withField } from '../src/authoring/draft-types.ts';
import { discoverAgent, NO_ELIGIBLE_OPPORTUNITIES } from '../src/discovery.ts';
import { reasonCodes } from '../src/mandate/verifier-adapter.ts';
import type { DecisionRequest } from '../src/runtime/provider.ts';
import { decisionSchema } from '../src/runtime/schemas.ts';
import { ROLES } from '../src/types.ts';
import { ScriptedProvider, json } from './support/providers.ts';
import { abstain, propose, scriptedSession } from './support/session.ts';
import { everyCandidate, world } from './support/world.ts';

const one = (text: string) => new ScriptedProvider({ decide: () => ({ text }) });
const ids = (cs: readonly { readonly id: string }[]) => cs.map((c) => c.id);
const byId = <C extends { readonly id: string }>(cs: readonly C[], id: string): C => {
  const c = cs.find((x) => x.id === id);
  assert.ok(c, id);
  return c;
};
const offered = (p: ScriptedProvider) => (p.requests.filter((r) => r.kind === 'DECISION') as DecisionRequest[]).map((r) => ids(r.candidates));

describe('stock: the approved notes are actionable, the look-alike is discovery only', () => {
  it('1–5: all three are discovered; the registry admits both notes and excludes the look-alike with its exact reasons', async () => {
    const w = await world();
    const u = actionableCandidates(w.active(), 'stock', STOCK_AGENT.candidates, w.time.now);
    assert.deepEqual(ids(u.discovered), ['nvda-note-a', 'nvda-note-c', 'nvda-token-b']);
    assert.deepEqual(ids(u.actionable), ['nvda-note-a', 'nvda-note-c']);
    assert.deepEqual(u.excluded.map((x) => [x.candidate.id, reasonCodes(x.reasons)]), [['nvda-token-b', [`REGISTRY:ISSUER_NOT_ALLOWED:${STOCK_LOOKALIKE}`, `REGISTRY:SYNTHETIC_NOT_ALLOWED:${STOCK_LOOKALIKE}`]]]);
    // The verdict comes from what the candidates build to — their registry representation — not their ids or titles.
    const representation = (id: string) => {
      const b = STOCK_AGENT.candidates.find((c) => c.id === id)?.build(STOCK_AGENT.candidates[0]!.minAtoms, w.time.now);
      return b?.kind === 'STOCK_BUY' ? b.representation : null;
    };
    assert.equal(representation('nvda-note-a'), STOCK_APPROVED);
    assert.equal(representation('nvda-note-c'), STOCK_SERIES_C);
    assert.equal(representation('nvda-token-b'), STOCK_LOOKALIKE);
  });

  it('the exclusion reasons are exactly the ones Mandate itself gives the look-alike when it is proposed', async () => {
    const w = await world();
    const direct = await discoverAgent(w.deps(one(propose('nvda-token-b', 400)), undefined, everyCandidate), w.active(), 'stock');
    const filtered = assessCandidate(w.active(), 'stock', byId(STOCK_AGENT.candidates, 'nvda-token-b'), w.time.now);
    assert.equal(direct.state, 'BLOCKED');
    assert.deepEqual(reasonCodes(filtered.reasons), reasonCodes(direct.screening?.reasons ?? []));
  });

  it('filtering changes visibility, not meaning: the actionable candidate is the very same object, with the same digest', async () => {
    const w = await world();
    const u = actionableCandidates(w.active(), 'stock', STOCK_AGENT.candidates, w.time.now);
    assert.equal(u.actionable[0], STOCK_AGENT.candidates[0]);
    assert.equal(u.excluded[0]?.candidate, byId(STOCK_AGENT.candidates, 'nvda-token-b'));
    const digest = (c: (typeof STOCK_AGENT.candidates)[number]) => {
      const v = validateActionCandidate(c.build(c.minAtoms, w.time.now));
      assert.ok(v.ok);
      return candidateDigest(v.value);
    };
    assert.equal(digest(u.actionable[0]!), digest(STOCK_AGENT.candidates[0]!));
  });

  it('6: the model is offered only the actionable stock candidates, and its schema can name nothing else', async () => {
    const w = await world();
    const provider = one(abstain);
    await discoverAgent(w.deps(provider), w.active(), 'stock');
    assert.deepEqual(offered(provider), [['nvda-note-a', 'nvda-note-c']]);
    const schema = decisionSchema(provider.requests[0] as DecisionRequest) as { properties: { candidateId: { enum: unknown[] } } };
    assert.deepEqual(schema.properties.candidateId.enum, ['nvda-note-a', 'nvda-note-c', null]);
    assert.doesNotMatch(JSON.stringify(provider.requests[0]), /nvda-token-b|NVIDIA Stock Token/);
    const evaluated = w.events.events.find((e) => e.kind === 'AGENT_CANDIDATES_EVALUATED');
    assert.equal(evaluated?.data['basis'], 'ADVISORY');
    assert.deepEqual(evaluated?.data['discovered'], ['nvda-note-a', 'nvda-note-c', 'nvda-token-b']);
    assert.deepEqual(evaluated?.data['actionable'], ['nvda-note-a', 'nvda-note-c']);
  });

  it('7–8: a model that names the discovery-only look-alike gets INVALID_RESPONSE — never a substituted approved note', async () => {
    const w = await world();
    const out = await discoverAgent(w.deps(one(propose('nvda-token-b', 400))), w.active(), 'stock');
    assert.equal(out.state, 'INVALID_RESPONSE');
    assert.equal(out.candidate, null);
    assert.equal(out.signed, null);
    assert.ok(!w.events.events.some((e) => e.kind === 'PROPOSAL_SIGNED' || e.kind === 'AGENT_DECISION_COMPLETED'));
  });

  it('8: the proposal is for exactly the candidate the model chose', async () => {
    const w = await world();
    const out = await discoverAgent(w.deps(one(propose('nvda-note-a', 400))), w.active(), 'stock');
    assert.equal(out.state, 'ADMISSIBLE');
    assert.equal(out.decision?.candidateId, 'nvda-note-a');
    assert.equal(out.candidate?.id, 'nvda-note-a');
    const c = out.signed?.proposal.candidate;
    assert.ok(c?.kind === 'STOCK_BUY');
    assert.equal(c.representation, STOCK_APPROVED);
  });

  it('9–10: proposed directly (filter bypassed), the look-alike is still BLOCKED by the registry, with zero reservations and zero transactions', async () => {
    const t = await scriptedSession({ stock: { text: propose('nvda-token-b', 400) } }, undefined, { eligibility: everyCandidate });
    const result = await t.session.run();
    const blocked = t.of('PROPOSAL_BLOCKED');
    assert.equal(blocked.length, 1);
    assert.deepEqual((blocked[0]?.data['reasons'] as string[]).map((r) => r.split(':').slice(0, 2).join(':')), ['REGISTRY:ISSUER_NOT_ALLOWED', 'REGISTRY:SYNTHETIC_NOT_ALLOWED']);
    assert.equal(result.status, 'NOTHING_TO_AUTHORIZE');
    assert.equal(result.reservedAtoms, 0n);
    assert.equal(result.transactions, 0);
    assert.equal(result.executorCalls, 0);
    assert.equal(t.session.reservedExecutions.length, 0);
  });

  it('11: the approved stock proposal, chosen in a normal run, is reserved', async () => {
    const t = await scriptedSession({ stock: { text: propose('nvda-note-a', 400) } });
    const result = await t.session.run();
    assert.equal(result.status, 'AUTHORIZED');
    assert.deepEqual(t.session.reservedExecutions.map((x) => [x.role, x.candidateId]), [['stock', 'nvda-note-a']]);
    assert.equal(result.transactions, 0);
  });
});

describe('swap and yield: the same rule, no domain-specific code', () => {
  it('swap: the better-quoting unapproved router is discovery only; the approved routes are offered', async () => {
    const w = await world();
    const u = actionableCandidates(w.active(), 'swap', SWAP_AGENT.candidates, w.time.now);
    assert.deepEqual(ids(u.discovered), ['route-a', 'route-c', 'route-b']);
    assert.deepEqual(ids(u.actionable), ['route-a', 'route-c']);
    assert.deepEqual(u.excluded.map((x) => [x.candidate.id, x.reasons.map((r) => r.code)]), [['route-b', ['VENUE_NOT_ALLOWED']]]);
    const provider = one(abstain);
    await discoverAgent(w.deps(provider), w.active(), 'swap');
    assert.deepEqual(offered(provider), [['route-a', 'route-c']]);
  });

  it('swap: proposed directly (filter bypassed), the unapproved router still gets VENUE_NOT_ALLOWED', async () => {
    const w = await world();
    const out = await discoverAgent(w.deps(one(propose('route-b', 300)), undefined, everyCandidate), w.active(), 'swap');
    assert.equal(out.state, 'BLOCKED');
    assert.deepEqual(out.screening?.reasons.map((r) => r.code), ['VENUE_NOT_ALLOWED']);
  });

  it('yield: the highest advertised APY from an unapproved vault is discovery only; the approved vaults are offered', async () => {
    const w = await world();
    const u = actionableCandidates(w.active(), 'yield', YIELD_AGENT.candidates, w.time.now);
    assert.deepEqual(ids(u.discovered), ['alpha-usd-vault', 'beta-usd-vault', 'high-yield-usd']);
    assert.deepEqual(ids(u.actionable), ['alpha-usd-vault', 'beta-usd-vault']);
    assert.deepEqual(u.excluded[0]?.reasons.map((r) => r.code), ['ASSET_NOT_ALLOWED', 'ISSUER_NOT_ALLOWED', 'REPRESENTATION_NOT_ALLOWED', 'VENUE_NOT_ALLOWED']);
    const provider = one(abstain);
    await discoverAgent(w.deps(provider), w.active(), 'yield');
    assert.deepEqual(offered(provider), [['alpha-usd-vault', 'beta-usd-vault']]);
  });

  it('yield: proposed directly (filter bypassed), the unapproved vault still gets every relevant Mandate reason', async () => {
    const w = await world();
    const out = await discoverAgent(w.deps(one(propose('high-yield-usd', 300)), undefined, everyCandidate), w.active(), 'yield');
    assert.equal(out.state, 'BLOCKED');
    for (const code of ['ASSET_NOT_ALLOWED', 'ISSUER_NOT_ALLOWED', 'REPRESENTATION_NOT_ALLOWED', 'VENUE_NOT_ALLOWED']) assert.ok(out.screening?.reasons.some((r) => r.code === code), code);
  });

  it('zero actionable candidates: ABSTAINED without a model call, without a placeholder, without a proposal', async () => {
    // Discovery found only the unvetted high-APY vault this time.
    const w = await world();
    const provider = one(propose('high-yield-usd', 300));
    const out = await discoverAgent(w.deps(provider), w.active(), 'yield', { candidates: [byId(YIELD_AGENT.candidates, 'high-yield-usd')] });
    assert.equal(out.state, 'ABSTAINED');
    assert.equal(out.decision, null);
    assert.equal(out.candidate, null);
    assert.equal(out.signed, null);
    assert.equal(provider.requests.length, 0, 'no model call');
    const kinds = w.events.events.map((e) => e.kind);
    assert.deepEqual(kinds, ['AGENT_CANDIDATES_EVALUATED', 'AGENT_ABSTAINED']);
    const evaluated = w.events.events[0];
    assert.deepEqual(evaluated?.data['actionable'], []);
    assert.deepEqual((evaluated?.data['excluded'] as { candidateId: string }[]).map((x) => x.candidateId), ['high-yield-usd']);
    assert.deepEqual(w.events.events[1]?.data, { rationale: NO_ELIGIBLE_OPPORTUNITIES, cause: 'NO_ACTIONABLE_CANDIDATES', modelCalled: false });
  });

  it('a mandate that leaves an agent nothing actionable: that agent abstains, the others run, nothing is fabricated', async () => {
    // The router stays approved, the pool every route goes through does not: no swap route can be authorized.
    const draft = withField(presetDraft('balanced'), 'market.venues', ['robinhood-gate', 'swap-router', 'nft-marketplace', 'alpha-vault-protocol', 'lighter-exchange'], 'USER');
    const t = await scriptedSession({ stock: { text: propose('nvda-note-a', 300) }, swap: { text: propose('route-a', 300) } }, undefined, { draft });
    const result = await t.session.run();
    assert.equal(result.status, 'AUTHORIZED');
    assert.deepEqual(t.session.reservedExecutions.map((x) => x.role), ['stock']);
    assert.ok(!t.provider.requests.some((r) => r.kind === 'DECISION' && r.role === 'swap'));
    const swap = t.of('AGENT_CANDIDATES_EVALUATED').find((e) => e.agent === 'swap');
    assert.deepEqual(swap?.data['actionable'], []);
    assert.ok((swap?.data['excluded'] as { reasons: string[] }[]).every((x) => x.reasons.some((r) => r.startsWith('ROUTE_NOT_ALLOWED'))));
    assert.equal(t.of('AGENT_ABSTAINED').find((e) => e.agent === 'swap')?.data['modelCalled'], false);
  });
});

describe('eligibility is derived from the active mandate, not from candidate names', () => {
  it('for every preset, role and candidate: actionable exactly when Mandate raises no identity or static scope reason against it', async () => {
    for (const preset of PRESETS) {
      const w = await world(presetDraft(preset));
      for (const role of ROLES) {
        const u = actionableCandidates(w.active(), role, DOMAIN_AGENTS[role].candidates, w.time.now);
        for (const c of DOMAIN_AGENTS[role].candidates) {
          const direct = await discoverAgent(w.deps(one(json({ action: 'PROPOSE', candidateId: c.id, requestedAtoms: c.minAtoms.toString(), rationale: 'probe' })), undefined, everyCandidate), w.active(), role);
          const staticReasons = (direct.screening?.reasons ?? []).filter((r) => STATIC_SCOPE_CODES.has(r.code) || r.code.startsWith('REGISTRY:') || r.code === 'INSTRUMENT_UNKNOWN');
          assert.equal(u.actionable.includes(c), staticReasons.length === 0, `${preset}/${role}/${c.id}: ${JSON.stringify(direct.screening?.reasons)}`);
        }
      }
    }
  });

  it('an amendment that narrows the mandate narrows what the next decision is offered', async () => {
    const w = await world();
    const before = actionableCandidates(w.active(), 'swap', SWAP_AGENT.candidates, w.time.now);
    assert.deepEqual(ids(before.actionable), ['route-a', 'route-c']);
    const v1 = w.active();
    const v2 = await w.versions.authorize(withField(v1.draft, 'market.venues', ['robinhood-gate', 'swap-router', 'nft-marketplace', 'alpha-vault-protocol', 'lighter-exchange', 'beta-vault-protocol'], 'USER'), 'AUTHORIZE MANDATE V2', w.time.now);
    assert.ok(v2.ok, v2.ok ? '' : `${v2.code} ${JSON.stringify(v2.issues ?? [])}`);
    const after = actionableCandidates(w.active(), 'swap', SWAP_AGENT.candidates, w.time.now);
    assert.deepEqual(ids(after.actionable), []);
  });

  it('an amount-dependent problem is not an eligibility question: an over-limit request is still offered and refused only by screening', async () => {
    const w = await world(withField(presetDraft('balanced'), 'agents.perps.maxAllocation', '150', 'USER'));
    const provider = one(propose('btc-long-2x', 600));
    const out = await discoverAgent(w.deps(provider), w.active(), 'perps');
    assert.deepEqual(offered(provider), [['btc-long-2x']]);
    assert.ok(out.screening !== null && out.screening.reasons.some((r) => r.code === 'AGENT_LIMIT_EXCEEDED'), JSON.stringify(out.screening?.reasons));
  });
});
