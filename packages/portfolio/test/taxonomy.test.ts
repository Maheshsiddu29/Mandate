/**
 * The portfolio's refusal taxonomy (AGENTS.md §4.5): the codes not produced
 * elsewhere are produced here, and every code in `PORTFOLIO_REASON_CODES` is
 * produced by at least one test in this package or by the committed corpus.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PORTFOLIO_REASON_CODES, compilePortfolio, deriveChildAuthorization, resolveCandidate, agentPolicyOf, type AgentPolicy } from '../src/index.ts';
import { DEMO_T0, demoBindings, demoMandate, demoMandateInput, demoParty } from '../src/demo/index.ts';
import { NOW, swap } from './support/candidates.ts';
import { proposal } from './support/world.ts';

const codes = (rs: readonly { code: string }[]) => [...new Set(rs.map((r) => r.code))].sort();

describe('codes produced here', () => {
  it('PORTFOLIO_MANDATE_MALFORMED: Core refuses to represent what the bindings compiled (a binding listed twice)', () => {
    const bindings = demoBindings();
    const c = compilePortfolio(demoMandate(), [...bindings, bindings[1] as never]);
    assert.deepEqual(c.ok ? [] : codes(c.error), ['PORTFOLIO_MANDATE_MALFORMED']);
  });

  it('AGENT_NOT_YET_VALID and AGENT_EXPIRED: inside the portfolio’s window, outside the agent’s', () => {
    const input = demoMandateInput();
    const narrowed = demoMandate({ agents: input.agents.map((a) => (a.label === 'swap' ? { ...a, notBefore: DEMO_T0 + 500n, expiresAt: DEMO_T0 + 900n } : a)) });
    const agent = agentPolicyOf(narrowed, demoParty('swap')) as AgentPolicy;
    const p = proposal(narrowed, 'swap', swap(), { createdAt: DEMO_T0, expiresAt: DEMO_T0 + 3_600n });
    const r = resolveCandidate(demoBindings(), narrowed, agent, p.proposal.candidate, NOW);
    assert.ok(r.ok);
    const early = deriveChildAuthorization(narrowed, p.proposal, r.action, DEMO_T0 + 100n);
    assert.ok(!early.ok && codes(early.reasons).includes('AGENT_NOT_YET_VALID'));
    const late = deriveChildAuthorization(narrowed, p.proposal, r.action, NOW);
    assert.ok(!late.ok && codes(late.reasons).includes('AGENT_EXPIRED'));
  });

  it('PROPOSAL_NOT_YET_VALID: a proposal dated after the decision time', () => {
    const m = demoMandate();
    const p = proposal(m, 'swap', swap(), { createdAt: NOW + 10n, expiresAt: NOW + 3_600n });
    const r = resolveCandidate(demoBindings(), m, agentPolicyOf(m, demoParty('swap')) as AgentPolicy, p.proposal.candidate, NOW);
    assert.ok(r.ok);
    const d = deriveChildAuthorization(m, p.proposal, r.action, NOW);
    assert.deepEqual(d.ok ? [] : codes(d.reasons), ['PROPOSAL_NOT_YET_VALID']);
  });
});

describe('the whole vocabulary is exercised', () => {
  it('every portfolio reason code is produced by a test in this package or by the committed corpus', () => {
    const dir = new URL('./', import.meta.url);
    const text = [
      ...readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => readFileSync(new URL(f, dir), 'utf8')),
      readFileSync(new URL('../../../corpus/portfolio-demo-v1/vectors.json', import.meta.url), 'utf8'),
    ].join('\n');
    const missing = PORTFOLIO_REASON_CODES.filter((c) => !text.includes(`'${c}'`) && !text.includes(`"${c}"`));
    assert.deepEqual(missing, []);
  });
});
