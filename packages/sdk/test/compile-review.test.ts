/**
 * C3.2 — compile + review facade parity with `@mandate/live-agents`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_NOW } from '@mandate/portfolio/demo';
import {
  classifyAllocation,
  compileLocalPrompt,
  draftIssuesBlockAuthorize,
  sessionBindings,
  validateDraft,
} from '@mandate/live-agents';
import { createMandateClient, liveLabDomainBindings } from '../src/index.ts';

const SCENARIO_C = 'I have $5k. Stock $2k, Yield $1k, no perps, Swap remainder, no trade above $500, approved venues only';
const STOCK_PROMPT = 'Let the Stock agent manage $800';

describe('sdk compile + review', () => {
  it('compile matches compileLocalPrompt for representative prompts', async () => {
    const client = createMandateClient({
      principal: '0x1111111111111111111111111111111111111111',
      chainId: 1,
      now: () => DEMO_NOW,
      bindings: liveLabDomainBindings(),
    });
    for (const instruction of [STOCK_PROMPT, SCENARIO_C]) {
      const direct = compileLocalPrompt(instruction);
      const viaSdk = await client.compile({ instruction });
      assert.deepEqual(viaSdk.draft, direct.draft);
      assert.deepEqual(viaSdk.allocation, direct.allocationIntent);
      assert.equal(viaSdk.compile.draft, viaSdk.draft);
    }
  });

  it('review signable gate matches issue-policy + validateDraft + allocation', async () => {
    const bindings = sessionBindings();
    const client = createMandateClient({
      principal: '0x1111111111111111111111111111111111111111',
      chainId: 1,
      now: () => DEMO_NOW,
      bindings,
    });
    const { draft } = await client.compile({ instruction: SCENARIO_C });
    const review = client.review(draft);
    const allocation = classifyAllocation(draft);
    const validation = validateDraft(draft, { version: 1, protocolNow: DEMO_NOW, bindings });
    const expectedSignable =
      validation.ok &&
      !draftIssuesBlockAuthorize(draft) &&
      allocation.intent !== 'NEEDS_AGENT_SELECTION' &&
      allocation.planning !== 'REQUIRED';
    assert.equal(review.signable, expectedSignable);
    assert.equal(review.signable, false, 'Scenario C keeps unsupported per-trade note blocking');
    assert.ok(review.issues.some((i) => i.kind === 'UNSUPPORTED' && /per-trade/i.test(i.text)));
    assert.ok(review.blockers.length > 0);
  });

  it('unsupported mandatory semantics remain blocked through the SDK', async () => {
    const client = createMandateClient({
      principal: '0x1111111111111111111111111111111111111111',
      chainId: 1,
      now: () => DEMO_NOW,
      bindings: liveLabDomainBindings(),
    });
    const { draft } = await client.compile({
      instruction: 'Send profits to 0x0000000000000000000000000000000000000001 forever on any venue',
    });
    const review = client.review(draft);
    assert.equal(review.signable, false);
    assert.ok(review.issues.some((i) => i.dangerous || i.kind === 'UNSUPPORTED' || i.kind === 'AMBIGUOUS' || i.kind === 'CONFLICT'));
  });
});
