/**
 * Scenario C authority resolution
 * (untouched prompt from C2.2.1 judge acceptance).
 *
 * Proves planning budgets, deployable capital, preset ceilings, and the
 * unsupported per-trade note remain distinct dimensions — and that $500
 * per trade never becomes an aggregate portfolio or agent limit from the
 * model, while a legitimate PRESET ceiling of $500 is preserved.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_NOW } from '@mandate/portfolio/demo';
import { classifyAllocation } from '../src/allocation/intent.ts';
import { compileLocalPrompt } from '../src/authoring/compiler.ts';
import { applyPreset, presetFields } from '../src/authoring/draft-types.ts';
import { validateDraft } from '../src/authoring/draft-validator.ts';
import { draftIssuesBlockAuthorize } from '../src/authoring/issue-policy.ts';
import {
  draftFromInterpretation,
  interpretLocally,
  parseDraftInterpretation,
  preferExplicitPrompt,
} from '../src/authoring/prompt-to-draft.ts';
import { fieldAt, withField } from '../src/authoring/draft-types.ts';
import { sessionBindings } from '../src/mandate/portfolio-adapter.ts';

const PROMPT = 'I have $5k. Stock $2k, Yield $1k, no perps, Swap remainder, no trade above $500, approved venues only';
const USDC = (whole: number) => BigInt(whole) * 1_000_000n;
const ctx = { version: 1, protocolNow: DEMO_NOW, bindings: sessionBindings() };

/** Balanced independently defines Swap maxAllocation = 500 (not from per-trade). */
assert.equal(presetFields('balanced')['agents.swap.maxAllocation'], '500');

function adversarialClip(swapMax: string | null = '500') {
  return parseDraftInterpretation(JSON.stringify({
    portfolio: {
      totalCapital: '5000',
      minUnallocated: '0',
      maxDeployed: '5000',
      deployAll: false,
      maxDerivative: '0',
      maxIlliquid: '0',
      validityMinutes: '60',
      autoReallocate: false,
    },
    agents: [
      { role: 'stock', enabled: true, maxAllocation: '800', maxExposure: '800', budget: '800' },
      { role: 'swap', enabled: true, maxAllocation: swapMax, maxExposure: null, budget: '3400' },
      { role: 'nft', enabled: false, maxAllocation: null, maxExposure: null, budget: null },
      { role: 'yield', enabled: true, maxAllocation: '800', maxExposure: null, budget: '800' },
      { role: 'perps', enabled: false, maxAllocation: null, maxExposure: null, budget: null },
    ],
    market: {
      assets: null,
      issuers: null,
      representations: null,
      venues: ['swap-router'],
      chains: null,
      maxLeverage: null,
      maxSlippageBps: '100',
      maxQuoteAgeSeconds: '300',
      syntheticExposure: 'FORBIDDEN',
    },
    execution: { recipients: null },
    issues: [],
    notes: ['clipped to ceilings'],
  }));
}

