/**
 * Mandate-actionable ≠ settlement-capable.
 *
 * Policy (eligibility, then Mandate) says what the principal's agent may
 * do; capability (src/agents/capability.ts) says what the configured
 * connector can execute. These tests pin the second question, and that it
 * never answers the first: capability cannot add, rename, rebuild or
 * authorize a candidate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STOCK_APPROVED, STOCK_LOOKALIKE, STOCK_SERIES_C } from '@mandate/portfolio/demo';
import { DOMAIN_AGENTS, STOCK_AGENT } from '../src/agents/index.ts';
import { LIVE_LAB_SETTLEMENT_PROFILE, ROBINHOOD_TESTNET_STOCK_FIXTURES, executableCandidates, stockFixtureFor, type SettlementProfile } from '../src/agents/capability.ts';
import { actionableCandidates } from '../src/agents/eligibility.ts';
import type { TrustedCandidate } from '../src/agents/spec.ts';
import { discoverAgent, NO_EXECUTABLE_OPPORTUNITIES } from '../src/discovery.ts';
import type { DecisionRequest } from '../src/runtime/provider.ts';
import { ROLES } from '../src/types.ts';
import { ScriptedProvider } from './support/providers.ts';
import { propose, scriptedSession } from './support/session.ts';
import { everyCandidate, world } from './support/world.ts';

const one = (text: string) => new ScriptedProvider({ decide: () => ({ text }) });
const ids = (cs: readonly { readonly id: string }[]) => cs.map((c) => c.id);
const stock = (id: string): TrustedCandidate => {
  const c = STOCK_AGENT.candidates.find((x) => x.id === id);
  assert.ok(c, id);
  return c;
};
const capabilityOf = (c: TrustedCandidate, role = c.role) => LIVE_LAB_SETTLEMENT_PROFILE.capabilityOf(role, c, 0n);
const offered = (p: ScriptedProvider) => (p.requests.filter((r) => r.kind === 'DECISION') as DecisionRequest[]).map((r) => ids(r.candidates));

/** A profile whose connector supports only note A: the shape of the lab before note C had a settlement definition. */
const NOTE_A_ONLY: SettlementProfile = {
  ...LIVE_LAB_SETTLEMENT_PROFILE,
  id: 'test.note-a-only',
  capabilityOf: (role, c, now) => {
    const v = LIVE_LAB_SETTLEMENT_PROFILE.capabilityOf(role, c, now);
    return c.id === 'nvda-note-c' ? { ...v, profile: 'test.note-a-only', status: 'SETTLEMENT_UNSUPPORTED', reason: 'FIXTURE_UNDEFINED_FOR_CANDIDATE' } : { ...v, profile: 'test.note-a-only' };
  },
};

describe('the Live Lab settlement profile', () => {
  it('11–12: both approved NVDA notes are settlement-capable through the Robinhood testnet fixture connector', () => {
    for (const id of ['nvda-note-a', 'nvda-note-c']) {
      assert.deepEqual(capabilityOf(stock(id)), { candidateId: id, status: 'SETTLEMENT_CAPABLE', profile: 'live-lab.robinhood-testnet-fixture.v1', connector: 'robinhood-testnet-fixture', reason: null });
    }
    assert.deepEqual(ROBINHOOD_TESTNET_STOCK_FIXTURES.map((d) => [d.candidateId, d.representation]), [['nvda-note-a', STOCK_APPROVED], ['nvda-note-c', STOCK_SERIES_C]]);
  });

  it('13: the look-alike is not settlement-capable', () => {
    assert.deepEqual(capabilityOf(stock('nvda-token-b')), { candidateId: 'nvda-token-b', status: 'SETTLEMENT_UNSUPPORTED', profile: 'live-lab.robinhood-testnet-fixture.v1', connector: 'robinhood-testnet-fixture', reason: 'FIXTURE_UNDEFINED_FOR_CANDIDATE' });
  });

  it('14: identity is the id and the built representation together — neither alone, and never rewritten', () => {
    // A trusted id over another representation, and an unknown id over an approved one: both unsupported.
    const relabelled: TrustedCandidate = { ...stock('nvda-token-b'), id: 'nvda-note-a' };
    const renamed: TrustedCandidate = { ...stock('nvda-note-a'), id: 'nvda-note-z' };
    const swapped: TrustedCandidate = { ...stock('nvda-note-c'), id: 'nvda-note-a' };
    for (const c of [relabelled, renamed, swapped]) assert.equal(capabilityOf(c).status, 'SETTLEMENT_UNSUPPORTED', c.id);
    assert.equal(stockFixtureFor('nvda-note-a', STOCK_SERIES_C), null);
    assert.equal(stockFixtureFor('nvda-note-c', STOCK_APPROVED), null);
    assert.equal(stockFixtureFor('nvda-note-a', STOCK_LOOKALIKE), null);
    // The executable set is the same objects, in the same order: filtering never copies or rebuilds.
    const actionable = [stock('nvda-note-a'), stock('nvda-note-c')];
    const u = executableCandidates(LIVE_LAB_SETTLEMENT_PROFILE, 'stock', actionable, 0n);
    assert.ok(u.executable.every((c, i) => c === actionable[i]));
  });

  it('15: a candidate that cannot be built, or is not a stock buy, fails closed', () => {
    const broken: TrustedCandidate = { ...stock('nvda-note-a'), build: () => {
      throw new Error('no quote');
    } };
    assert.equal(capabilityOf(broken).reason, 'CANDIDATE_NOT_BUILDABLE');
    const notStock: TrustedCandidate = { ...DOMAIN_AGENTS.swap.candidates[0]!, role: 'stock' };
    assert.equal(capabilityOf(notStock, 'stock').reason, 'NOT_A_STOCK_BUY');
  });

  it('domains the profile does not settle stay offered, labelled outside the profile — never as testnet-settleable', () => {
    for (const role of ROLES.filter((r) => r !== 'stock')) {
      for (const c of DOMAIN_AGENTS[role].candidates) assert.deepEqual([capabilityOf(c).status, capabilityOf(c).connector], ['OUTSIDE_PROFILE', null], c.id);
    }
  });
});

