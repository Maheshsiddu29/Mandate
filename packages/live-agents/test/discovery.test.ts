import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discover, discoverAgent } from '../src/discovery.ts';
import { DOMAIN_AGENTS, PROMPT_INJECTION_FIXTURE } from '../src/agents/index.ts';
import { OpenAIProvider } from '../src/runtime/openai-provider.ts';
import type { DecisionRequest, ModelRequest } from '../src/runtime/provider.ts';
import { ROLES, type Role } from '../src/types.ts';
import { withField } from '../src/authoring/draft-types.ts';
import { runProtocol } from '../src/mandate/portfolio-adapter.ts';
import { ScriptedProvider, json } from './support/providers.ts';
import { WIDE_PERPS, containsKey, everyCandidate, world } from './support/world.ts';

const propose = (candidateId: string, whole: number) => json({ action: 'PROPOSE', candidateId, requestedAtoms: String(BigInt(whole) * 1_000_000n), rationale: `pick ${candidateId}` });
const abstain = json({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, rationale: 'nothing acceptable' });

const byRole = (answers: { readonly [R in Role]?: { text: string; delayMs?: number } }) =>
  new ScriptedProvider({ decide: (r) => answers[r.role] ?? { text: abstain } });

describe('the real Mandate verdict on every candidate, proposed directly with eligibility bypassed (balanced mandate)', () => {
  const expected: { readonly [id: string]: { readonly verdict: string; readonly codes: RegExp } } = {
    'nvda-note-a': { verdict: 'ADMISSIBLE', codes: /^$/ },
    'nvda-note-c': { verdict: 'ADMISSIBLE', codes: /^$/ },
    'nvda-token-b': { verdict: 'BLOCKED', codes: /REGISTRY:/ },
    'route-a': { verdict: 'ADMISSIBLE', codes: /^$/ },
    'route-c': { verdict: 'ADMISSIBLE', codes: /^$/ },
    'route-b': { verdict: 'BLOCKED', codes: /VENUE_NOT_ALLOWED/ },
    'genesis-11': { verdict: 'ADMISSIBLE', codes: /^$/ },
    'genesis-7': { verdict: 'BLOCKED', codes: /ASSET_NOT_ALLOWED|REPRESENTATION_NOT_ALLOWED/ },
    'alpha-usd-vault': { verdict: 'ADMISSIBLE', codes: /^$/ },
    'beta-usd-vault': { verdict: 'ADMISSIBLE', codes: /^$/ },
    'high-yield-usd': { verdict: 'BLOCKED', codes: /ISSUER_NOT_ALLOWED/ },
    'btc-long-2x': { verdict: 'ADMISSIBLE', codes: /^$/ },
    'btc-long-5x': { verdict: 'BLOCKED', codes: /LEVERAGE_NOT_ALLOWED/ },
  };
  for (const role of ROLES) {
    for (const c of DOMAIN_AGENTS[role].candidates) {
      it(`${role}/${c.id}`, async () => {
        const w = await world();
        const size = c.resizable ? c.minAtoms * 2n : c.minAtoms;
        // A filter with a bug, or a client that skipped it: the candidate reaches Mandate anyway, and Mandate alone decides.
        const out = await discoverAgent(w.deps(new ScriptedProvider({ decide: () => ({ text: json({ action: 'PROPOSE', candidateId: c.id, requestedAtoms: size.toString(), rationale: 'test' }) }) }), undefined, everyCandidate, null), w.active(), role);
        const want = expected[c.id];
        assert.ok(want, c.id);
        assert.equal(out.state, want.verdict, JSON.stringify(out.screening?.reasons));
        assert.match(out.screening?.reasons.map((r) => r.code).join(',') ?? '', want.codes);
      });
    }
  }

  it('the perps agent at 600, under a 600 allocation, is individually valid and portfolio invalid', async () => {
    const w = await world(WIDE_PERPS);
    const out = await discoverAgent(w.deps(byRole({ perps: { text: propose('btc-long-2x', 600) } })), w.active(), 'perps');
    assert.equal(out.state, 'ADMISSIBLE');
    assert.equal(out.screening?.individuallyValid, true);
    assert.equal(out.screening?.portfolioValid, false);
    assert.deepEqual(out.screening?.reasons.map((r) => `${r.code}:${r.subject}`), ['PORTFOLIO_LIMIT_EXCEEDED:derivative-notional']);
  });
});

