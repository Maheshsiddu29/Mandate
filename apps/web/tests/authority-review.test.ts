/**
 * C2.1 authority Review presentation
 * (docs/demo/c2-1-authority-review.md).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildAuthorityReview } from '../components/demo/live/authority-review.ts';
import type { AllocationState } from '../components/demo/live/allocation-model.ts';
import type { JsonRecord } from '../components/demo/live/live-client.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const configure = read('../components/demo/live/stage-configure.tsx');
const reviewSrc = read('../components/demo/live/authority-review.ts');
const lab = read('../components/demo/live/live-lab.tsx');
const planning = read('../components/demo/live/stage-planning.tsx');
const css = read('../components/demo/live/live-workspace.css');

const agent = (enabled: boolean | null, budget: string | null = null, maxAllocation: string | null = null) => ({
  enabled,
  budget,
  maxAllocation,
  maxExposure: null,
});

function draft(partial: {
  total?: string | null;
  minUnallocated?: string | null;
  maxDeployed?: string | null;
  autoReallocate?: boolean | null;
  maxLeverage?: string | null;
  venues?: readonly string[] | null;
  agents?: Partial<Record<'stock' | 'swap' | 'yield' | 'nft' | 'perps', ReturnType<typeof agent>>>;
  issues?: readonly { kind: string; field: string | null; text: string }[];
  notes?: readonly string[];
  provenance?: Record<string, string>;
  evidence?: Record<string, { sourceText: string }>;
}): JsonRecord {
  const agents = {
    stock: agent(false),
    swap: agent(false),
    yield: agent(false),
    nft: agent(false),
    perps: agent(false),
    ...partial.agents,
  };
  return {
    portfolio: {
      totalCapital: partial.total ?? null,
      minUnallocated: partial.minUnallocated ?? null,
      maxDeployed: partial.maxDeployed ?? partial.total ?? null,
      deployAll: null,
      maxDerivative: null,
      maxIlliquid: null,
      validityMinutes: '60',
      autoReallocate: partial.autoReallocate ?? false,
    },
    agents,
    market: {
      assets: null,
      issuers: null,
      representations: null,
      venues: partial.venues ?? null,
      chains: null,
      maxLeverage: partial.maxLeverage ?? null,
      maxSlippageBps: null,
      maxQuoteAgeSeconds: null,
    },
    execution: { recipients: null },
    issues: partial.issues ?? [],
    notes: partial.notes ?? [],
    provenance: partial.provenance ?? {},
    evidence: partial.evidence ?? {},
  };
}

function allocation(partial: Partial<AllocationState> & Pick<AllocationState, 'intent'>): AllocationState {
  return {
    planning: 'NONE',
    enabled: [],
    undecided: [],
    fixed: [],
    pool: [],
    autoReallocate: false,
    deployable: '800',
    pooled: null,
    ...partial,
  };
}

test('Review renders all five agents with enabled/disabled/not-selected semantics', () => {
  const model = buildAuthorityReview({
    draft: draft({
      total: '800',
      agents: {
        stock: agent(true, '800', '800'),
        perps: agent(false),
        nft: agent(null),
      },
      provenance: { 'agents.stock.enabled': 'EXPLICIT_PROMPT', 'portfolio.totalCapital': 'EXPLICIT_PROMPT' },
    }),
    allocation: allocation({ intent: 'FIXED', enabled: ['stock'], fixed: ['stock'], deployable: '800' }),
    validationOk: true,
    validationBlocking: [],
  });
  assert.equal(model.agents.length, 5);
  const stock = model.agents.find((a) => a.role === 'stock');
  const perps = model.agents.find((a) => a.role === 'perps');
  const nft = model.agents.find((a) => a.role === 'nft');
  assert.equal(stock?.state, 'ENABLED');
  assert.equal(stock?.stateLabel, 'Enabled');
  assert.match(stock?.authorityLabel ?? '', /Fixed allocation/);
  assert.equal(perps?.state, 'DISABLED');
  assert.equal(perps?.stateLabel, 'Disabled');
  assert.equal(nft?.state, 'NOT_SELECTED');
  assert.equal(nft?.stateLabel, 'Not selected');
  assert.equal(model.total, '800');
  assert.equal(model.currency, 'USDC');
  assert.equal(model.canAuthorize, true);
});

test('FIXED / DYNAMIC / HYBRID / NEEDS_AGENT_SELECTION allocation copy', () => {
  const fixed = buildAuthorityReview({
    draft: draft({ total: '1200', agents: { stock: agent(true, '800'), yield: agent(true, '400') } }),
    allocation: allocation({ intent: 'FIXED', fixed: ['stock', 'yield'], enabled: ['stock', 'yield'], deployable: '1200' }),
    validationOk: true,
    validationBlocking: [],
  });
  assert.equal(fixed.allocation.headline, 'Fixed');
  assert.match(fixed.allocation.planningNote ?? '', /No Planning Room/);

  const dynamic = buildAuthorityReview({
    draft: draft({ total: '2000', agents: { stock: agent(true), yield: agent(true) } }),
    allocation: allocation({
      intent: 'DYNAMIC',
      planning: 'REQUIRED',
      pool: ['stock', 'yield'],
      enabled: ['stock', 'yield'],
      deployable: '2000',
      pooled: '2000',
    }),
    validationOk: true,
    validationBlocking: [],
  });
  assert.equal(dynamic.allocation.headline, 'Agents decide the split');
  assert.equal(dynamic.canAuthorize, false);
  assert.ok(dynamic.blockers.some((b) => /Planning Room|agent plan/i.test(b.text)));

  const hybrid = buildAuthorityReview({
    draft: draft({
      total: '2000',
      agents: { stock: agent(true, '800'), yield: agent(true, '400'), swap: agent(true) },
    }),
    allocation: allocation({
      intent: 'HYBRID',
      planning: 'REQUIRED',
      fixed: ['stock', 'yield'],
      pool: ['swap'],
      enabled: ['stock', 'yield', 'swap'],
      deployable: '2000',
      pooled: '800',
    }),
    validationOk: true,
    validationBlocking: [],
  });
  assert.equal(hybrid.allocation.headline, 'Fixed + flexible');
  assert.ok(hybrid.allocation.lines.some((l) => l.label === 'Flexible pool' && l.value.includes('800')));

  const needs = buildAuthorityReview({
    draft: draft({ total: '2000', agents: { stock: agent(null), yield: agent(null) }, issues: [{ kind: 'NEEDS_CLARIFICATION', field: null, text: 'Choose agents.' }] }),
    allocation: allocation({ intent: 'NEEDS_AGENT_SELECTION', undecided: ['stock', 'swap', 'yield', 'nft', 'perps'], deployable: '2000' }),
    validationOk: false,
    validationBlocking: [],
  });
  assert.equal(needs.allocation.headline, 'Choose agents');
  assert.equal(needs.canAuthorize, false);
});

test('risk preference is advisory and distinct from leverage', () => {
  const model = buildAuthorityReview({
    draft: draft({
      total: '2000',
      maxLeverage: null,
      agents: { perps: agent(true, null, '400') },
      notes: ['Risk preference (advisory only): AGGRESSIVE'],
    }),
    allocation: allocation({ intent: 'FIXED', enabled: ['perps'], fixed: [], deployable: '2000' }),
    validationOk: true,
    validationBlocking: [],
  });
  assert.equal(model.riskPreference?.label, 'Aggressive');
  assert.equal(model.riskPreference?.advisory, true);
  const leverage = model.advanced.find((r) => r.label === 'Leverage');
  assert.equal(leverage?.value, 'Not granted');
});

test('conflicts and ambiguities block authorize; capital choices parse', () => {
  const model = buildAuthorityReview({
    draft: draft({
      total: '2000',
      agents: { stock: agent(true, '800') },
      issues: [
        { kind: 'CONFLICT', field: 'portfolio.totalCapital', text: 'Portfolio capital conflict: prompt $800 vs capital field $2,000. Which total?' },
        { kind: 'AMBIGUOUS', field: null, text: 'Half of what total portfolio amount?' },
      ],
    }),
    allocation: allocation({ intent: 'FIXED', enabled: ['stock'], fixed: ['stock'] }),
    validationOk: false,
    validationBlocking: [],
  });
  assert.equal(model.canAuthorize, false);
  assert.equal(model.conflicts[0]?.capitalChoices?.join(','), '800,2000');
  assert.equal(model.ambiguities.length, 1);
  assert.match(model.blockerSummary, /Resolve 2 items/);
});

test('dangerous unsupported blocks; soft unsupported needs acknowledgment', () => {
  const dangerous = buildAuthorityReview({
    draft: draft({
      total: '800',
      agents: { stock: agent(true, '800') },
      issues: [{ kind: 'UNSUPPORTED', field: 'execution.recipients', text: 'Send profits to 0x1234567890123456789012345678901234567890' }],
    }),
    allocation: allocation({ intent: 'FIXED', enabled: ['stock'], fixed: ['stock'] }),
    validationOk: false,
    validationBlocking: [],
  });
  assert.equal(dangerous.canAuthorize, false);
  assert.equal(dangerous.unsupported[0]?.dangerous, true);

  const soft = buildAuthorityReview({
    draft: draft({
      total: '5000',
      agents: { stock: agent(true, '2000'), yield: agent(true, '1000'), swap: agent(true) },
      issues: [{ kind: 'UNSUPPORTED', field: null, text: 'Per-trade limit ≤ $500 is not a signed mandate field.' }],
      venues: ['robinhood-stock'],
    }),
    allocation: allocation({
      intent: 'HYBRID',
      fixed: ['stock', 'yield'],
      pool: ['swap'],
      enabled: ['stock', 'yield', 'swap'],
      pooled: '2000',
      deployable: '5000',
    }),
    validationOk: false,
    validationBlocking: [],
  });
  assert.equal(soft.unsupported[0]?.softUnsupported, true);
  assert.equal(soft.canAuthorize, false);
  assert.ok(soft.advanced.some((r) => r.label === 'Venues'));
});

test('provenance labels and changed-from-prompt diff', () => {
  const model = buildAuthorityReview({
    draft: draft({
      total: '1500',
      agents: { stock: agent(true, null, '1500') },
      provenance: {
        'portfolio.totalCapital': 'USER',
        'agents.stock.maxAllocation': 'USER',
      },
      evidence: {
        'portfolio.totalCapital': { sourceText: '2000' },
        'agents.stock.maxAllocation': { sourceText: '2000' },
      },
    }),
    allocation: allocation({ intent: 'FIXED', enabled: ['stock'], deployable: '1500' }),
    validationOk: true,
    validationBlocking: [],
  });
  assert.equal(model.totalProvenance, 'Entered manually');
  assert.ok(model.changes.some((c) => c.field === 'portfolio.totalCapital' && c.from === '2000' && c.to === '1500'));
});

test('Approve stage wires review gating, conflict resolution, and Authorize mandate CTA', () => {
  assert.match(configure, /Mandate review/);
  assert.match(configure, /Authorize mandate/);
  assert.match(configure, /reviewClean/);
  assert.match(configure, /onChooseTotal/);
  assert.match(configure, /onAcknowledgeUnsupported/);
  assert.match(configure, /Requested but not enforceable/);
  assert.match(configure, /Needs input/);
  assert.match(configure, /Edit permissions/);
  assert.match(configure, /Trusted execution details/);
  assert.match(lab, /buildAuthorityReview/);
  assert.match(lab, /acknowledgeUnsupported: true/);
  assert.match(lab, /chooseTotal/);
  assert.match(lab, /if \(!authorityReview\.canAuthorize\)/);
  assert.match(planning, /Agent plan/);
  assert.doesNotMatch(planning, /singleAgent \? "Mandate Room"/);
  assert.match(css, /\.mw-review-blockers/);
  assert.match(css, /\.mw-review-unsupported/);
  assert.match(reviewSrc, /NOT_SELECTED/);
  assert.match(reviewSrc, /Not granted/);
});