describe('capability is known before the model is asked', () => {
  it('the evaluation event reports policy and capability separately; the model is offered the executable set', async () => {
    const w = await world();
    const provider = one(propose('nvda-note-c', 300));
    const out = await discoverAgent(w.deps(provider), w.active(), 'stock');
    const e = w.events.events.find((x) => x.kind === 'AGENT_CANDIDATES_EVALUATED' && x.agent === 'stock');
    assert.deepEqual(e?.data['actionable'], ['nvda-note-a', 'nvda-note-c']);
    assert.deepEqual(e?.data['executable'], ['nvda-note-a', 'nvda-note-c']);
    assert.equal(e?.data['settlementProfile'], 'live-lab.robinhood-testnet-fixture.v1');
    assert.deepEqual((e?.data['capability'] as { candidateId: string; status: string }[]).map((c) => [c.candidateId, c.status]), [['nvda-note-a', 'SETTLEMENT_CAPABLE'], ['nvda-note-c', 'SETTLEMENT_CAPABLE']]);
    assert.deepEqual(offered(provider), [['nvda-note-a', 'nvda-note-c']]);
    assert.equal(out.candidate?.id, 'nvda-note-c');
  });

  it('12 (unsupported profile): an allowed candidate the connector cannot settle is never offered; naming it is INVALID_RESPONSE', async () => {
    const w = await world();
    const provider = one(propose('nvda-note-c', 300));
    const out = await discoverAgent(w.deps(provider, undefined, undefined, NOTE_A_ONLY), w.active(), 'stock');
    assert.deepEqual(offered(provider), [['nvda-note-a']]);
    assert.equal(out.state, 'INVALID_RESPONSE');
    assert.equal(out.signed, null);
    const e = w.events.events.find((x) => x.kind === 'AGENT_CANDIDATES_EVALUATED' && x.agent === 'stock');
    // Policy still says note C is allowed; only capability set it aside.
    assert.deepEqual(e?.data['actionable'], ['nvda-note-a', 'nvda-note-c']);
    assert.deepEqual(e?.data['executable'], ['nvda-note-a']);
  });

  it('allowed but nothing executable: abstain without a model call', async () => {
    const w = await world();
    const provider = one(propose('nvda-note-a', 300));
    const none: SettlementProfile = { ...NOTE_A_ONLY, capabilityOf: (role, c, now) => ({ ...NOTE_A_ONLY.capabilityOf(role, c, now), status: 'SETTLEMENT_UNSUPPORTED', reason: 'FIXTURE_UNDEFINED_FOR_CANDIDATE' }) };
    const out = await discoverAgent(w.deps(provider, undefined, undefined, none), w.active(), 'stock');
    assert.equal(out.state, 'ABSTAINED');
    assert.equal(provider.requests.length, 0);
    const abstained = w.events.events.find((x) => x.kind === 'AGENT_ABSTAINED' && x.agent === 'stock');
    assert.deepEqual([abstained?.data['cause'], abstained?.data['rationale'], abstained?.data['modelCalled']], ['NO_EXECUTABLE_CANDIDATES', NO_EXECUTABLE_OPPORTUNITIES, false]);
  });

  it('17: capability cannot override policy — a profile that calls everything capable leaves the look-alike excluded, and BLOCKED if it reaches Mandate', async () => {
    const everything: SettlementProfile = { ...LIVE_LAB_SETTLEMENT_PROFILE, id: 'test.everything', capabilityOf: (_role, c) => ({ candidateId: c.id, status: 'SETTLEMENT_CAPABLE', profile: 'test.everything', connector: 'robinhood-testnet-fixture', reason: null }) };
    const w = await world();
    const provider = one(propose('nvda-note-a', 300));
    await discoverAgent(w.deps(provider, undefined, undefined, everything), w.active(), 'stock');
    assert.deepEqual(offered(provider), [['nvda-note-a', 'nvda-note-c']]);
    assert.deepEqual(ids(actionableCandidates(w.active(), 'stock', STOCK_AGENT.candidates, w.time.now).actionable), ['nvda-note-a', 'nvda-note-c']);
    // Both filters bypassed, the look-alike still stops at Mandate's screening, with nothing reserved.
    const t = await scriptedSession({ stock: { text: propose('nvda-token-b', 400) } }, undefined, { eligibility: everyCandidate, settlement: everything });
    const result = await t.session.run();
    assert.equal(t.of('PROPOSAL_BLOCKED')[0]?.agent, 'stock');
    assert.equal(result.status, 'NOTHING_TO_AUTHORIZE');
    assert.equal(t.session.reservedExecutions.length, 0);
  });
});