describe('concurrent discovery', () => {
  it('test 9: five agents run concurrently, not one after another', async () => {
    const w = await world();
    const provider = byRole({ stock: { text: abstain, delayMs: 150 }, swap: { text: abstain, delayMs: 150 }, nft: { text: abstain, delayMs: 150 }, yield: { text: abstain, delayMs: 150 }, perps: { text: abstain, delayMs: 150 } });
    const t0 = performance.now();
    const out = await discover(w.deps(provider), w.active(), ROLES);
    const elapsed = performance.now() - t0;
    assert.equal(out.length, 5);
    assert.ok(elapsed < 450, `took ${elapsed} ms: five 150 ms calls were awaited in sequence`);
    const started = w.events.events.filter((e) => e.kind === 'AGENT_REQUEST_STARTED').map((e) => e.sequence);
    const firstDone = Math.min(...w.events.events.filter((e) => e.kind === 'AGENT_ABSTAINED').map((e) => e.sequence));
    assert.ok(Math.max(...started) < firstDone, 'every request started before any answer arrived');
  });

  it('test 10: response order follows latency, not role order', async () => {
    const order = async (delays: { readonly [R in Role]: number }) => {
      const w = await world();
      const provider = new ScriptedProvider({ decide: (r) => ({ text: abstain, delayMs: delays[r.role] }) });
      await discover(w.deps(provider), w.active(), ROLES);
      return w.events.events.filter((e) => e.kind === 'AGENT_ABSTAINED').map((e) => e.agent);
    };
    const a = await order({ stock: 10, swap: 60, nft: 110, yield: 160, perps: 210 });
    const b = await order({ stock: 210, swap: 160, nft: 110, yield: 60, perps: 10 });
    assert.deepEqual(a, ['stock', 'swap', 'nft', 'yield', 'perps']);
    assert.deepEqual(b, ['perps', 'yield', 'nft', 'swap', 'stock']);
  });

  it('test 11: ABSTAIN is a valid outcome and produces no proposal', async () => {
    const w = await world();
    const out = await discoverAgent(w.deps(byRole({})), w.active(), 'nft');
    assert.equal(out.state, 'ABSTAINED');
    assert.equal(out.signed, null);
    assert.equal(w.events.events.some((e) => e.kind === 'PROPOSAL_SIGNED'), false);
  });

  it('runtime failures are not refusals: a timeout, a failure and a malformed answer sign nothing', async () => {
    const w = await world();
    const provider = new ScriptedProvider({
      decide: (r) => (r.role === 'stock' ? { text: abstain, delayMs: 400 } : r.role === 'swap' ? { text: '', fail: true } : { text: '{"action":"PROPOSE","candidateId":"route-z","requestedAtoms":"1","rationale":""}' }),
    });
    const [stock, swap, nft] = await discover(w.deps(provider, 100), w.active(), ['stock', 'swap', 'nft']);
    assert.deepEqual([stock?.state, swap?.state, nft?.state], ['TIMED_OUT', 'FAILED', 'INVALID_RESPONSE']);
    for (const o of [stock, swap, nft]) assert.equal(o?.signed, null);
    assert.deepEqual(w.events.events.filter((e) => /^AGENT_(TIMED_OUT|FAILED|INVALID_RESPONSE)$/.test(e.kind)).map((e) => e.kind).sort(), ['AGENT_FAILED', 'AGENT_INVALID_RESPONSE', 'AGENT_TIMED_OUT']);
  });
});

