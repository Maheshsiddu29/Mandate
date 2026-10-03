/**
 * C2.0 adversarial / coverage corpus — deterministic expectations over
 * `compileLocalPrompt` (docs/demo/c2-natural-language-mandate-compiler.md §18).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compileLocalPrompt, mergeFormOntoPrompt } from '../src/authoring/compiler.ts';
import { emptyDraft, withField } from '../src/authoring/draft-types.ts';
import { classifyAllocation } from '../src/allocation/intent.ts';
import { ROLES, type Role } from '../src/types.ts';

interface Expectation {
  readonly total?: string | null;
  readonly enabled?: { readonly [R in Role]?: boolean | null };
  readonly budget?: { readonly [R in Role]?: string | null };
  readonly maxAllocation?: { readonly [R in Role]?: string | null };
  readonly intent?: string;
  readonly leverage?: string | null;
  readonly minUnallocated?: string | null;
  readonly autoReallocate?: boolean | null;
  readonly issueKinds?: readonly string[];
  readonly issueMatches?: readonly string[];
  readonly noteMatches?: readonly string[];
  readonly venuesApproved?: boolean;
  readonly noRecipients?: boolean;
}

interface Case {
  readonly id: string;
  readonly category: string;
  readonly prompt: string;
  readonly expect: Expectation;
  readonly formTotal?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, 'fixtures/c2-prompt-corpus.json'), 'utf8')) as { readonly cases: readonly Case[] };

function check(c: Case): void {
  let draft = compileLocalPrompt(c.prompt).draft;
  if (c.formTotal !== undefined) {
    draft = mergeFormOntoPrompt(draft, withField(emptyDraft(), 'portfolio.totalCapital', c.formTotal, 'USER'));
  }
  const e = c.expect;
  if (e.total !== undefined) assert.equal(draft.portfolio.totalCapital, e.total, `${c.id} total`);
  if (e.minUnallocated !== undefined) assert.equal(draft.portfolio.minUnallocated, e.minUnallocated, `${c.id} minUnallocated`);
  if (e.autoReallocate !== undefined) assert.equal(draft.portfolio.autoReallocate, e.autoReallocate, `${c.id} autoReallocate`);
  if (e.leverage !== undefined) assert.equal(draft.market.maxLeverage, e.leverage, `${c.id} leverage`);
  if (e.enabled !== undefined) {
    for (const r of ROLES) {
      if (e.enabled[r] !== undefined) assert.equal(draft.agents[r].enabled, e.enabled[r], `${c.id} ${r}.enabled`);
    }
  }
  if (e.budget !== undefined) {
    for (const r of ROLES) {
      if (e.budget[r] !== undefined) assert.equal(draft.agents[r].budget, e.budget[r], `${c.id} ${r}.budget`);
    }
  }
  if (e.maxAllocation !== undefined) {
    for (const r of ROLES) {
      if (e.maxAllocation[r] !== undefined) assert.equal(draft.agents[r].maxAllocation, e.maxAllocation[r], `${c.id} ${r}.maxAllocation`);
    }
  }
  if (e.intent !== undefined) assert.equal(classifyAllocation(draft).intent, e.intent, `${c.id} intent`);
  if (e.issueKinds !== undefined) {
    for (const kind of e.issueKinds) assert.ok(draft.issues.some((i) => i.kind === kind), `${c.id} missing issue ${kind}: ${JSON.stringify(draft.issues)}`);
  }
  if (e.issueMatches !== undefined) {
    for (const re of e.issueMatches) assert.ok(draft.issues.some((i) => new RegExp(re, 'i').test(i.text)), `${c.id} issue /${re}/`);
  }
  if (e.noteMatches !== undefined) {
    for (const re of e.noteMatches) assert.ok(draft.notes.some((n) => new RegExp(re, 'i').test(n)), `${c.id} note /${re}/`);
  }
  if (e.venuesApproved === true) assert.ok(draft.market.venues !== null && draft.market.venues.length > 0, `${c.id} venues`);
  if (e.noRecipients === true) assert.equal(draft.execution.recipients, null, `${c.id} recipients`);
}

describe('C2.0 prompt corpus', () => {
  it('has at least 150 cases across required categories', () => {
    assert.ok(corpus.cases.length >= 150, `got ${corpus.cases.length}`);
    const cats = new Set(corpus.cases.map((c) => c.category));
    for (const required of ['CAPITAL', 'AGENT_SELECTION', 'FIXED', 'DYNAMIC', 'HYBRID', 'NEEDS_AGENT_SELECTION', 'ADVANCED', 'CONFLICTS', 'AMBIGUITIES', 'ADVERSARIAL', 'MULTI_SENTENCE', 'ACCEPTANCE']) {
      assert.ok(cats.has(required), `missing category ${required}`);
    }
  });

  for (const c of corpus.cases) {
    it(`${c.category}: ${c.id}`, () => check(c));
  }
});
