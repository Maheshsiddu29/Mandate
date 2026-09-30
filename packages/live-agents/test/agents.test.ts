import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateActionCandidate } from '@mandate/portfolio';
import { PRINCIPAL_ON_ARBITRUM, PRINCIPAL_ON_ROBINHOOD, PERP_ACCOUNT, DEMO_NOW } from '@mandate/portfolio/demo';
import { DOMAIN_AGENTS, candidateById, viewOf } from '../src/agents/index.ts';
import { applyAdvice } from '../src/jev/advisor.ts';
import { NoopJevAdvisor } from '../src/jev/noop-advisor.ts';
import { ROLES } from '../src/types.ts';

describe('the five domain agents', () => {
  it('each has an objective and a closed set of well-formed candidates', () => {
    for (const r of ROLES) {
      const spec = DOMAIN_AGENTS[r];
      assert.equal(spec.role, r);
      assert.ok(spec.objective.length > 20);
      const ids = spec.candidates.map((c) => c.id);
      assert.equal(new Set(ids).size, ids.length);
      for (const c of spec.candidates) {
        assert.ok(c.minAtoms > 0n && c.minAtoms <= c.maxAtoms, c.id);
        assert.ok(validateActionCandidate(c.build(c.minAtoms, DEMO_NOW)).ok, c.id);
      }
    }
  });

  it('every recipient and account comes from local tables — the principal’s own', () => {
    for (const r of ROLES) {
      for (const c of DOMAIN_AGENTS[r].candidates) {
        const x = c.build(c.maxAtoms, DEMO_NOW);
        const who = 'recipient' in x ? x.recipient : 'account' in x ? x.account : null;
        assert.ok(who === PRINCIPAL_ON_ARBITRUM || who === PRINCIPAL_ON_ROBINHOOD || who === PERP_ACCOUNT, `${c.id}: ${who}`);
      }
    }
  });

  it('the yield agent speaks of advertised APY, never a guaranteed one', () => {
    for (const c of DOMAIN_AGENTS.yield.candidates) {
      const text = JSON.stringify(viewOf(c));
      assert.match(text, /Advertised APY/);
      assert.match(text, /not guaranteed/);
      assert.doesNotMatch(text, /guaranteed APY/i);
    }
  });

  it('trusted code labels no candidate good or bad for the model', () => {
    for (const r of ROLES) for (const c of DOMAIN_AGENTS[r].candidates) assert.doesNotMatch(JSON.stringify({ ...viewOf(c), untrustedText: null }), /unapproved|unvetted|malicious|blocked|not allowed|reviewed|approved/i, c.id);
  });

  it('a returned id is resolved by exact lookup only', () => {
    assert.equal(candidateById(DOMAIN_AGENTS.swap, 'route-a')?.id, 'route-a');
    for (const id of ['ROUTE-A', 'route-a ', 'route', '../route-a', '']) assert.equal(candidateById(DOMAIN_AGENTS.swap, id), null);
  });
});

describe('JEV is advisory only', () => {
  it('the shipped advisor never ranks', async () => {
    assert.equal(await new NoopJevAdvisor().rank('swap', DOMAIN_AGENTS.swap.candidates.map((c) => viewOf(c))), null);
  });

  it('a recommendation can order known ids and nothing else', () => {
    const views = DOMAIN_AGENTS.swap.candidates.map((c) => viewOf(c));
    const out = applyAdvice(views, { ranking: ['route-z', 'route-b', 'route-b', 'route-a'], source: 'test' });
    assert.deepEqual(out.map((v) => v.id), views.map((v) => v.id));
    assert.deepEqual(out.map((v) => v.advisoryRank), [2, 1]);
    assert.deepEqual(out.map((v) => ({ ...v, advisoryRank: null })), views);
  });
});
