/**
 * Scenario C authority resolution
 * (untouched prompt from C2.2.1 judge acceptance).
 *
 * Proves planning budgets, deployable capital, preset ceilings, and the
 * unsupported per-trade note remain distinct dimensions — and that $500
 * per trade never becomes an aggregate portfolio or agent limit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_NOW } from '@mandate/portfolio/demo';
import { classifyAllocation } from '../src/allocation/intent.ts';
import { compileLocalPrompt } from '../src/authoring/compiler.ts';
import { applyPreset } from '../src/authoring/draft-types.ts';
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

  it('per-trade $500 does not mutate portfolio, agent, or room aggregates', () => {
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
    // No field equals 2500 or 500×N aggregate invention.
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

  it('balanced fill keeps stated $5k deployable and surfaces the $800 preset ceiling conflict without expanding authority', () => {
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
    // Balanced preset's Swap $500 must not apply when the prompt has an
    // unsupported per-trade of $500 — that would look like per-trade leaked
    // into Swap's aggregate ceiling.
    assert.notEqual(filled.agents.swap.maxAllocation, '500');
    assert.equal(filled.agents.swap.budget, null);

    const view = classifyAllocation(filled);
    assert.equal(view.deployableAtoms, USDC(5000));
    assert.equal(view.poolAtoms, USDC(2000));

    const validation = validateDraft(filled, ctx);
    assert.equal(validation.ok, false);
    assert.equal(draftIssuesBlockAuthorize(filled), true);
    assert.ok(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX' && /Stock requested \$2000/.test(i.message) && /ceiling is \$800/.test(i.message)));
    assert.ok(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX' && /Yield requested \$1000/.test(i.message) && /ceiling is \$800/.test(i.message)));
    assert.ok(validation.issues.some((i) => i.code === 'ALLOCATION_PLAN_REQUIRED' && /Part of the allocation is fixed/.test(i.message) && /2000 USDC/.test(i.message)));
    assert.equal(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_TOTAL' && /2500/.test(i.message)), false);
    assert.equal(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX' && /Swap requested \$3400/.test(i.message)), false);
    assert.equal(validation.mandate, null, 'conflict remains unsigned — no authority is expanded');
  });

  it('a model that clips budgets to ceilings and dumps remainder onto Swap is undone', () => {
    const invented = parseDraftInterpretation(JSON.stringify({
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
        { role: 'swap', enabled: true, maxAllocation: '500', maxExposure: null, budget: '3400' },
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
    assert.equal(invented.ok, true);
    if (!invented.ok) return;
    const merged = preferExplicitPrompt(invented.value, PROMPT);
    assert.equal(merged.agents.find((a) => a.role === 'stock')?.budget, '2000', 'requested Stock budget is not clipped to 800');
    assert.equal(merged.agents.find((a) => a.role === 'yield')?.budget, '1000', 'requested Yield budget is not clipped to 800');
    assert.equal(merged.agents.find((a) => a.role === 'swap')?.budget, null, 'Swap remainder stays delegated — not expanded to 3400');
    assert.equal(merged.agents.find((a) => a.role === 'swap')?.maxAllocation, null, 'per-trade $500 must not become Swap maxAllocation');

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
    const filled = applyPreset(draft, 'balanced', true).draft;

    assert.equal(filled.agents.stock.budget, '2000');
    assert.equal(filled.agents.yield.budget, '1000');
    assert.equal(filled.agents.swap.budget, null);
    assert.equal(filled.agents.stock.maxAllocation, '800');
    assert.equal(filled.agents.yield.maxAllocation, '800');
    assert.notEqual(filled.agents.swap.maxAllocation, '500');
    assert.equal(classifyAllocation(filled).poolAtoms, USDC(2000));
    assert.ok(filled.issues.some((i) => i.kind === 'UNSUPPORTED' && /per-trade/i.test(i.text)));

    const validation = validateDraft(filled, ctx);
    assert.equal(validation.ok, false);
    assert.ok(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX' && /Stock requested \$2000/.test(i.message)));
    assert.ok(validation.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX' && /Yield requested \$1000/.test(i.message)));
    assert.equal(validation.issues.some((i) => /Swap requested \$3400/.test(i.message)), false);
    assert.equal(draftIssuesBlockAuthorize(filled), true);
  });

  it('"Swap remainder, no trade above $500" never mutates aggregate agent authority', () => {
    const phrase = 'Swap remainder, no trade above $500';
    const { draft } = compileLocalPrompt(phrase);
    assert.equal(draft.agents.swap.enabled, true);
    assert.equal(draft.agents.swap.budget, null);
    assert.equal(draft.agents.swap.maxAllocation, null);
    assert.ok(draft.issues.some((i) => i.kind === 'UNSUPPORTED' && /per-trade cap \(500 USDC\)/i.test(i.text)));
    const filled = applyPreset(draft, 'balanced', true).draft;
    assert.notEqual(filled.agents.swap.maxAllocation, '500', 'per-trade must not become Swap aggregate via balanced fill');
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