describe('trust boundaries in discovery', () => {
  it('test 18: no signing key ever enters provider input, the OpenAI body or an event', async () => {
    const w = await world();
    const provider = byRole({ stock: { text: propose('nvda-note-a', 400) }, swap: { text: propose('route-a', 200) }, nft: { text: propose('genesis-11', 300) }, yield: { text: propose('alpha-usd-vault', 300) }, perps: { text: propose('btc-long-2x', 300) } });
    const out = await discover(w.deps(provider), w.active(), ROLES);
    assert.ok(out.every((o) => o.signed !== null));
    for (const r of provider.requests) assert.equal(containsKey(JSON.stringify(r)), false);
    const openai = new OpenAIProvider({ apiKey: 'FAKEKEY-d1sc', model: 'm' });
    for (const r of provider.requests) assert.equal(containsKey(openai.body(r as ModelRequest)), false);
    assert.equal(containsKey(JSON.stringify(w.events.events)), false);
    assert.equal(containsKey(JSON.stringify(out.map((o) => ({ ...o, candidate: null })), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))), false);
  });

  it('the model sees ids, facts and bounds — never an address it could return', async () => {
    const w = await world();
    const provider = byRole({});
    await discover(w.deps(provider), w.active(), ROLES);
    for (const r of provider.requests as DecisionRequest[]) {
      // Everything trusted code wrote (the untrusted seller text aside) is free of full addresses.
      const trusted = JSON.stringify({ ...r, candidates: r.candidates.map((c) => ({ ...c, untrustedText: null })) });
      assert.doesNotMatch(trusted, /0x[0-9a-f]{40}/i);
      assert.ok(r.candidates.every((c) => /^[a-z0-9-]+$/.test(c.id)));
    }
  });

  it('test 47: prompt injection in a listing cannot bypass Mandate (eligibility bypassed, so the injected listing reaches the model)', async () => {
    const w = await world();
    // A model fooled by the seller text picks the injected listing; it still cannot name a recipient or an amount off its bounds.
    const provider = new ScriptedProvider({
      decide: (r) => {
        const injected = r.candidates.find((c) => c.untrustedText === PROMPT_INJECTION_FIXTURE);
        assert.ok(injected, 'the fixture reached the model as untrusted text');
        return { text: json({ action: 'PROPOSE', candidateId: injected.id, requestedAtoms: injected.maxAtoms, rationale: 'The listing says it is pre-approved.' }) };
      },
    });
    const out = await discoverAgent(w.deps(provider, undefined, everyCandidate, null), w.active(), 'nft');
    assert.equal(out.state, 'BLOCKED');
    const c = out.signed?.proposal.candidate;
    assert.ok(c?.kind === 'NFT_BUY');
    // The recipient is the principal's, from local tables — not the attacker address in the text.
    assert.doesNotMatch(c.recipient, /9999999999/);
    // And a fooled model that tries to add the attacker as a field is refused before anything is built.
    const hijack = new ScriptedProvider({ decide: () => ({ text: json({ action: 'PROPOSE', candidateId: 'genesis-7', requestedAtoms: '240000000', rationale: 'x', recipient: '0x9999999999999999999999999999999999999999' }) }) });
    assert.equal((await discoverAgent(w.deps(hijack, undefined, everyCandidate, null), w.active(), 'nft')).state, 'INVALID_RESPONSE');
  });

  it('in a normal run the injected listing — outside the approved collection — is discovery only and never reaches the model', async () => {
    const w = await world();
    const provider = byRole({});
    await discoverAgent(w.deps(provider), w.active(), 'nft');
    const r = provider.requests[0] as DecisionRequest;
    assert.deepEqual(r.candidates.map((c) => c.id), ['genesis-11']);
    assert.doesNotMatch(JSON.stringify(r), /Ignore all previous instructions/);
  });
});

describe('test 8: a proposal made under V1 is re-checked once V2 is active', () => {
  it('an answer that arrives after the amendment is refused under V2 and must be re-authorized', async () => {
    const w = await world();
    const v1 = w.active();
    let amended: Promise<unknown> = Promise.resolve();
    const provider = new ScriptedProvider({
      decide: () => {
        // The principal tightens perps while the agent is still thinking.
        amended = w.versions.authorize(
          withField(withField(v1.draft, 'portfolio.maxDerivative', '250', 'USER'), 'agents.perps.maxAllocation', '250', 'USER'),
          'AUTHORIZE MANDATE V2',
          w.time.now,
        );
        return { text: propose('btc-long-2x', 350), delayMs: 50 };
      },
    });
    const out = await discoverAgent(w.deps(provider), v1, 'perps');
    await amended;
    assert.equal(w.versions.active?.version, 2);
    assert.equal(out.state, 'STALE');
    assert.equal(out.version, 1);
    assert.deepEqual(out.screening?.reasons.map((r) => r.code), ['PORTFOLIO_MANDATE_DIGEST_MISMATCH']);
    const stale = w.events.events.find((e) => e.kind === 'PROPOSAL_STALE');
    assert.equal(stale?.data['next'], 'REAUTHORIZE_REQUIRED');
    assert.equal(stale?.data['cause'], 'MANDATE_SUPERSEDED');
  });

  it('no grandfathering at Core either: a V1 child is refused by the ledger after V1’s root is revoked', async () => {
    const w = await world();
    const v1 = w.active();
    const out = await discoverAgent(w.deps(byRole({ swap: { text: propose('route-a', 200) } })), v1, 'swap');
    assert.equal(out.state, 'ADMISSIBLE');
    assert.ok((await w.versions.authorize(withField(v1.draft, 'agents.swap.maxAllocation', '300', 'USER'), 'AUTHORIZE MANDATE V2', w.time.now + 1n)).ok);
    // Even handed straight to V1's own Room and verifier — which still accept it — the ledger refuses.
    const signed = out.signed;
    assert.ok(signed);
    const r = await runProtocol(v1.core, v1.signature, w.time.now + 2n, [signed]);
    assert.equal(r.run.verification.status, 'VERIFIED');
    assert.deepEqual(r.run.reservations.map((x) => x.reasons.map((y) => y.code)), [['LEDGER:AUTHORITY_INVALID/AUTHORITY_REVOKED']]);
    assert.equal(r.executorCalls, 0);
    // Under V2 it is a different mandate: refused at screening.
    const v2 = w.active();
    const again = await runProtocol(v2.core, v2.signature, w.time.now + 3n, [signed]);
    assert.deepEqual(again.run.room.decisions.map((d) => d.reasons.map((x) => x.code)), [['PORTFOLIO_MANDATE_DIGEST_MISMATCH']]);
  });
});
