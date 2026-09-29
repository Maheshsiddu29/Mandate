/**
 * The demonstration, step by step (docs/phase-7f/demo.md): five agents ask
 * for 2,550 against a 2,000 authority; four of them first want something
 * they may not have; they negotiate to a portfolio that fits — and the same
 * run always produces the same receipt.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { amountOf } from '../src/index.ts';
import { USDC, demoParty, runDemo, type DemoRun } from '../src/demo/index.ts';

const run: Promise<DemoRun> = runDemo();
const who = (r: DemoRun, role: string) => r.room.decisions.filter((d) => d.agent === demoParty(role).value);
const codes = (reasons: readonly { code: string }[]) => [...new Set(reasons.map((x) => x.code))].sort();

describe('the five-agent demonstration', () => {
  it('the agents first ask for 2,550 against a 2,000 authority', async () => {
    const r = await run;
    // Every agent proposes in round 1, and the room screens round 1 before anything else.
    assert.equal(r.room.decisions.filter((d) => d.round === 1).length, 5);
    const first = r.room.proposals.slice(0, 5);
    const total = first.reduce((s, p) => s + amountOf(p.proposal.requested, 'portfolio-notional'), 0n);
    assert.equal(total, USDC(2_550n));
  });

  it('1 — stock: the cheaper same-ticker look-alike is excluded by the registry; the approved note is authorized', async () => {
    const r = await run;
    const [first, second] = who(r, 'stock');
    assert.equal(first?.outcome, 'REJECTED');
    assert.deepEqual(codes(first?.reasons ?? []), ['REGISTRY:ISSUER_NOT_ALLOWED', 'REGISTRY:SYNTHETIC_NOT_ALLOWED']);
    assert.equal(first?.registry?.status, 'EXCLUDED');
    assert.equal(second?.outcome, 'ACCEPTED');
    assert.equal(amountOf(second?.demand ?? [], 'portfolio-notional'), USDC(600n));
  });

  it('2 — swap: the unknown router with the better quote is VENUE_NOT_ALLOWED; the approved route is authorized', async () => {
    const r = await run;
    assert.deepEqual(who(r, 'swap').map((d) => [d.round, d.outcome, codes(d.reasons).join(',')]), [
      [1, 'REJECTED', 'VENUE_NOT_ALLOWED'],
      [2, 'ACCEPTED', ''],
    ]);
  });

  it('3 — NFT: the same-name impostor is refused for its contract identity; with nothing authorized, it releases its allocation', async () => {
    const r = await run;
    assert.deepEqual(codes(who(r, 'nft')[0]?.reasons ?? []), ['ASSET_NOT_ALLOWED', 'REPRESENTATION_NOT_ALLOWED']);
    assert.deepEqual(r.room.releases.map((x) => [x.round, x.agent === demoParty('nft').value, x.applied]), [[2, true, true]]);
    assert.equal(r.receipt.agents.find((a) => a.label === 'nft')?.status, 'RELEASING');
  });

  it('4, 5 — yield: the unvetted 12.60 % vault is refused; the approved 5.20 % product adjusts from 700 to 600 and is authorized', async () => {
    const r = await run;
    assert.deepEqual(who(r, 'yield').map((d) => [d.round, d.outcome]), [
      [1, 'REJECTED'],
      [2, 'REDUCE_REQUESTED'],
      [3, 'ACCEPTED'],
    ]);
    assert.deepEqual(codes(who(r, 'yield')[0]?.reasons ?? []), ['ASSET_NOT_ALLOWED', 'ISSUER_NOT_ALLOWED', 'REPRESENTATION_NOT_ALLOWED', 'VENUE_NOT_ALLOWED']);
    assert.equal(amountOf(who(r, 'yield')[1]?.target ?? [], 'portfolio-notional'), USDC(600n));
  });

  it('6, 7 — perps: 600 exceeds the portfolio’s 400 derivative exposure; it reduces to 400 and is authorized', async () => {
    const r = await run;
    const [first, second] = who(r, 'perps');
    assert.equal(first?.outcome, 'REDUCE_REQUESTED');
    assert.deepEqual(first?.reasons, [{ code: 'PORTFOLIO_LIMIT_EXCEEDED', subject: 'derivative-notional' }]);
    assert.equal(second?.outcome, 'ACCEPTED');
    assert.equal(amountOf(second?.demand ?? [], 'derivative-notional'), USDC(400n));
  });

  it('8 — the final portfolio fits: 1,900 of 2,000 reserved in the ledger, the NFT allocation released and reassigned exactly once', async () => {
    const r = await run;
    assert.equal(r.verification.status, 'VERIFIED');
    assert.equal(r.room.rounds, 3);
    assert.equal(amountOf(r.after.reserved, 'portfolio-notional'), USDC(1_900n));
    assert.equal(amountOf(r.after.reserved, 'derivative-notional'), USDC(400n));
    const nftLot = r.room.book.lots.find((l) => l.from?.value === demoParty('nft').value && l.resource === 'portfolio-notional');
    assert.equal(nftLot?.amount, USDC(250n));
    assert.equal(nftLot?.remaining, 0n, 'stock took 100, swap 50, yield 100');
    assert.deepEqual(r.reservations.map((x) => x.status), ['RESERVED', 'RESERVED', 'RESERVED', 'RESERVED']);
  });

  it('every refusal was offchain: 0 transactions, 0 gas; fixture children settle SIMULATED, stock and perps await their own signers', async () => {
    const r = await run;
    assert.equal(r.receipt.transactions, 0);
    assert.equal(r.receipt.decisions.filter((d) => d.refusal === 'OFFCHAIN_REFUSAL').length, 6);
    const byStatus = r.executions.map((e) => `${e.integration}:${e.status}:${e.evidence}:${e.integrationEvidence}`).sort();
    assert.deepEqual(byStatus, [
      'lighter-perp-policy.v1:AWAITING_DOMAIN_SIGNER:OFFCHAIN_ONLY:OFFCHAIN_ONLY',
      'robinhood-gate-signer.v1:AWAITING_DOMAIN_SIGNER:OFFCHAIN_ONLY:LIVE_TESTNET',
      'swap-fixture.v1:SETTLED:SIMULATED:FIXTURE',
      'yield-fixture.v1:SETTLED:SIMULATED:FIXTURE',
    ]);
  });

  it('is deterministic: a second, independent run produces the same receipt digest', async () => {
    const a = await run;
    const b = await runDemo();
    assert.equal(b.digest, a.digest);
  });
});
