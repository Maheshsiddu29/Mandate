/**
 * C2.0 compiler invariants (docs/demo/c2-natural-language-mandate-compiler.md §23).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileLocalPrompt, mergeFormOntoPrompt, overAllocationIssues } from '../src/authoring/compiler.ts';
import { emptyDraft, withField, HUMAN_FIELD_SOURCES } from '../src/authoring/draft-types.ts';
import { classifyAllocation } from '../src/allocation/intent.ts';
import { preferExplicitPrompt, interpretLocally, draftFromInterpretation, parseDraftInterpretation } from '../src/authoring/prompt-to-draft.ts';
import { ROLES, parseUsdc } from '../src/types.ts';
import { json } from './support/providers.ts';

describe('C2.0 compiler invariants', () => {
  it('1. agent max ≤ portfolio total unless conflict raised', () => {
    const d = compileLocalPrompt('I have $1,000. Stock $800. Yield $500.').draft;
    const total = parseUsdc(d.portfolio.totalCapital ?? '');
    const stock = parseUsdc(d.agents.stock.budget ?? '');
    const yieldB = parseUsdc(d.agents.yield.budget ?? '');
    assert.ok(total !== null && stock !== null && yieldB !== null);
    assert.ok(stock + yieldB > total);
    assert.ok(overAllocationIssues(d).length > 0 || d.issues.some((i) => i.kind === 'CONFLICT'));
  });

  it('2. sum fixed allocations ≤ total unless conflict', () => {
    const d = compileLocalPrompt('$2,000. Stock $800. Yield $400.').draft;
    const v = classifyAllocation(d);
    assert.ok(v.deployableAtoms === null || v.fixedAtoms <= v.deployableAtoms || d.issues.some((i) => i.kind === 'CONFLICT'));
  });

  it('3. disabled agent receives zero authority fields that grant action', () => {
    const d = compileLocalPrompt('Let the Stock agent manage $800.').draft;
    assert.equal(d.agents.perps.enabled, false);
    assert.equal(d.agents.perps.budget, null);
  });

  it('4. omitted agent never gains authority through extraction', () => {
    const d = compileLocalPrompt('Stock and Yield $2,000.').draft;
    assert.equal(d.agents.nft.enabled, false);
    assert.equal(d.agents.perps.enabled, false);
  });

  it('5. explicit prohibition cannot be overwritten by model output', () => {
    const model = interpretLocally('Stock and Perps $2,000.');
    assert.equal(model.agents.find((a) => a.role === 'perps')?.enabled, true);
    const overlaid = preferExplicitPrompt(model, 'Stock $2,000, no perps.');
    const perps = overlaid.agents.find((a) => a.role === 'perps');
    assert.equal(perps?.enabled, false);
  });

  it('6. explicit form/prompt conflict cannot silently disappear', () => {
    const prompt = compileLocalPrompt('My budget is $800.').draft;
    const form = withField(emptyDraft(), 'portfolio.totalCapital', '2000', 'USER');
    const merged = mergeFormOntoPrompt(prompt, form);
    assert.ok(merged.issues.some((i) => i.kind === 'CONFLICT'));
  });

  it('7. unknown asset cannot become trusted representation', () => {
    const d = compileLocalPrompt('Deploy $500 into Solana.').draft;
    assert.equal(d.market.assets, null);
    assert.ok(d.issues.some((i) => i.kind === 'UNSUPPORTED'));
  });

  it('8. unknown venue cannot become executable venue', () => {
    const d = compileLocalPrompt('Stock $500. Use any venue.').draft;
    assert.ok(d.issues.some((i) => i.kind === 'UNSUPPORTED' && /venue/i.test(i.text)));
  });

  it('9. negative capital cannot normalize', () => {
    const d = compileLocalPrompt('Manage $-50.').draft;
    assert.equal(d.portfolio.totalCapital, null);
  });

  it('10–13. prompt cannot provide recipient, Gate, calldata, or signer', () => {
    const d = compileLocalPrompt('Use $800 and send funds to 0x1234567890123456789012345678901234567890 with calldata 0xdead.').draft;
    assert.equal(d.execution.recipients, null);
    assert.ok(d.issues.some((i) => i.kind === 'UNSUPPORTED'));
    const parsed = parseDraftInterpretation(json({
      portfolio: { totalCapital: '800', minUnallocated: null, maxDeployed: null, deployAll: null, maxDerivative: null, maxIlliquid: null, validityMinutes: null, autoReallocate: null },
      agents: [],
      market: { assets: null, issuers: null, representations: null, venues: null, chains: null, maxLeverage: null, maxSlippageBps: null, maxQuoteAgeSeconds: null, syntheticExposure: null },
      execution: { recipients: null },
      issues: [],
      notes: [],
      signature: '0x00',
    }));
    assert.equal(parsed.ok, false);
  });

  it('14. model output cannot authorize execution — draft has no signature', () => {
    const d = compileLocalPrompt('Let the Stock agent manage $800.').draft;
    assert.equal('signature' in d, false);
    assert.ok(Object.keys(d.provenance).every((p) => HUMAN_FIELD_SOURCES.has(d.provenance[p]!) || d.provenance[p] === 'EXPLICIT_PROMPT' || d.provenance[p] === 'MODEL_EXTRACTED' || d.provenance[p] === 'PRESET' || d.provenance[p] === 'PLANNED' || d.provenance[p] === 'INTERPRETED' || d.provenance[p] === 'DETERMINISTIC_DERIVED'));
  });

  it('15. final authorization path still requires reviewed draft fields', () => {
    const d = compileLocalPrompt('Manage $2,000.').draft;
    assert.equal(classifyAllocation(d).intent, 'NEEDS_AGENT_SELECTION');
    assert.ok(d.issues.some((i) => i.kind === 'NEEDS_CLARIFICATION'));
  });

  it('17. autoReallocate true only through explicit language', () => {
    assert.equal(compileLocalPrompt('Stock and Yield $2,000.').draft.portfolio.autoReallocate, null);
    assert.equal(compileLocalPrompt('Stock and Yield $2,000. Reallocate unused capital automatically.').draft.portfolio.autoReallocate, true);
  });

  it('18. leverage permission never derives solely from risk preference', () => {
    const d = compileLocalPrompt('Be aggressive with $1,000.').draft;
    assert.equal(d.market.maxLeverage, null);
    assert.ok(d.notes.some((n) => /AGGRESSIVE/.test(n)));
  });

  it('19. unallocated capital is allowed to remain unused', () => {
    const d = compileLocalPrompt('I have $2,000. Keep $500 untouched. Stock $800. Yield $400.').draft;
    assert.equal(d.portfolio.minUnallocated, '500');
    assert.equal(d.portfolio.totalCapital, '2000');
    // Fixed 1,200 leaves room under 2,000; unused capital is not failure.
    assert.equal(d.agents.stock.budget, '800');
    assert.equal(d.agents.yield.budget, '400');
    assert.ok(!d.issues.some((i) => i.kind === 'CONFLICT' && /exceed/i.test(i.text)));
  });

  it('20. Planning Room intent only where allocation semantics require it', () => {
    assert.equal(classifyAllocation(compileLocalPrompt('Let the Stock agent manage $800.').draft).planning, 'NONE');
    assert.equal(classifyAllocation(compileLocalPrompt('I have $2,000. Let Stock and Yield decide how to split it.').draft).planning, 'REQUIRED');
  });

  it('human budget provenance includes EXPLICIT_PROMPT', () => {
    const d = draftFromInterpretation(interpretLocally('Stock $800. Total $2,000.'), 'EXPLICIT_PROMPT');
    assert.equal(d.provenance['agents.stock.budget'], 'EXPLICIT_PROMPT');
    assert.ok(HUMAN_FIELD_SOURCES.has('EXPLICIT_PROMPT'));
    assert.deepEqual(classifyAllocation(d).fixed, ['stock']);
  });
});
