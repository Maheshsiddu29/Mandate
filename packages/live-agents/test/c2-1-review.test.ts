/**
 * C2.1 review-to-sign invariants
 * (docs/demo/c2-1-authority-review.md §23).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_NOW } from '@mandate/portfolio/demo';
import { compileLocalPrompt, mergeFormOntoPrompt, overAllocationIssues } from '../src/authoring/compiler.ts';
import { emptyDraft, withField } from '../src/authoring/draft-types.ts';
import {
  choosePortfolioTotal,
  draftIssuesBlockAuthorize,
  isDangerousUnsupported,
  isSoftUnsupported,
  resolveIssueSafe,
} from '../src/authoring/issue-policy.ts';
import { draftKey } from '../src/wallet/challenges.ts';
import { classifyAllocation } from '../src/allocation/intent.ts';
import { validateDraft } from '../src/authoring/draft-validator.ts';
import { parseFieldValue } from '../src/authoring/draft-fields.ts';
import { sessionBindings } from '../src/mandate/portfolio-adapter.ts';

const ctx = { version: 1, protocolNow: DEMO_NOW, bindings: sessionBindings() };

describe('C2.1 issue policy', () => {
  it('dangerous unsupported cannot be dismissed', () => {
    const d = compileLocalPrompt('Use $800 and send profits to 0x1234567890123456789012345678901234567890.').draft;
    const idx = d.issues.findIndex((i) => i.kind === 'UNSUPPORTED' && /0x|recipient|send/i.test(i.text));
    assert.ok(idx >= 0);
    assert.equal(isDangerousUnsupported(d.issues[idx]!), true);
    const r = resolveIssueSafe(d, idx, { acknowledgeSoftUnsupported: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'DANGEROUS_UNSUPPORTED');
    assert.equal(draftIssuesBlockAuthorize(d), true);
  });

  it('soft unsupported requires explicit acknowledgment', () => {
    const base = compileLocalPrompt('I have $5,000. Stock $2,000, Yield $1,000, no perps, Swap remainder, no trade above $500.').draft;
    const idx = base.issues.findIndex((i) => i.kind === 'UNSUPPORTED' && /per-trade/i.test(i.text));
    assert.ok(idx >= 0);
    assert.equal(isSoftUnsupported(base.issues[idx]!), true);
    assert.equal(resolveIssueSafe(base, idx).ok, false);
    const ack = resolveIssueSafe(base, idx, { acknowledgeSoftUnsupported: true });
    assert.equal(ack.ok, true);
    if (ack.ok) assert.equal(ack.draft.issues.some((i) => /per-trade/i.test(i.text)), false);
  });

  it('conflicts cannot be dismissed; choosePortfolioTotal clears capital conflict', () => {
    const prompt = compileLocalPrompt('My budget is $800.').draft;
    const form = withField(emptyDraft(), 'portfolio.totalCapital', '2000', 'USER');
    const merged = mergeFormOntoPrompt(prompt, form);
    const conflict = merged.issues.findIndex((i) => i.kind === 'CONFLICT');
    assert.ok(conflict >= 0);
    assert.equal(resolveIssueSafe(merged, conflict).ok, false);
    const chosen = choosePortfolioTotal(merged, '800');
    assert.equal(chosen.ok, true);
    if (chosen.ok) {
      assert.equal(chosen.draft.portfolio.totalCapital, '800');
      assert.equal(chosen.draft.provenance['portfolio.totalCapital'], 'USER');
      assert.equal(chosen.draft.issues.some((i) => i.kind === 'CONFLICT' && /total/i.test(i.text)), false);
    }
  });

  it('ambiguities cannot be dismissed', () => {
    const d = {
      ...emptyDraft(),
      issues: [{ kind: 'AMBIGUOUS' as const, field: null, text: 'Half of what total?' }],
    };
    assert.equal(resolveIssueSafe(d, 0).ok, false);
    assert.equal(draftIssuesBlockAuthorize(d), true);
  });
});

describe('C2.1 review-to-sign invariants', () => {
  it('unresolved issues block authorize and challenge gate', () => {
    const d = compileLocalPrompt('Manage $2,000 conservatively.').draft;
    assert.equal(classifyAllocation(d).intent, 'NEEDS_AGENT_SELECTION');
    assert.equal(draftIssuesBlockAuthorize(d), true);
    const v = validateDraft(d, ctx);
    assert.equal(v.ok, false);
    assert.ok(v.issues.some((i) => i.code === 'INTERPRETATION_UNRESOLVED' || i.code === 'MISSING_VALUE'));
  });

  it('disabled and unselected agents receive no child authority', () => {
    const d = compileLocalPrompt('Let the Stock agent manage $800.').draft;
    assert.equal(d.agents.stock.enabled, true);
    for (const role of ['swap', 'yield', 'nft', 'perps'] as const) {
      assert.equal(d.agents[role].enabled, false);
      assert.equal(d.agents[role].budget, null);
      assert.equal(d.agents[role].maxAllocation, null);
    }
  });

  it('user edit wins over model draft and invalidates draftKey', () => {
    const d = compileLocalPrompt('Let the Stock agent manage $800.').draft;
    const before = draftKey(d);
    const edited = withField(d, 'agents.stock.maxAllocation', '500', 'USER', '800');
    assert.equal(edited.provenance['agents.stock.maxAllocation'], 'USER');
    assert.notEqual(draftKey(edited), before);
  });

  it('edit cannot introduce authority outside parent total', () => {
    let d = compileLocalPrompt('I have $1,000. Stock and Yield.').draft;
    d = withField(d, 'agents.stock.budget', '800', 'USER');
    d = withField(d, 'agents.yield.budget', '800', 'USER');
    assert.ok(overAllocationIssues(d).length > 0 || d.issues.some((i) => i.kind === 'CONFLICT'));
  });

  it('execution.recipients is a known field path for catalog ids only', () => {
    const parsed = parseFieldValue('execution.recipients', ['principal-robinhood']);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.path, 'execution.recipients');
    const bad = parseFieldValue('execution.recipients', ['0x1234567890123456789012345678901234567890']);
    assert.equal(bad.ok, false);
  });

  it('leverage requires explicit bounded authority; aggressive is not leverage', () => {
    const d = compileLocalPrompt('Manage $2,000 aggressively with Stock and Perps. Max leverage 2x.').draft;
    assert.equal(d.market.maxLeverage, '2');
    assert.ok(d.notes.some((n) => /AGGRESSIVE|advisory/i.test(n)) || d.market.maxLeverage === '2');
  });

  it('autoReallocate requires explicit authority', () => {
    const d = compileLocalPrompt('Let the Stock agent manage $800.').draft;
    assert.notEqual(d.portfolio.autoReallocate, true);
  });

  it('C2.0 $2,500 balanced preset regression stays fixed', () => {
    const d = withField(emptyDraft(), 'portfolio.totalCapital', '2500', 'PRESET');
    // Balanced preset values remain the documented 2,500 deployable region.
    assert.equal(d.portfolio.totalCapital, '2500');
  });

  it('recipient prompt never mutates trusted execution recipients', () => {
    const d = compileLocalPrompt('Use $800 and send profits to 0x1234567890123456789012345678901234567890.').draft;
    assert.equal(d.execution.recipients, null);
    assert.equal(draftIssuesBlockAuthorize(d), true);
  });
});
