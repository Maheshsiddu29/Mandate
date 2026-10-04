/**
 * Judge-facing V3 copy lock: authority vs fixture debit, ERC-20 allowance vs
 * Mandate authorization, LIVE_TESTNET vs OFFCHAIN_ONLY. Copy only — no protocol.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { LiveEvent } from '../components/demo/live/live-client.ts';
import { classifyAgentSettlement, deriveReview } from '../components/demo/live/live-model.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const configure = readFileSync(`${root}/components/demo/live/stage-configure.tsx`, 'utf8');
const outcome = readFileSync(`${root}/components/demo/live/stage-outcome.tsx`, 'utf8');
const modelSrc = readFileSync(`${root}/components/demo/live/live-model.ts`, 'utf8');

function event(
  sequence: number,
  kind: string,
  data: Record<string, unknown>,
  agent: string | null = null,
): LiveEvent {
  return {
    schema: 'MANDATE_LIVE_AI.V1',
    sessionId: 'judge-copy',
    sequence,
    kind,
    at: '2026-10-04T00:00:00.000Z',
    elapsedMs: 1,
    protocolTime: '1',
    mandateVersion: 1,
    agent,
    roomId: null,
    generation: null,
    data,
  };
}

describe('judge-facing V3 evidence and allowance copy', () => {
  it('settlement setup never says one-time; allowance is separate from Mandate auth', () => {
    assert.doesNotMatch(configure, /One-time setup required/);
    assert.match(configure, /Settlement allowance required/);
    assert.match(configure, /Allow the Mandate V3 Gate to use up to/);
    assert.match(configure, /This bounded ERC-20 allowance is separate from your Mandate authorization/);
    assert.match(configure, /Renew it only when the remaining settlement allowance is insufficient/);
    assert.doesNotMatch(configure, /not required for every trade/i);
    assert.doesNotMatch(configure, /permanent approval|one approval forever|approval forever/i);
    assert.match(configure, /Enable settlement/);
  });

  it('settled Stock labels $amount as authorized capital, not settled MDUSD', () => {
    assert.match(outcome, /Authorized capital \{usd\(item\.amount\)\}/);
    assert.match(outcome, /Authorized capital\{" "\}/);
    assert.match(outcome, /Fixture debit \{settlement\.fixtureIn\}/);
    assert.match(outcome, /Fixture output \{settlement\.fixtureOut\}/);
    assert.match(outcome, /Fixture debit \{fixtureDebit\}/);
    assert.doesNotMatch(outcome, /\$\{usd\([^)]*\)\} settled|settled \$\{usd/i);
    assert.doesNotMatch(outcome, /\$800 MDUSD|MDUSD transferred|NVDA purchased|Robinhood Stock Token settled/i);
  });

  it('multi-agent evidence classes stay distinct: Stock LIVE_TESTNET, others OFFCHAIN_ONLY', () => {
    const events: LiveEvent[] = [
      event(1, 'AGENT_REQUEST_STARTED', {}, 'stock'),
      event(2, 'AGENT_REQUEST_STARTED', {}, 'swap'),
      event(3, 'AGENT_REQUEST_STARTED', {}, 'yield'),
      event(4, 'PORTFOLIO_AUTHORIZED', {
        reserved: { amount: '2000' },
        proposals: [
          { role: 'stock', outcome: 'RESERVED', requested: '800' },
          { role: 'swap', outcome: 'RESERVED', requested: '600' },
          { role: 'yield', outcome: 'RESERVED', requested: '600' },
        ],
      }),
      event(5, 'TESTNET_TX_CONFIRMED', {
        evidence: 'LIVE_TESTNET',
        txHash: `0x${'ab'.repeat(32)}`,
        block: 42,
        status: 'SUCCESS',
        tokenIn: { symbol: 'MDUSD', amount: '64' },
        tokenOut: { symbol: 'MDEMO', amount: '6.4' },
      }, 'stock'),
    ];
    const review = deriveReview(events);
    const stock = review.authorized.find((a) => a.role === 'stock');
    const swap = review.authorized.find((a) => a.role === 'swap');
    const yieldItem = review.authorized.find((a) => a.role === 'yield');
    assert.ok(stock && swap && yieldItem);
    assert.equal(stock.outcome, 'SETTLED');
    assert.equal(stock.settlementEvidence, 'LIVE_TESTNET');
    assert.equal(stock.amount, '800');
    assert.match(stock.settlementNote ?? '', /Fixture settlement · not authorized capital/);
    assert.equal(swap.outcome, 'AUTHORIZED');
    assert.equal(swap.settlementEvidence, 'OFFCHAIN_ONLY');
    assert.equal(yieldItem.outcome, 'AUTHORIZED');
    assert.equal(yieldItem.settlementEvidence, 'OFFCHAIN_ONLY');
    assert.equal(classifyAgentSettlement('swap', { settled: true, evidence: 'LIVE_TESTNET' }).outcome, 'AUTHORIZED');
    assert.equal(classifyAgentSettlement('yield', { settled: true, evidence: 'LIVE_TESTNET' }).settlementEvidence, 'OFFCHAIN_ONLY');
    assert.match(outcome, /Authorization evidence is not settlement evidence/);
    assert.match(outcome, /Only Stock has a live testnet settlement connector in this build/);
  });

  it('V3 receipt keeps per-trade wallet approval none and reusable mandate signature', () => {
    assert.match(outcome, /Bounded V3 delegation/);
    assert.match(outcome, /Per-trade wallet approval: None/);
    assert.match(outcome, /Principal authorization: One reusable bounded mandate signature/);
    assert.match(outcome, /Evidence: LIVE_TESTNET · Stock fixture only/);
    assert.match(outcome, /Valueless demo assets\. Not an NVDA trade\. Not a Robinhood Stock Token\./);
    assert.match(outcome, /FIXTURE_QUALIFICATION/);
  });

  it('refused / blocked copy and V2 execute path remain', () => {
    assert.match(outcome, /Mandate stopped this before execution/);
    assert.match(outcome, /Wallet request: None/);
    assert.match(outcome, /Execute on Robinhood Testnet/);
    assert.match(outcome, /Sign execution authorization/);
    assert.match(modelSrc, /OFFCHAIN_ONLY/);
    assert.match(modelSrc, /LIVE_TESTNET/);
  });
});