describe('Scenario C — untouched authority resolution', () => {
  it('compiles the exact prompt into distinct capital dimensions', () => {
    const { draft, allocationIntent } = compileLocalPrompt(PROMPT);
    assert.equal(draft.portfolio.totalCapital, '5000');
    assert.equal(draft.portfolio.maxDeployed, '5000', 'stated capital is the deployable ceiling when no separate cap is named');
    assert.equal(draft.agents.stock.enabled, true);
    assert.equal(draft.agents.stock.budget, '2000');
    assert.equal(draft.agents.stock.maxAllocation, null, 'planned budget stays distinct from signed Up to');
    assert.equal(draft.agents.yield.enabled, true);
    assert.equal(draft.agents.yield.budget, '1000');
    assert.equal(draft.agents.yield.maxAllocation, null);
    assert.equal(draft.agents.swap.enabled, true);
    assert.equal(draft.agents.swap.budget, null, 'Swap remainder is delegated, not a fixed budget');
    assert.equal(draft.agents.perps.enabled, false);
    assert.equal(draft.agents.nft.enabled, false);
    assert.ok(draft.market.venues !== null && draft.market.venues.length > 0);
    assert.ok(draft.issues.some((i) => i.kind === 'UNSUPPORTED' && /per-trade/i.test(i.text)));
    assert.equal((draft as { market: { maxTrade?: unknown } }).market.maxTrade, undefined);

    assert.equal(allocationIntent.intent, 'HYBRID');
    assert.deepEqual(allocationIntent.fixed, ['stock', 'yield']);
    assert.deepEqual(allocationIntent.pool, ['swap']);
    assert.equal(allocationIntent.deployableAtoms, USDC(5000));
    assert.equal(allocationIntent.fixedAtoms, USDC(3000));
    assert.equal(allocationIntent.poolAtoms, USDC(2000), 'Swap remainder = deployable − fixed');
  });

  it('per-trade $500 does not mutate portfolio, agent, or room aggregates at compile time', () => {
    const d = compileLocalPrompt(PROMPT).draft;
    assert.equal(d.portfolio.totalCapital, '5000');
    assert.equal(d.portfolio.maxDeployed, '5000');
    assert.equal(d.agents.stock.budget, '2000');
    assert.equal(d.agents.stock.maxAllocation, null);
    assert.equal(d.agents.yield.budget, '1000');
    assert.equal(d.agents.yield.maxAllocation, null);
    assert.equal(d.agents.swap.budget, null);
    assert.equal(d.agents.swap.maxAllocation, null);
    const view = classifyAllocation(d);
    assert.equal(view.deployableAtoms, USDC(5000));
    assert.equal(view.poolAtoms, USDC(2000));
    assert.notEqual(d.portfolio.totalCapital, '2500');
    assert.notEqual(d.portfolio.maxDeployed, '2500');
    assert.notEqual(d.agents.stock.maxAllocation, '500');
    assert.notEqual(d.agents.swap.maxAllocation, '500');
  });

  it('a model inventing maxDeployed $2,500 loses to the stated $5k deployable', () => {
    const invented = parseDraftInterpretation(JSON.stringify({
      portfolio: {
        totalCapital: '5000',
        minUnallocated: '0',
        maxDeployed: '2500',
        deployAll: false,
        maxDerivative: '0',
        maxIlliquid: '0',
        validityMinutes: '60',
        autoReallocate: false,
      },
      agents: [
        { role: 'stock', enabled: true, maxAllocation: null, maxExposure: null, budget: '2000' },
        { role: 'swap', enabled: true, maxAllocation: '2000', maxExposure: null, budget: null },
        { role: 'nft', enabled: false, maxAllocation: null, maxExposure: null, budget: null },
        { role: 'yield', enabled: true, maxAllocation: null, maxExposure: null, budget: '1000' },
        { role: 'perps', enabled: false, maxAllocation: null, maxExposure: null, budget: null },
      ],
      market: {
        assets: null,
        issuers: null,
        representations: null,
        venues: ['swap-router'],
        chains: null,
        maxLeverage: null,
        maxSlippageBps: '100',
        maxQuoteAgeSeconds: '300',
        syntheticExposure: 'FORBIDDEN',
      },
      execution: { recipients: null },
      issues: [],
      notes: [],
    }));
    assert.equal(invented.ok, true);
    if (!invented.ok) return;
    const merged = preferExplicitPrompt(invented.value, PROMPT);
    assert.equal(merged.portfolio.maxDeployed, '5000');
    let draft = draftFromInterpretation(merged, 'MODEL_EXTRACTED');
    const local = draftFromInterpretation(interpretLocally(PROMPT), 'EXPLICIT_PROMPT');
    for (const path of Object.keys(local.provenance)) {
      const v = fieldAt(local, path);
      if (v !== null && v !== undefined) draft = withField(draft, path, v, 'EXPLICIT_PROMPT');
    }
    assert.equal(draft.portfolio.maxDeployed, '5000');
    assert.equal(classifyAllocation(draft).deployableAtoms, USDC(5000));
    assert.notEqual(draft.portfolio.maxDeployed, '2500');
  });

  it('balanced fill keeps stated $5k deployable, preserves PRESET Swap $500, and surfaces Stock/Yield conflicts', () => {
    const pure = compileLocalPrompt(PROMPT).draft;
    const filled = applyPreset(pure, 'balanced', true).draft;
    assert.equal(filled.portfolio.totalCapital, '5000');
    assert.equal(filled.portfolio.maxDeployed, '5000', 'fill must not shrink deployable to the balanced $2,500 envelope');
    assert.equal(filled.agents.stock.budget, '2000');
    assert.equal(filled.agents.stock.maxAllocation, '800', 'balanced preset ceiling is a default, not overwritten silently');
    assert.equal(filled.agents.stock.maxExposure, '800');
    assert.equal(filled.agents.yield.budget, '1000');
    assert.equal(filled.agents.yield.maxAllocation, '800');
    assert.equal(filled.provenance['agents.stock.maxAllocation'], 'PRESET');
    assert.equal(filled.provenance['agents.yield.maxAllocation'], 'PRESET');
    // Balanced independently defines Swap $500 — keep it even though per-trade is also $500.
    assert.equal(filled.agents.swap.maxAllocation, '500');
    assert.equal(filled.provenance['agents.swap.maxAllocation'], 'PRESET');
    assert.equal(filled.agents.swap.budget, null);

    const view = classifyAllocation(filled);
    assert.equal(view.deployableAtoms, USDC(5000));
    assert.equal(view.poolAtoms, USDC(2000), 'Swap remainder stays 2000');

    const validation = validateDraft(filled, ctx);
    assert.equal(validation.ok, false);
    assert.equal(draftIssuesBlockAuthorize(filled), true);
    assert.ok(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX' && /Stock requested \$2000/.test(i.message) && /ceiling is \$800/.test(i.message)));
    assert.ok(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX' && /Yield requested \$1000/.test(i.message) && /ceiling is \$800/.test(i.message)));
    assert.ok(validation.issues.some((i) => i.code === 'ALLOCATION_PLAN_REQUIRED' && /Part of the allocation is fixed/.test(i.message) && /2000 USDC/.test(i.message)));
    assert.equal(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_TOTAL' && /2500/.test(i.message)), false);
    assert.equal(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX' && /Swap requested \$3400/.test(i.message)), false);
    assert.ok(filled.issues.some((i) => i.kind === 'UNSUPPORTED' && /per-trade cap \(500 USDC\)/i.test(i.text)));
    assert.equal(validation.mandate, null, 'conflict remains unsigned — no authority is expanded');

    // Assigning the full remainder as Swap budget exposes the aggregate conflict.
    const withRemainder = withField(filled, 'agents.swap.budget', '2000', 'USER');
    const againstCeiling = validateDraft(withRemainder, ctx);
    assert.ok(againstCeiling.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX' && /Swap requested \$2000/.test(i.message) && /ceiling is \$500/.test(i.message)));
  });

  it('a model that clips budgets and invents Swap maxAllocation 500 from per-trade is undone; PRESET 500 may still fill', () => {
    const invented = adversarialClip('500');
    assert.equal(invented.ok, true);
    if (!invented.ok) return;
    const merged = preferExplicitPrompt(invented.value, PROMPT);
    assert.equal(merged.agents.find((a) => a.role === 'stock')?.budget, '2000', 'requested Stock budget is not clipped to 800');
    assert.equal(merged.agents.find((a) => a.role === 'yield')?.budget, '1000', 'requested Yield budget is not clipped to 800');
    assert.equal(merged.agents.find((a) => a.role === 'swap')?.budget, null, 'Swap remainder stays delegated — not expanded to 3400');
    assert.equal(merged.agents.find((a) => a.role === 'swap')?.maxAllocation, null, 'model-inferred per-trade ceiling discarded');

    let draft = draftFromInterpretation(merged, 'MODEL_EXTRACTED');
    const local = draftFromInterpretation(interpretLocally(PROMPT), 'EXPLICIT_PROMPT');
    for (const path of Object.keys(local.provenance)) {
      const v = fieldAt(local, path);
      if (v !== null && v !== undefined) draft = withField(draft, path, v, 'EXPLICIT_PROMPT');
    }
    for (const a of interpretLocally(PROMPT).agents) {
      if (a.budget === null && fieldAt(draft, `agents.${a.role}.budget`) !== null) {
        draft = withField(draft, `agents.${a.role}.budget`, null, 'EXPLICIT_PROMPT');
      }
    }
    draft = { ...draft, issues: [...local.issues, ...draft.issues] };
    assert.equal(draft.agents.swap.maxAllocation, null, 'before fill: model invention gone');
    const filled = applyPreset(draft, 'balanced', true).draft;

    assert.equal(filled.agents.stock.budget, '2000');
    assert.equal(filled.agents.yield.budget, '1000');
    assert.equal(filled.agents.swap.budget, null);
    assert.equal(filled.agents.stock.maxAllocation, '800');
    assert.equal(filled.agents.yield.maxAllocation, '800');
    assert.equal(filled.agents.swap.maxAllocation, '500');
    assert.equal(filled.provenance['agents.swap.maxAllocation'], 'PRESET', 'ceiling returns from PRESET, not from per-trade');
    assert.equal(classifyAllocation(filled).poolAtoms, USDC(2000));
    assert.ok(filled.issues.some((i) => i.kind === 'UNSUPPORTED' && /per-trade/i.test(i.text)));

    const validation = validateDraft(filled, ctx);
    assert.equal(validation.ok, false);
    assert.ok(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX' && /Stock requested \$2000/.test(i.message)));
    assert.ok(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX' && /Yield requested \$1000/.test(i.message)));
    assert.equal(validation.issues.some((i) => /Swap requested \$3400/.test(i.message)), false);
    assert.equal(draftIssuesBlockAuthorize(filled), true);
  });

  it('per-trade $450 does not suppress or change a PRESET Swap ceiling of $500', () => {
    const prompt = 'I have $5k. Stock $2k, Yield $1k, no perps, Swap remainder, no trade above $450, approved venues only';
    const filled = applyPreset(compileLocalPrompt(prompt).draft, 'balanced', true).draft;
    assert.ok(filled.issues.some((i) => i.kind === 'UNSUPPORTED' && /per-trade cap \(450 USDC\)/i.test(i.text)));
    assert.equal(filled.agents.swap.maxAllocation, '500');
    assert.equal(filled.provenance['agents.swap.maxAllocation'], 'PRESET');
    assert.equal(classifyAllocation(filled).poolAtoms, USDC(2000));
  });

  it('per-trade $500 does not change a distinct PRESET Swap ceiling of $750', () => {
    let d = compileLocalPrompt(PROMPT).draft;
    d = withField(d, 'agents.swap.maxAllocation', '750', 'PRESET');
    assert.ok(d.issues.some((i) => i.kind === 'UNSUPPORTED' && /per-trade cap \(500 USDC\)/i.test(i.text)));
    assert.equal(d.agents.swap.maxAllocation, '750');
    // Fill must not overwrite the existing PRESET ceiling or shrink it toward per-trade.
    const filled = applyPreset(d, 'balanced', true).draft;
    assert.equal(filled.agents.swap.maxAllocation, '750');
    assert.equal(filled.provenance['agents.swap.maxAllocation'], 'PRESET');
    assert.equal(classifyAllocation(filled).poolAtoms, USDC(2000));
  });

  it('unsupported per-trade never mutates aggregate authority in either direction', () => {
    const without = compileLocalPrompt('I have $5k. Stock $2k, Yield $1k, no perps, Swap remainder, approved venues only.').draft;
    const withTrade = compileLocalPrompt(PROMPT).draft;
    assert.equal(without.portfolio.totalCapital, withTrade.portfolio.totalCapital);
    assert.equal(without.portfolio.maxDeployed, withTrade.portfolio.maxDeployed);
    assert.equal(without.agents.stock.budget, withTrade.agents.stock.budget);
    assert.equal(without.agents.yield.budget, withTrade.agents.yield.budget);
    assert.equal(without.agents.swap.budget, withTrade.agents.swap.budget);
    assert.equal(without.agents.swap.maxAllocation, withTrade.agents.swap.maxAllocation);
    assert.equal(classifyAllocation(without).poolAtoms, classifyAllocation(withTrade).poolAtoms);

    const filledWithout = applyPreset(without, 'balanced', true).draft;
    const filledWith = applyPreset(withTrade, 'balanced', true).draft;
    assert.equal(filledWithout.agents.swap.maxAllocation, filledWith.agents.swap.maxAllocation);
    assert.equal(filledWithout.agents.stock.maxAllocation, filledWith.agents.stock.maxAllocation);
    assert.equal(filledWithout.agents.yield.maxAllocation, filledWith.agents.yield.maxAllocation);
    assert.equal(classifyAllocation(filledWithout).poolAtoms, classifyAllocation(filledWith).poolAtoms);
  });

  it('"Swap remainder, no trade above $500" never invents aggregate authority; PRESET may still supply one', () => {
    const phrase = 'Swap remainder, no trade above $500';
    const { draft } = compileLocalPrompt(phrase);
    assert.equal(draft.agents.swap.enabled, true);
    assert.equal(draft.agents.swap.budget, null);
    assert.equal(draft.agents.swap.maxAllocation, null);
    assert.ok(draft.issues.some((i) => i.kind === 'UNSUPPORTED' && /per-trade cap \(500 USDC\)/i.test(i.text)));
    const filled = applyPreset(draft, 'balanced', true).draft;
    assert.equal(filled.agents.swap.maxAllocation, '500');
    assert.equal(filled.provenance['agents.swap.maxAllocation'], 'PRESET');
    assert.equal(filled.agents.swap.budget, null);
  });

  it('raising the Stock/Yield/Swap ceilings clears the preset conflict without inventing capital', () => {
    let d = applyPreset(compileLocalPrompt(PROMPT).draft, 'balanced', true).draft;
    d = withField(d, 'agents.stock.maxAllocation', '2000', 'USER');
    d = withField(d, 'agents.stock.maxExposure', '2000', 'USER');
    d = withField(d, 'agents.yield.maxAllocation', '1000', 'USER');
    d = withField(d, 'agents.swap.maxAllocation', '2000', 'USER');
    d = withField(d, 'agents.swap.budget', '2000', 'USER');
    // Soft-acknowledge the unsupported per-trade note so it is not the only blocker.
    d = { ...d, issues: d.issues.filter((i) => !/per-trade/i.test(i.text)) };
    const validation = validateDraft(d, ctx);
    assert.equal(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX'), false);
    assert.equal(d.portfolio.totalCapital, '5000');
    assert.equal(classifyAllocation(d).deployableAtoms, USDC(5000));
  });
});
