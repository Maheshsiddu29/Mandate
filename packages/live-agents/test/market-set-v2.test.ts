/**
 * The Live Lab market set V2: several approved, executable alternatives per
 * domain, the forbidden ones still discovery only, and Mandate's final
 * screening unchanged.
 *
 * Nothing here asserts which approved candidate is "right": either one may
 * be chosen, and either one must then pass the same Mandate path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { candidateDigest, screenProposal, validateActionCandidate } from '@mandate/portfolio';
import { AGENT_SCOPES, PORTFOLIO_SCOPE, STOCK_APPROVED, STOCK_PRICE_ATOMS, STOCK_SERIES_C, demoBindings, liveLabBindings, PRINCIPAL_ON_ROBINHOOD, NVDA } from '@mandate/portfolio/demo';
import { DOMAIN_AGENTS, PERPS_AGENT, STOCK_AGENT, SWAP_AGENT, YIELD_AGENT } from '../src/agents/index.ts';
import { actionableCandidates } from '../src/agents/eligibility.ts';
import { presetDraft, PRESETS } from '../src/authoring/draft-types.ts';
import { discoverAgent } from '../src/discovery.ts';
import { screen } from '../src/mandate/verifier-adapter.ts';
import { modelEvidenceOf, type DecisionRequest } from '../src/runtime/provider.ts';
import { decisionSchema } from '../src/runtime/schemas.ts';
import { StubProvider } from '../src/runtime/stub-provider.ts';
import { LiveSession } from '../src/session.ts';
import { ROLES } from '../src/types.ts';
import { ScriptedProvider } from './support/providers.ts';
import { abstain, propose, scriptedSession } from './support/session.ts';
import { WIDE_PERPS, everyCandidate, TestTime, world } from './support/world.ts';

const one = (text: string) => new ScriptedProvider({ decide: () => ({ text }) });
const ids = (cs: readonly { readonly id: string }[]) => cs.map((c) => c.id);
const offered = (p: ScriptedProvider) => (p.requests.filter((r) => r.kind === 'DECISION') as DecisionRequest[]).map((r) => ids(r.candidates));

const APPROVED = { stock: ['nvda-note-a', 'nvda-note-c'], swap: ['route-a', 'route-c'], yield: ['alpha-usd-vault', 'beta-usd-vault'] } as const;
const FORBIDDEN = { stock: 'nvda-token-b', swap: 'route-b', yield: 'high-yield-usd' } as const;

describe('stock, swap and yield: two approved alternatives each, the forbidden one discovery only', () => {
  for (const role of ['stock', 'swap', 'yield'] as const) {
    it(`${role}: both approved candidates are discovered, actionable and offered; ${FORBIDDEN[role]} is excluded`, async () => {
      for (const preset of PRESETS) {
        const w = await world(presetDraft(preset));
        const u = actionableCandidates(w.active(), role, DOMAIN_AGENTS[role].candidates, w.time.now);
        assert.ok(ids(u.discovered).includes(FORBIDDEN[role]));
        assert.deepEqual(ids(u.actionable), [...APPROVED[role]], preset);
        assert.deepEqual(u.excluded.map((x) => x.candidate.id), [FORBIDDEN[role]], preset);
      }
      const w = await world();
      const provider = one(abstain);
      await discoverAgent(w.deps(provider), w.active(), role);
      assert.deepEqual(offered(provider), [[...APPROVED[role]]]);
      const schema = decisionSchema(provider.requests[0] as DecisionRequest) as { properties: { candidateId: { enum: unknown[] } } };
      assert.deepEqual(schema.properties.candidateId.enum, [...APPROVED[role], null]);
    });

    for (const id of APPROVED[role]) {
      it(`${role}: a model choosing ${id} gets exactly that proposal, admissible, and it is reserved`, async () => {
        const w = await world();
        const out = await discoverAgent(w.deps(one(propose(id, 200))), w.active(), role);
        assert.equal(out.state, 'ADMISSIBLE', JSON.stringify(out.screening?.reasons));
        assert.equal(out.decision?.candidateId, id);
        assert.equal(out.candidate?.id, id);
        const t = await scriptedSession({ [role]: { text: propose(id, 200) } });
        const result = await t.session.run();
        assert.equal(result.status, 'AUTHORIZED');
        assert.deepEqual(t.session.reservedExecutions.map((x) => [x.role, x.candidateId]), [[role, id]]);
        assert.equal(result.transactions, 0);
      });
    }

    it(`${role}: ${FORBIDDEN[role]} named by a model is INVALID_RESPONSE; proposed directly it is still BLOCKED, never reserved`, async () => {
      const w = await world();
      const named = await discoverAgent(w.deps(one(propose(FORBIDDEN[role], 200))), w.active(), role);
      assert.equal(named.state, 'INVALID_RESPONSE');
      assert.equal(named.candidate, null);
      const t = await scriptedSession({ [role]: { text: propose(FORBIDDEN[role], 200) } }, undefined, { eligibility: everyCandidate, settlement: null });
      const result = await t.session.run();
      assert.equal(t.of('PROPOSAL_BLOCKED').length, 1);
      assert.equal(result.reservedAtoms, 0n);
      assert.equal(t.session.reservedExecutions.length, 0);
    });
  }

  it('the stock look-alike keeps its exact registry reasons; the router and the vault keep theirs', async () => {
    const w = await world();
    const reasons = async (role: 'stock' | 'swap' | 'yield') => {
      const out = await discoverAgent(w.deps(one(propose(FORBIDDEN[role], 200)), undefined, everyCandidate, null), w.active(), role);
      return [...new Set(out.screening?.reasons.map((r) => r.code))];
    };
    assert.deepEqual(await reasons('stock'), ['REGISTRY:ISSUER_NOT_ALLOWED', 'REGISTRY:SYNTHETIC_NOT_ALLOWED']);
    assert.deepEqual(await reasons('swap'), ['VENUE_NOT_ALLOWED']);
    assert.deepEqual(await reasons('yield'), ['ASSET_NOT_ALLOWED', 'ISSUER_NOT_ALLOWED', 'REPRESENTATION_NOT_ALLOWED', 'VENUE_NOT_ALLOWED']);
  });

  it('zero actionable yield candidates still abstain without a model call', async () => {
    const w = await world();
    const provider = one(propose('high-yield-usd', 200));
    const out = await discoverAgent(w.deps(provider), w.active(), 'yield', { candidates: YIELD_AGENT.candidates.filter((c) => c.id === 'high-yield-usd') });
    assert.equal(out.state, 'ABSTAINED');
    assert.equal(provider.requests.length, 0);
  });
});

describe('the alternatives differ in what the protocol enforces, and neither is labelled better', () => {
  it('stock: note C costs ≈125.06 all-in (124.75 + 0.25 %), note A 125.00; fee-aware quantity keeps the all-in cost within the request', async () => {
    const w = await world();
    for (const [id, cap] of [['nvda-note-a', 800n], ['nvda-note-c', 600n]] as const) {
      const c = STOCK_AGENT.candidates.find((x) => x.id === id)!;
      assert.equal(c.maxAtoms, cap * 1_000_000n);
      const out = await discoverAgent(w.deps(one(propose(id, 400))), w.active(), 'stock');
      const capital = out.screening?.demand.find((d) => d.resource === 'spot-capital')?.atoms ?? 0n;
      assert.ok(capital <= 400_000_000n && capital > 399_000_000n, `${id}: ${capital}`);
    }
  });

  it('swap: route C quotes more per USDC but is limited to 250 by depth; route A takes up to 500', () => {
    const [a, c] = [SWAP_AGENT.candidates.find((x) => x.id === 'route-a')!, SWAP_AGENT.candidates.find((x) => x.id === 'route-c')!];
    const out = (x: typeof a) => {
      const b = x.build(200_000_000n, 0n);
      return b.kind === 'SWAP_EXACT_IN' ? b.quotedOut : 0n;
    };
    assert.ok(out(c) > out(a));
    assert.equal(a.maxAtoms, 500_000_000n);
    assert.equal(c.maxAtoms, 250_000_000n);
  });

  it('yield: Beta advertises more with less capacity; Alpha the reverse', () => {
    const [a, b] = [YIELD_AGENT.candidates.find((x) => x.id === 'alpha-usd-vault')!, YIELD_AGENT.candidates.find((x) => x.id === 'beta-usd-vault')!];
    const apy = (x: typeof a) => {
      const built = x.build(100_000_000n, 0n);
      return built.kind === 'YIELD_DEPOSIT' ? built.quotedApyBps : 0;
    };
    assert.ok(apy(b) > apy(a));
    assert.ok(b.maxAtoms < a.maxAtoms);
  });
});

describe('perps: the bounded choice that the domain can honestly execute', () => {
  it('2x stays actionable, 5x stays excluded by the leverage bound', async () => {
    const w = await world();
    const u = actionableCandidates(w.active(), 'perps', PERPS_AGENT.candidates, w.time.now);
    assert.deepEqual(ids(u.actionable), ['btc-long-2x']);
    assert.deepEqual(u.excluded.map((x) => [x.candidate.id, x.reasons.map((r) => r.code)]), [['btc-long-5x', ['LEVERAGE_NOT_ALLOWED']]]);
  });

  it('the derivative conflict is computed from the requested size, not from the candidate set', async () => {
    const w = await world(WIDE_PERPS);
    const small = await discoverAgent(w.deps(one(propose('btc-long-2x', 300))), w.active(), 'perps');
    const large = await discoverAgent(w.deps(one(propose('btc-long-2x', 600))), w.active(), 'perps');
    assert.equal(small.screening?.portfolioValid, true);
    assert.deepEqual(large.screening?.reasons.map((r) => `${r.code}:${r.subject}`), ['PORTFOLIO_LIMIT_EXCEEDED:derivative-notional']);
  });
});

describe('general invariants', () => {
  it('eligibility never reorders or prefers: a reversed discovery order is offered reversed, and the second id is as valid as the first', async () => {
    const w = await world();
    const reversed = [...STOCK_AGENT.candidates].reverse();
    const provider = one(propose('nvda-note-a', 200));
    const out = await discoverAgent(w.deps(provider), w.active(), 'stock', { candidates: reversed });
    assert.deepEqual(offered(provider), [['nvda-note-c', 'nvda-note-a']]);
    assert.equal(out.candidate?.id, 'nvda-note-a');
  });

  it('no substitution: choosing note C yields a proposal for note C, never note A', async () => {
    const w = await world();
    const out = await discoverAgent(w.deps(one(propose('nvda-note-c', 300))), w.active(), 'stock');
    const c = out.signed?.proposal.candidate;
    assert.ok(c?.kind === 'STOCK_BUY');
    assert.equal(c.representation, STOCK_SERIES_C);
    assert.notEqual(c.representation, STOCK_APPROVED);
  });

  it('the note A candidate is byte-identical to its V1 construction: same quantity, same digest', () => {
    const c = STOCK_AGENT.candidates.find((x) => x.id === 'nvda-note-a')!;
    const size = 400_000_000n;
    const v1 = validateActionCandidate({ kind: 'STOCK_BUY', representation: STOCK_APPROVED, account: PRINCIPAL_ON_ROBINHOOD, quantity: (size * 10n ** 18n) / STOCK_PRICE_ATOMS, claims: { ticker: 'NVDA', displayName: null, issuer: null, asset: { assetClass: NVDA.assetClass, idScheme: NVDA.idScheme, value: NVDA.value } } });
    const v2 = validateActionCandidate(c.build(size, 0n));
    assert.ok(v1.ok && v2.ok);
    assert.equal(candidateDigest(v2.value), candidateDigest(v1.value));
  });

  it('final screening is the frozen screenProposal: the adapter returns exactly its reasons for every V2 candidate', async () => {
    const w = await world();
    for (const role of ROLES) {
      for (const c of DOMAIN_AGENTS[role].candidates) {
        const out = await discoverAgent(w.deps(one(propose(c.id, Number(c.minAtoms / 1_000_000n))), undefined, everyCandidate, null), w.active(), role);
        assert.ok(out.signed, c.id);
        const a = w.active();
        const direct = screenProposal(a.mandate, a.compiled.bindings, out.signed, w.time.now);
        assert.deepEqual(screen(a.mandate, a.compiled.bindings, out.signed, w.time.now).reasons, direct.reasons, c.id);
      }
    }
  });

  it('every candidate is labelled FIXTURE market data; the inference kind follows the provider', async () => {
    for (const role of ROLES) for (const c of DOMAIN_AGENTS[role].candidates) assert.equal(c.marketEvidence, 'FIXTURE');
    assert.deepEqual([modelEvidenceOf('LIVE'), modelEvidenceOf('STUB'), modelEvidenceOf('SCRIPTED')], ['LIVE_MODEL', 'STUB', 'SCRIPTED']);
    const w = await world();
    await discoverAgent(w.deps(one(propose('route-a', 200))), w.active(), 'swap');
    const kinds = Object.fromEntries(w.events.events.map((e) => [e.kind, e.data]));
    assert.deepEqual(kinds['AGENT_CANDIDATES_EVALUATED']?.['marketEvidence'], ['FIXTURE']);
    assert.equal(kinds['AGENT_REQUEST_STARTED']?.['modelEvidence'], 'SCRIPTED');
    assert.equal(kinds['AGENT_DECISION_COMPLETED']?.['modelEvidence'], 'SCRIPTED');
    assert.deepEqual(kinds['AGENT_DECISION_COMPLETED']?.['alternatives'], ['route-c']);
  });

  it('the stub is deterministic infrastructure: the first offered id of its fixed preference list', async () => {
    const w = await world();
    const stub = new StubProvider(1);
    for (const [role, want] of [['stock', 'nvda-note-c'], ['swap', 'route-c'], ['yield', 'beta-usd-vault'], ['perps', 'btc-long-2x']] as const) {
      const out = await discoverAgent(w.deps(stub), w.active(), role);
      assert.equal(out.candidate?.id, want, role);
    }
  });

  it("the principal's intent reaches every agent as guidance and changes no authority", async () => {
    const run = async (intent: string | undefined) => {
      const time = new TestTime();
      const provider = one(abstain);
      const session = new LiveSession({ provider, sessionId: 'intent', agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000, protocolNow: time.read, ...(intent === undefined ? {} : { intent }) });
      const auth = await session.authorize(presetDraft('balanced'), 'AUTHORIZE MANDATE V1');
      assert.ok(auth.ok);
      await session.run();
      return { requests: provider.requests as DecisionRequest[], digest: session.versions.active?.compiled.mandate };
    };
    const without = await run(undefined);
    const withIntent = await run('Prefer liquidity and lower-risk approved opportunities.');
    assert.ok(without.requests.every((r) => r.principalIntent === null));
    assert.ok(withIntent.requests.length === 5 && withIntent.requests.every((r) => r.principalIntent === 'Prefer liquidity and lower-risk approved opportunities.'));
    assert.deepEqual(withIntent.requests.map((r) => r.authority), without.requests.map((r) => r.authority));
    assert.deepEqual(withIntent.requests.map((r) => ids(r.candidates)), without.requests.map((r) => ids(r.candidates)));
  });
});

describe('the frozen Phase 7F demonstration world is untouched', () => {
  it('demoBindings, AGENT_SCOPES and PORTFOLIO_SCOPE are the V1 world; only liveLabBindings carries V2', () => {
    assert.deepEqual(AGENT_SCOPES.stock.representations, [STOCK_APPROVED]);
    assert.equal(PORTFOLIO_SCOPE.representations.length, 5);
    assert.ok(!PORTFOLIO_SCOPE.representations.includes(STOCK_SERIES_C));
    const stockBinding = (bs: ReturnType<typeof demoBindings>) => bs.find((b) => b.kind === 'STOCK_BUY') as unknown as { config: { gate: { markets: readonly unknown[] } } };
    assert.equal(stockBinding(demoBindings()).config.gate.markets.length, 1);
    assert.equal(stockBinding(liveLabBindings()).config.gate.markets.length, 2);
  });
});
