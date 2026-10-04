/**
 * C2.2.1 — Judge Acceptance Hotfix regressions
 * (docs/demo/c2-2-1-validation.md).
 *
 * Presentation and provider-bound UI only. Does not mutate signed authority
 * ceilings, invent settlement evidence, or broadcast.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildAuthorityReview, planAuthorityLabel } from '../components/demo/live/authority-review.ts';
import type { AllocationState } from '../components/demo/live/allocation-model.ts';
import { budgetRows } from '../components/demo/live/allocation-model.ts';
import type { JsonRecord, LiveEvent } from '../components/demo/live/live-client.ts';
import { classifyAgentSettlement, deriveReview } from '../components/demo/live/live-model.ts';
import { executeOffered, parseRestored } from '../components/demo/live/settlement-restore.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const configure = read('../components/demo/live/stage-configure.tsx');
const planning = read('../components/demo/live/stage-planning.tsx');
const outcome = read('../components/demo/live/stage-outcome.tsx');
const sheets = read('../components/demo/live/sheets.tsx');
const lab = read('../components/demo/live/live-lab.tsx');
const reviewSrc = read('../components/demo/live/authority-review.ts');
const modelSrc = read('../components/demo/live/live-model.ts');

const agent = (enabled: boolean | null, budget: string | null = null, maxAllocation: string | null = null) => ({
  enabled,
  budget,
  maxAllocation,
  maxExposure: null,
});

function draft(partial: {
  total?: string | null;
  autoReallocate?: boolean;
  agents?: Partial<Record<'stock' | 'swap' | 'yield' | 'nft' | 'perps', ReturnType<typeof agent>>>;
  provenance?: Record<string, string>;
}): JsonRecord {
  return {
    portfolio: {
      totalCapital: partial.total ?? '2000',
      minUnallocated: null,
      maxDeployed: partial.total ?? '2000',
      deployAll: null,
      maxDerivative: null,
      maxIlliquid: null,
      validityMinutes: '60',
      autoReallocate: partial.autoReallocate ?? false,
    },
    agents: {
      stock: agent(false),
      swap: agent(false),
      yield: agent(false),
      nft: agent(false),
      perps: agent(false),
      ...partial.agents,
    },
    market: {
      assets: null,
      issuers: null,
      representations: null,
      venues: null,
      chains: null,
      maxLeverage: null,
      maxSlippageBps: null,
      maxQuoteAgeSeconds: null,
    },
    execution: { recipients: null },
    issues: [],
    notes: [],
    provenance: partial.provenance ?? {},
    evidence: {},
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
    deployable: '2000',
    pooled: '2000',
    ...partial,
  };
}

function event(sequence: number, kind: string, data: JsonRecord = {}, agentRole: string | null = null): LiveEvent {
  return {
    schema: 'MANDATE_LIVE_AI.V1',
    sessionId: 'lab-c221',
    sequence,
    kind,
    at: '2026-10-03T00:00:00.000Z',
    elapsedMs: sequence,
    protocolTime: '0',
    mandateVersion: 1,
    agent: agentRole,
    roomId: null,
    generation: null,
    data,
  };
}

test('accepted dynamic plan can differ from signed maximum authority', () => {
  const d = draft({
    total: '2000',
    agents: {
      stock: agent(true, '600', '800'),
      yield: agent(true, '800', '800'),
    },
    provenance: {
      'agents.stock.budget': 'PLANNED',
      'agents.yield.budget': 'PLANNED',
      'agents.stock.maxAllocation': 'USER',
      'agents.yield.maxAllocation': 'USER',
    },
  });
  const model = buildAuthorityReview({
    draft: d,
    allocation: allocation({
      intent: 'DYNAMIC',
      planning: 'COMPLETE',
      pool: ['stock', 'yield'],
      enabled: ['stock', 'yield'],
      deployable: '2000',
      pooled: '2000',
    }),
    validationOk: true,
    validationBlocking: [],
  });

  assert.equal(model.allocation.headline, 'Current plan');
  assert.deepEqual(
    model.allocation.lines.map((l) => `${l.label}:${l.value}`),
    ['Stock:$600', 'Yield:$800', 'Available:$600'],
  );
  assert.deepEqual(
    model.allocation.maxLines.map((l) => `${l.label}:${l.value}`),
    ['Stock:up to $800', 'Yield:up to $800'],
  );
  const stock = model.agents.find((a) => a.role === 'stock');
  const yieldAgent = model.agents.find((a) => a.role === 'yield');
  assert.equal(stock?.currentPlan, '600');
  assert.equal(stock?.maxAuthority, '800');
  assert.match(stock?.authorityLabel ?? '', /\$600 planned · up to \$800/);
  assert.match(yieldAgent?.authorityLabel ?? '', /\$800 planned · up to \$800/);
  assert.notEqual(stock?.currentPlan, stock?.maxAuthority);
});

test('accepting a Room allocation does not mutate signed authority ceilings in presentation helpers', () => {
  const before = draft({
    total: '2000',
    agents: { stock: agent(true, null, '800'), yield: agent(true, null, '800') },
  });
  const afterAccept = draft({
    total: '2000',
    agents: { stock: agent(true, '600', '800'), yield: agent(true, '800', '800') },
    provenance: { 'agents.stock.budget': 'PLANNED', 'agents.yield.budget': 'PLANNED' },
  });
  const beforeMax = (before.agents as JsonRecord).stock as JsonRecord;
  const afterStock = (afterAccept.agents as JsonRecord).stock as JsonRecord;
  assert.equal(beforeMax.maxAllocation, '800');
  assert.equal(afterStock.maxAllocation, '800');
  assert.equal(afterStock.budget, '600');
  assert.deepEqual(
    budgetRows(afterAccept, ['stock', 'yield']).map((r) => `${r.role}:${r.amount}`),
    ['stock:600', 'yield:800'],
  );
  assert.equal(planAuthorityLabel('600', '800', 'dynamic'), '$600 planned · up to $800');
  // Trail prefers budget as "planned", never labels the ceiling "allocated".
  assert.match(configure, /kind === "planned" \? "planned" : "max"/);
  assert.doesNotMatch(configure, /maxAllocation`\) \|\| access\.text\(`agents\.\$\{role\}\.budget/);
});

test('multi-agent receipt: Stock LIVE_TESTNET, Yield OFFCHAIN_ONLY, no fake Yield tx', () => {
  const events: LiveEvent[] = [
    event(1, 'AGENT_REQUEST_STARTED', {}, 'stock'),
    event(2, 'AGENT_REQUEST_STARTED', {}, 'yield'),
    event(3, 'PORTFOLIO_AUTHORIZED', {
      reserved: { amount: '1400' },
      proposals: [
        { role: 'stock', outcome: 'RESERVED', requested: '600' },
        { role: 'yield', outcome: 'RESERVED', requested: '800' },
      ],
    }),
    event(4, 'TESTNET_TX_CONFIRMED', {
      evidence: 'LIVE_TESTNET',
      txHash: '0xstockonlyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      block: 42,
      status: 'SUCCESS',
      tokenIn: { symbol: 'MDUSD', amount: '48' },
      tokenOut: { symbol: 'MDEMO', amount: '4.8' },
    }, 'stock'),
  ];
  const review = deriveReview(events);
  const stock = review.authorized.find((a) => a.role === 'stock');
  const yieldItem = review.authorized.find((a) => a.role === 'yield');
  assert.ok(stock, 'stock authorized');
  assert.ok(yieldItem, 'yield authorized');
  assert.equal(stock.outcome, 'SETTLED');
  assert.equal(stock.settlementEvidence, 'LIVE_TESTNET');
  assert.equal(yieldItem.outcome, 'AUTHORIZED');
  assert.equal(yieldItem.settlementEvidence, 'OFFCHAIN_ONLY');
  assert.match(yieldItem.settlementNote ?? '', /no live settlement connector/);
  assert.equal(review.settlementsConfirmed, 1);
  assert.equal(classifyAgentSettlement('yield', { settled: true, evidence: 'LIVE_TESTNET' }).settlementEvidence, 'OFFCHAIN_ONLY');
  assert.doesNotMatch(outcome, /\?\? "LIVE_TESTNET"/);
  assert.match(outcome, /Settlement evidence/);
  assert.match(outcome, /\{item\.settlementEvidence\}/);
  assert.match(outcome, /Authorized capital/);
  assert.match(outcome, /Fixture debit/);
  assert.match(outcome, /Only Stock has a live testnet settlement connector/);
  assert.match(outcome, /Authorization evidence is not settlement evidence/);
  assert.match(modelSrc, /no live settlement connector in this build/);
  assert.match(modelSrc, /Fixture settlement · not authorized capital/);
  assert.match(sheets, /Stock settlement evidence/);
  assert.doesNotMatch(sheets, /settlement\.settled \? "LIVE_TESTNET"/);
  assert.doesNotMatch(outcome, /0xyield/);
});

test('security demo is exposed from the receipt as Test the firewall', () => {
  assert.match(sheets, /Try an unauthorized action/);
  assert.match(lab, /Security test/);
  assert.match(lab, /VALID AGENT ≠ VALID ACTION/);
  assert.match(outcome, /Test the firewall/);
  assert.match(lab, /setSheet\("stress"\)/);
  assert.match(lab, /POST", "\/policy-stress"/);
  assert.match(sheets, /Nothing was sent; the reservation ledger is unchanged/);
  assert.match(sheets, /REFUSED/);
  assert.match(sheets, /not LIVE_TESTNET/);
});

test('restored settled session never offers Execute', () => {
  const restored = parseRestored({
    settlementStatus: 'SETTLED',
    reservation: '0x01',
    reservationState: 'CONSUMED',
    attemptState: 'SETTLED',
    quarantine: null,
    held: false,
    heldUntil: null,
    txHash: `0x${'ab'.repeat(32)}`,
    transactions: 1,
    receiptStatus: 'SUCCESS',
    pending: null,
    executable: false,
    asOfEvents: 100,
  });
  assert.ok(restored);
  assert.equal(restored.executable, false);
  assert.equal(executeOffered(restored, []), false);
  assert.match(outcome, /canExecute/);
  assert.match(read('../components/demo/live/settlement-restore.ts'), /executeOffered/);
});

test('plan vs authority copy is wired in Configure / Planning / Review', () => {
  assert.match(planning, /Current plan/);
  assert.match(planning, /up to \$\{usd\(max\)\}/);
  assert.match(configure, /Maximum authority/);
  assert.match(configure, /\{usd\(plan\)\} planned/);
  assert.match(reviewSrc, /Current allocations may be lower than each agent's signed maximum/);
  assert.match(reviewSrc, /Agents may reallocate unused capital only within their signed maximums/);
  assert.match(modelSrc, /OFFCHAIN_ONLY/);
  assert.match(modelSrc, /agentSettlementCapability/);
});
