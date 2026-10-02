/**
 * Allocation intent (docs/v2/mandate-room-v2.md §3): who decides the split,
 * and what the principal can sign.
 *
 * - total + an amount per agent → FIXED, nothing to plan;
 * - total + enabled agents, no split → DYNAMIC, a plan is required;
 * - total only → NEEDS_AGENT_SELECTION: no agent is ever enabled by default;
 * - some amounts fixed → HYBRID over the remainder;
 * - budgets above the total, above an agent's ceiling or a domain cap, or for
 *   a disabled agent, are refused before signing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAllocation } from '../src/allocation/intent.ts';
import { applyPreset, presetDraft, withField, type MandateDraft } from '../src/authoring/draft-types.ts';
import { validateDraft } from '../src/authoring/draft-validator.ts';
import { draftFromInterpretation, interpretLocally } from '../src/authoring/prompt-to-draft.ts';
import { sessionBindings } from '../src/mandate/portfolio-adapter.ts';
import { DEMO_NOW } from '@mandate/portfolio/demo';

const fromPrompt = (prompt: string): MandateDraft => applyPreset(draftFromInterpretation(interpretLocally(prompt)), 'balanced', true).draft;
const validate = (d: MandateDraft, planning = false) => validateDraft(d, { version: 1, protocolNow: DEMO_NOW, bindings: sessionBindings(), planning });
const codes = (d: MandateDraft) => validate(d).issues.filter((i) => i.severity === 'BLOCKING').map((i) => i.code);
const USDC = (whole: number) => BigInt(whole) * 1_000_000n;

describe('allocation intent', () => {
  it('1. total and an amount for every agent is FIXED: no Planning Room, and the budgets are what is signed', () => {
    const d = fromPrompt('$2,000. Stock $800, Swap $400, Yield $500, Perps $300.');
    const v = classifyAllocation(d);
    assert.equal(v.intent, 'FIXED');
    assert.equal(v.planning, 'NONE');
    assert.deepEqual(v.fixed, ['stock', 'swap', 'yield', 'perps']);
    assert.deepEqual(v.pool, []);
    const r = validate(d);
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    // Without reallocation, each agent's signed maximum is its budget.
    const max = (role: string) => r.mandate?.agents.find((a) => a.label === role)?.hardMaxima.find((h) => h.resource === 'portfolio-notional')?.atoms;
    assert.deepEqual(['stock', 'swap', 'yield', 'perps'].map(max), [USDC(800), USDC(400), USDC(500), USDC(300)]);
    assert.equal(r.mandate?.limits.find((l) => l.resource === 'portfolio-notional')?.atoms, USDC(2000));
  });

  it('2. total and enabled agents with no split is DYNAMIC: a plan is required before signing', () => {
    const d = fromPrompt('$2,000 across Stock, Swap, Yield and Perps. Prefer balanced risk-adjusted opportunities.');
    const v = classifyAllocation(d);
    assert.equal(v.intent, 'DYNAMIC');
    assert.equal(v.planning, 'REQUIRED');
    assert.deepEqual(v.pool, ['stock', 'swap', 'yield', 'perps']);
    assert.equal(v.poolAtoms, USDC(2000));
    assert.deepEqual(codes(d), ['ALLOCATION_PLAN_REQUIRED']);
    // The planning pass compiles a provisional mandate; it is never signed.
    assert.equal(validate(d, true).ok, true);
  });

  it('3. total only needs agent selection: Fill never enables an agent', () => {
    for (const prompt of ['Manage $2,000', '$2,000 across approved agents.']) {
      const d = fromPrompt(prompt);
      const v = classifyAllocation(d);
      assert.equal(v.intent, 'NEEDS_AGENT_SELECTION', prompt);
      assert.deepEqual(v.enabled, []);
      assert.deepEqual(v.undecided, ['stock', 'swap', 'nft', 'yield', 'perps']);
      assert.ok(codes(d).filter((c) => c === 'MISSING_VALUE').length >= 5);
      for (const r of ['stock', 'swap', 'nft', 'yield', 'perps']) assert.equal(d.provenance[`agents.${r}.enabled`], undefined);
    }
  });

  it('4. some amounts fixed and the rest delegated is HYBRID over the remainder only', () => {
    const d = fromPrompt('Deploy $2,000. Stock $800. Let Swap, Yield and Perps decide how to use the rest.');
    const v = classifyAllocation(d);
    assert.equal(v.intent, 'HYBRID');
    assert.deepEqual(v.fixed, ['stock']);
    assert.deepEqual(v.pool, ['swap', 'yield', 'perps']);
    assert.equal(v.fixedAtoms, USDC(800));
    assert.equal(v.poolAtoms, USDC(1200));
  });

  it('5. fixed allocations above the total are invalid before signing', () => {
    const d = fromPrompt('$2,000. Stock $800, Swap $500, Yield $500, Perps $300.');
    assert.ok(codes(d).includes('ALLOCATION_EXCEEDS_TOTAL'));
  });

  it('6. a budget for a disabled agent is invalid', () => {
    let d = fromPrompt('$2,000. Stock $800, Swap $400, Yield $500, Perps $300.');
    d = withField(d, 'agents.nft.budget', '100', 'USER');
    assert.ok(codes(d).includes('ALLOCATION_AGENT_DISABLED'));
  });

  it('a budget above the agent ceiling, its exposure or a domain cap is invalid; malformed is invalid', () => {
    const base = fromPrompt('$2,000. Stock $800, Swap $400, Yield $500, Perps $300.');
    assert.ok(codes(withField(base, 'agents.perps.budget', '450', 'USER')).includes('ALLOCATION_EXCEEDS_DOMAIN_CAP'));
    assert.ok(codes(withField(withField(base, 'agents.swap.maxAllocation', '300', 'USER'), 'agents.swap.budget', '400', 'USER')).includes('ALLOCATION_EXCEEDS_AGENT_MAX'));
    assert.ok(codes(withField(base, 'agents.stock.budget', 'eight hundred', 'USER')).includes('INVALID_VALUE'));
  });

  it('with reallocation allowed, the signed maximum is the ceiling and budgets stay the plan', () => {
    const d = withField(fromPrompt('$2,000. Stock $800, Swap $400, Yield $500, Perps $300.'), 'portfolio.autoReallocate', true, 'USER');
    const r = validate(d);
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    const stock = r.mandate?.agents.find((a) => a.label === 'stock')?.hardMaxima.find((h) => h.resource === 'portfolio-notional')?.atoms;
    assert.equal(stock, USDC(800)); // balanced ceiling for stock
    const swap = r.mandate?.agents.find((a) => a.label === 'swap')?.hardMaxima.find((h) => h.resource === 'portfolio-notional')?.atoms;
    assert.equal(swap, USDC(500)); // ceiling 500, budget 400
  });

  it('an explicit preset is a live-coordination envelope: nothing to plan before signing', () => {
    const v = classifyAllocation(presetDraft('balanced'));
    assert.equal(v.intent, 'DYNAMIC');
    assert.equal(v.planning, 'OPTIONAL');
    assert.equal(validate(presetDraft('balanced')).ok, true);
  });

  it('editing a planned budget is the principal\'s own decision and needs no new Room', () => {
    let d = fromPrompt('$2,000 across Stock, Swap, Yield and Perps.');
    for (const [r, b] of [['stock', '750'], ['swap', '350'], ['yield', '650'], ['perps', '250']] as const) d = withField(d, `agents.${r}.budget`, b, 'PLANNED');
    assert.equal(classifyAllocation(d).planning, 'COMPLETE');
    assert.equal(validate(d).ok, true);
    d = withField(d, 'agents.stock.budget', '650', 'USER');
    d = withField(d, 'agents.yield.budget', '750', 'USER');
    const v = classifyAllocation(d);
    assert.equal(v.intent, 'HYBRID');
    assert.equal(v.planning, 'COMPLETE');
    assert.equal(validate(d).ok, true);
  });
});
