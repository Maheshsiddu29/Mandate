/**
 * C2.0 acceptance prompts A–H
 * (docs/demo/c2-natural-language-mandate-compiler.md §26).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileLocalPrompt, mergeFormOntoPrompt } from '../src/authoring/compiler.ts';
import { withField, emptyDraft } from '../src/authoring/draft-types.ts';
import { classifyAllocation } from '../src/allocation/intent.ts';
import { preferExplicitPrompt, interpretLocally, draftFromInterpretation } from '../src/authoring/prompt-to-draft.ts';

const draftOf = (prompt: string) => compileLocalPrompt(prompt).draft;

describe('C2.0 acceptance prompts', () => {
  it('A: Let the Stock agent manage $800', () => {
    const d = draftOf('Let the Stock agent manage $800.');
    assert.equal(d.portfolio.totalCapital, '800');
    assert.equal(d.agents.stock.enabled, true);
    assert.equal(d.agents.stock.maxAllocation, '800');
    assert.equal(d.agents.swap.enabled, false);
    assert.equal(d.agents.yield.enabled, false);
    assert.equal(d.agents.nft.enabled, false);
    assert.equal(d.agents.perps.enabled, false);
    assert.equal(d.provenance['portfolio.totalCapital'], 'EXPLICIT_PROMPT');
  });

  it('B: Stock and Yield decide how to split $2,000 → DYNAMIC', () => {
    const d = draftOf('I have $2,000. Let Stock and Yield decide how to split it.');
    assert.equal(d.portfolio.totalCapital, '2000');
    assert.equal(d.agents.stock.enabled, true);
    assert.equal(d.agents.yield.enabled, true);
    assert.equal(d.agents.perps.enabled, false);
    assert.equal(d.agents.stock.budget, null);
    assert.equal(d.agents.yield.budget, null);
    assert.equal(classifyAllocation(d).intent, 'DYNAMIC');
  });

  it('C: Give Stock $800 and Yield $400 with remaining $800', () => {
    // Room V2 HYBRID needs a delegated agent without a principal budget. When
    // every named agent already has a fixed budget, the remainder is unused
    // capital (FIXED + unused), not a silent re-open of those budgets.
    const d = draftOf('Give Stock $800 and Yield $400. Let them decide how to use the remaining $800.');
    assert.equal(d.portfolio.totalCapital, '2000');
    assert.equal(d.agents.stock.budget, '800');
    assert.equal(d.agents.yield.budget, '400');
    const view = classifyAllocation(d);
    assert.equal(view.intent, 'FIXED');
    assert.equal(view.fixedAtoms, 1_200_000_000n);
    assert.equal(view.deployableAtoms, 2_000_000_000n);
    assert.ok(d.notes.some((n) => /remaining|left to the remaining agents/i.test(n)));
  });

  it('C2: Stock fixed + others decide remainder → HYBRID', () => {
    const d = draftOf('Deploy $2,000. Stock $800. Let Swap, Yield and Perps decide how to use the rest.');
    const view = classifyAllocation(d);
    assert.equal(view.intent, 'HYBRID');
    assert.deepEqual(view.fixed, ['stock']);
    assert.ok(view.pool.includes('swap'));
  });

  it('D: Manage $2,000 conservatively → NEEDS_AGENT_SELECTION', () => {
    const d = draftOf('Manage $2,000 conservatively.');
    assert.equal(d.portfolio.totalCapital, '2000');
    assert.ok(d.notes.some((n) => /CONSERVATIVE/.test(n)));
    assert.equal(d.agents.stock.enabled, null);
    assert.equal(d.agents.perps.enabled, null);
    assert.equal(d.market.maxLeverage, null);
    assert.equal(classifyAllocation(d).intent, 'NEEDS_AGENT_SELECTION');
    assert.ok(d.issues.some((i) => i.kind === 'NEEDS_CLARIFICATION' && /Which agents/.test(i.text)));
  });

  it('E: Stock + Perps with leverage and untouched reserve', () => {
    const d = draftOf('Stock and Perps can use $2k, but Perps max $400, never above 2x leverage, and keep at least $1k untouched.');
    assert.equal(d.portfolio.totalCapital, '2000');
    assert.equal(d.agents.stock.enabled, true);
    assert.equal(d.agents.perps.enabled, true);
    assert.equal(d.agents.perps.maxAllocation, '400');
    assert.equal(d.portfolio.maxDerivative, '400');
    assert.equal(d.market.maxLeverage, '2');
    assert.equal(d.portfolio.minUnallocated, '1000');
    assert.equal(d.agents.nft.enabled, false);
  });

  it('F: five-thousand hybrid with approved venues and per-trade note', () => {
    const d = draftOf('I have $5k. Stock can use $2k, Yield $1k, no perps, Swap can use the remainder, no trade above $500, approved venues only.');
    assert.equal(d.portfolio.totalCapital, '5000');
    assert.equal(d.agents.stock.enabled, true);
    assert.equal(d.agents.stock.budget, '2000');
    assert.equal(d.agents.yield.enabled, true);
    assert.equal(d.agents.yield.budget, '1000');
    assert.equal(d.agents.swap.enabled, true);
    assert.equal(d.agents.swap.budget, null);
    assert.equal(d.agents.perps.enabled, false);
    assert.equal(d.agents.nft.enabled, false);
    assert.ok(d.market.venues !== null && d.market.venues.length > 0);
    assert.ok(d.issues.some((i) => i.kind === 'UNSUPPORTED' && /per-trade/i.test(i.text)));
    assert.equal(classifyAllocation(d).intent, 'HYBRID');
  });

  it('F′: exact advanced judge prompt — per-trade remains NOT SUPPORTED', () => {
    const d = draftOf('I have $5k. Stock $2k, Yield $1k, no perps, Swap remainder, no trade above $500, approved venues only.');
    assert.equal(d.portfolio.totalCapital, '5000');
    assert.equal(d.agents.stock.enabled, true);
    assert.equal(d.agents.stock.budget, '2000');
    assert.equal(d.agents.yield.enabled, true);
    assert.equal(d.agents.yield.budget, '1000');
    assert.equal(d.agents.perps.enabled, false);
    assert.equal(d.agents.swap.enabled, true);
    assert.equal(d.agents.swap.budget, null);
    assert.ok(d.market.venues !== null && d.market.venues.length > 0);
    assert.ok(d.issues.some((i) => i.kind === 'UNSUPPORTED' && /per-trade/i.test(i.text)));
    // Per-trade is presentation-only: it never becomes a signed mandate field.
    assert.equal((d as { market: { maxTrade?: unknown } }).market.maxTrade, undefined);
    assert.equal(classifyAllocation(d).intent, 'HYBRID');
  });

  it('G: recipient address is UNSUPPORTED', () => {
    const d = draftOf('Use $800 but send the output to 0x1234567890123456789012345678901234567890.');
    assert.equal(d.portfolio.totalCapital, '800');
    assert.ok(d.issues.some((i) => i.kind === 'UNSUPPORTED' && /recipient/i.test(i.text)));
    assert.equal(d.execution.recipients, null);
  });

  it('H: aggressive without leverage bound', () => {
    const d = draftOf('Be aggressive and use whatever leverage you need.');
    assert.ok(d.notes.some((n) => /AGGRESSIVE/.test(n)));
    assert.equal(d.market.maxLeverage, null);
    assert.ok(d.issues.some((i) => i.kind === 'UNSUPPORTED' && /leverage/i.test(i.text)));
    assert.equal(d.agents.perps.enabled, null);
  });

  it('form vs prompt capital is a CONFLICT, not silent precedence', () => {
    const prompt = draftOf('My total budget is $800.');
    const form = withField(emptyDraft(), 'portfolio.totalCapital', '2000', 'USER');
    const merged = mergeFormOntoPrompt(prompt, form);
    assert.ok(merged.issues.some((i) => i.kind === 'CONFLICT' && /\$2000/.test(i.text) && /\$800/.test(i.text)));
    assert.equal(merged.portfolio.totalCapital, '2000');
  });

  it('risk preference never enables Perps or leverage', () => {
    const d = draftOf('Be aggressive with $1,000.');
    assert.equal(d.agents.perps.enabled, null);
    assert.equal(d.market.maxLeverage, null);
    assert.equal(d.portfolio.autoReallocate, null);
  });

  it('model cannot overwrite explicit $800 with $2500', () => {
    const invented = interpretLocally('Deploy $2,500 across stocks.');
    const overlaid = preferExplicitPrompt(invented, 'Let the Stock agent manage $800.');
    const d = draftFromInterpretation(overlaid, 'EXPLICIT_PROMPT');
    assert.equal(d.portfolio.totalCapital, '800');
    assert.notEqual(d.portfolio.totalCapital, '2500');
  });

  it('every agent explicitly enables all five', () => {
    const d = draftOf('Let every agent use $5,000.');
    assert.equal(d.portfolio.totalCapital, '5000');
    for (const r of ['stock', 'swap', 'nft', 'yield', 'perps'] as const) assert.equal(d.agents[r].enabled, true);
  });
});
