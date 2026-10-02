/**
 * The settlement path end to end, offline: a scripted Live AI session, the
 * real Mandate path, the existing GateSigner and custody, and the Phase 6
 * reference model as the chain. Every failure mode leaves zero broadcasts,
 * and where it is decided before custody, zero signatures.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PAUSE_CONFIRMATION, type LiveEvent } from '@mandate/live-agents';
import { containsKey, everyCandidate } from '../../live-agents/test/support/world.ts';
import { ASSET_QUALIFICATION } from '../src/evidence.ts';
import { SEND_AUTHORIZATION_PHRASE, SendGate } from '../src/send-gate.ts';
import type { Prepared, SettlementOutcome } from '../src/settlement.ts';
import { ALL_TEST_KEYS, GATE, MDEMO, MDUSD, PRINCIPAL, abstain, propose, settlementWorld, type SettlementWorld } from './support/world.ts';

const open = () => {
  const g = new SendGate();
  assert.equal(g.authorize(SEND_AUTHORIZATION_PHRASE), true);
  return g;
};

async function prepared(w: SettlementWorld): Promise<Prepared> {
  const p = await w.settlement.prepare();
  if ('ineligible' in p) assert.fail(`not prepared: ${p.stage} ${p.ineligible}`);
  return p;
}

async function withWorld(f: (w: SettlementWorld) => Promise<void>, o: Parameters<typeof settlementWorld>[0] = {}): Promise<void> {
  const w = await settlementWorld(o);
  try {
    await f(w);
  } finally {
    w.close();
  }
}

const SETTLEMENT_KINDS = /^(TESTNET_|DOMAIN_EXECUTION_)/;
const settlementEvents = (w: SettlementWorld): readonly LiveEvent[] => w.session.events.events.filter((e) => SETTLEMENT_KINDS.test(e.kind));

function noBroadcast(w: SettlementWorld, o: SettlementOutcome): void {
  assert.equal(o.broadcasts, 0);
  assert.equal(w.rpc.broadcasts, 0);
  assert.equal(w.rpc.prepared, 0);
  assert.ok(!w.kinds().includes('TESTNET_TX_SUBMISSION_STARTED'));
}

describe('dry run', () => {
  it('reaches eth_call and estimateGas for exactly the reserved Stock child, and never broadcasts', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      const r = await w.settlement.run(p, { mode: 'DRY_RUN', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'READY');
      noBroadcast(w, r);
      if (r.status !== 'READY') return;
      assert.equal(w.rpc.simulations, 1);
      assert.equal(w.rpc.estimates, 1);
      assert.equal(r.wouldSend.to, GATE);
      assert.equal(r.wouldSend.recipient, PRINCIPAL);
      assert.equal(r.wouldSend.tokenIn.address, MDUSD);
      assert.equal(r.wouldSend.tokenOut.address, MDEMO);
      // 400 USDC of the 125-USDC note is 3.2 notes; the fixture buys 3.2 MDEMO at the venue's 10 MDUSD.
      assert.equal(r.wouldSend.tokenOut.atoms, p.execution.candidate.quantity.toString());
      assert.equal(r.wouldSend.tokenOut.amount, '3.2');
      assert.equal(r.wouldSend.tokenIn.amount, '32');
      assert.equal(w.rpc.chain.txs.length, 0);
      // Even an open gate does not make a dry run send; the gate is untouched.
      assert.deepEqual(w.of('TESTNET_TX_SUBMITTED'), []);
    });
  });

  it('can be repeated: the Live AI reservation is untouched by a dry run', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      for (let i = 0; i < 2; i += 1) assert.equal((await w.settlement.run(p, { mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: w.ledgerPath() })).status, 'READY');
      assert.equal(w.rpc.broadcasts, 0);
    });
  });
});

describe('the explicit send gate', () => {
  it('without the exact phrase, a send builds nothing, signs nothing and sends nothing', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      const g = new SendGate();
      for (const phrase of ['authorize robinhood testnet send', 'AUTHORIZE ROBINHOOD TESTNET SEND ', 'AUTHORIZE MAINNET SEND', '']) assert.equal(g.authorize(phrase), false);
      const r = await w.settlement.run(p, { mode: 'SEND', gate: g, ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'INELIGIBLE');
      assert.equal(r.signatures, 0);
      noBroadcast(w, r);
      assert.equal(w.rpc.simulations, 0);
      assert.equal(w.of('TESTNET_SEND_AUTHORIZATION_REFUSED').length, 1);
    });
  });

  it('opens for one broadcast only: a second send in the session is refused', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      const g = open();
      const first = await w.settlement.run(p, { mode: 'SEND', gate: g, ledgerPath: w.ledgerPath() });
      assert.equal(first.status, 'CONFIRMED');
      assert.equal(g.state, 'CONSUMED');
      const second = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(second.status, 'INELIGIBLE');
      assert.equal(w.rpc.broadcasts, 1);
      assert.equal(w.rpc.chain.txs.length, 1);
    });
  });

  it('a stub or scripted decision is never sent over the live testnet transport', async () => {
    await withWorld(async (w) => {
      w.rpc.transport = 'ROBINHOOD_TESTNET_RPC';
      const p = await prepared(w);
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'INELIGIBLE');
      if (r.status === 'INELIGIBLE') assert.equal(r.reason, 'LIVE_MODEL_REQUIRED_FOR_TESTNET_SEND');
      noBroadcast(w, r);
    });
  });
});

describe('nothing reaches a key or the chain unless the Live AI authorization is eligible', () => {
  it('no reservation (the Stock agent abstained): nothing to settle', async () => {
    await withWorld(async (w) => {
      const p = await w.settlement.prepare();
      assert.ok('ineligible' in p && p.ineligible === 'NO_STOCK_RESERVATION');
      assert.equal(w.rpc.simulations + w.rpc.prepared + w.rpc.broadcasts, 0);
      assert.equal(w.of('DOMAIN_EXECUTION_INELIGIBLE').length, 1);
    }, { stock: abstain });
  });

  it('a Stock proposal Mandate blocked (the look-alike token, eligibility bypassed) is never reserved, so never settled', async () => {
    await withWorld(async (w) => {
      assert.ok(w.kinds().includes('PROPOSAL_BLOCKED'));
      assert.equal(w.session.reservedExecutions.length, 0);
      const p = await w.settlement.prepare();
      assert.ok('ineligible' in p && p.ineligible === 'NO_STOCK_RESERVATION');
      assert.equal(w.rpc.simulations + w.rpc.prepared + w.rpc.broadcasts, 0);
    }, { stock: propose('nvda-token-b', 400), eligibility: everyCandidate });
  });

  it('the look-alike is not offered in a normal run: an answer naming it is an invalid response, and there is still nothing to settle', async () => {
    await withWorld(async (w) => {
      assert.deepEqual(w.of('AGENT_CANDIDATES_EVALUATED').find((e) => e.agent === 'stock')?.data['actionable'], ['nvda-note-a']);
      assert.ok(w.kinds().includes('AGENT_INVALID_RESPONSE'));
      assert.ok(!w.kinds().includes('PROPOSAL_SIGNED'));
      const p = await w.settlement.prepare();
      assert.ok('ineligible' in p && p.ineligible === 'NO_STOCK_RESERVATION');
      assert.equal(w.rpc.simulations + w.rpc.prepared + w.rpc.broadcasts, 0);
    }, { stock: propose('nvda-token-b', 400) });
  });

  it('a stale proposal: past its lifetime, nothing is signed', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      w.time.now = p.execution.proposalExpiresAt;
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'INELIGIBLE');
      if (r.status === 'INELIGIBLE') assert.match(r.reason, /^9\.PROPOSAL_EXPIRED$/);
      assert.equal(r.signatures, 0);
      noBroadcast(w, r);
    });
  });

  it('a paused mandate (its root revoked in the ledger): nothing is signed', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      assert.equal(await w.session.pause(PAUSE_CONFIRMATION), true);
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'INELIGIBLE');
      if (r.status === 'INELIGIBLE') assert.equal(r.reason, '7.MANDATE_PAUSED_OR_INACTIVE');
      noBroadcast(w, r);
    });
  });

  it('a pause between the domain authorization and the signature is caught at custody: no principal signature', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      let paused = false;
      // Pause while the signer reads its evidence: after ADMIT_ATTEMPT is built, before custody signs.
      const original = w.rpc.gateMarkets.bind(w.rpc);
      let calls = 0;
      w.rpc.gateMarkets = async (policy) => {
        calls += 1;
        if (calls === 2 && !paused) paused = await w.session.pause(PAUSE_CONFIRMATION);
        return original(policy);
      };
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(paused, true);
      assert.equal(r.status, 'REFUSED');
      if (r.status === 'REFUSED') {
        assert.equal(r.stage, 'SIGN');
        assert.match(r.reason, /LIVE_AI\.INELIGIBLE\.7\.MANDATE_PAUSED_OR_INACTIVE/);
      }
      assert.equal(r.signatures, 0);
      noBroadcast(w, r);
    });
  });

  it('a tampered proposal digest, candidate, recipient, amount or gate: refused before the domain leg', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      const x = p.execution;
      const s = p.settlement;
      const other = `0x${'ab'.repeat(32)}`;
      const cases: readonly [string, Prepared, RegExp][] = [
        ['proposal digest', { ...p, execution: { ...x, proposal: other as never } }, /^8\.PROPOSAL_DIGEST_MISMATCH$/],
        ['candidate', { ...p, execution: { ...x, candidate: { ...x.candidate, quantity: x.candidate.quantity + 1n } } }, /^8\.CANDIDATE_MISMATCH$/],
        ['reservation', { ...p, execution: { ...x, reservation: other as never } }, /^6\.RESERVATION_NOT_ACTIVE$/],
        ['recipient', { ...p, settlement: { ...s, recipient: `0x${'99'.repeat(20)}` } }, /^SETTLEMENT_NOT_DERIVED_FROM_EXECUTION$/],
        ['amount', { ...p, settlement: { ...s, quantity: s.quantity * 2n, debit: s.debit * 2n } }, /^SETTLEMENT_NOT_DERIVED_FROM_EXECUTION$/],
        ['gate', { ...p, settlement: { ...s, gate: `0x${'77'.repeat(20)}` } }, /^SETTLEMENT_NOT_DERIVED_FROM_EXECUTION$/],
      ];
      for (const [name, tampered, reason] of cases) {
        const r = await w.settlement.run(tampered, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
        assert.equal(r.status, 'INELIGIBLE', name);
        if (r.status === 'INELIGIBLE') assert.match(r.reason, reason, name);
        assert.equal(r.signatures, 0, name);
        noBroadcast(w, r);
      }
      assert.equal(w.rpc.simulations, 0);
    });
  });
});

describe('the chain', () => {
  it('a wrong chain id is refused at preflight, before any domain authorization or signer', async () => {
    for (const id of [1n, 42_161n, 4_663n, 421_614n]) {
      await withWorld(async (w) => {
        const p = await prepared(w);
        w.rpc.chainIdValue = id;
        const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
        assert.equal(r.status, 'PREFLIGHT_FAILED');
        if (r.status === 'PREFLIGHT_FAILED') assert.deepEqual(r.preflight.failures, [`WRONG_CHAIN.${id}`]);
        assert.equal(r.signatures, 0);
        noBroadcast(w, r);
        assert.equal(w.rpc.simulations, 0);
        assert.ok(!w.kinds().includes('DOMAIN_EXECUTION_READY'));
      });
    }
  });

  it('a chain id that changes after preflight is caught at simulation, before any broadcast', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      const original = w.rpc.chainId.bind(w.rpc);
      let n = 0;
      w.rpc.chainId = async () => ((n += 1) > 1 ? { ok: true, value: 1n } : original());
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'REFUSED');
      if (r.status === 'REFUSED') assert.match(r.reason, /WRONG_CHAIN\.1/);
      noBroadcast(w, r);
    });
  });

  it('a code hash other than the manifest’s, missing gas, allowance or balance: preflight names it and nothing is built', async () => {
    const cases: readonly [string, (w: SettlementWorld) => void, string][] = [
      ['gate code', (w) => w.rpc.codehashes.set(GATE, `0x${'ee'.repeat(32)}`), 'CODE_HASH_NOT_MANIFEST.MandateExecutionGate'],
      ['no venue', (w) => w.rpc.codehashes.delete(w.deployment.venue.address), 'NO_CODE.FixtureVenue'],
      ['gas', (w) => (w.rpc.submitterWei = 1n), 'SUBMITTER_GAS_INSUFFICIENT.have_1_need_100000000000000_wei'],
      ['allowance', (w) => w.rpc.chain.approve(MDUSD, PRINCIPAL, GATE, 1n), 'GATE_ALLOWANCE_INSUFFICIENT.have_1_need_32000000'],
    ];
    for (const [name, mutate, failure] of cases) {
      await withWorld(async (w) => {
        const p = await prepared(w);
        mutate(w);
        const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
        assert.equal(r.status, 'PREFLIGHT_FAILED', name);
        if (r.status === 'PREFLIGHT_FAILED') assert.ok(r.preflight.failures.includes(failure), `${name}: ${r.preflight.failures.join(',')}`);
        noBroadcast(w, r);
      });
    }
  });

  it('a failed simulation: zero broadcasts, the revert reported', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      w.rpc.simulateRevert = '0x2d1f6f1a';
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'REFUSED');
      if (r.status === 'REFUSED') assert.equal(r.stage, 'PREFLIGHT');
      noBroadcast(w, r);
      assert.equal(w.of('TESTNET_SIMULATION_FAILED').length, 1);
      assert.equal(w.rpc.estimates, 0);
    });
  });

  it('a failed gas estimate: zero broadcasts', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      w.rpc.estimateError = 'RPC_-32000:execution reverted';
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'REFUSED');
      noBroadcast(w, r);
    });
  });

  it('an RPC failure before anything was sent: a safe failure, no hash, no broadcast', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      w.rpc.prepareError = 'NONCE.NETWORK.TimeoutError';
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'FAILED');
      if (r.status === 'FAILED') {
        assert.equal(r.txHash, null);
        assert.notEqual(r.evidence, 'LIVE_TESTNET');
      }
      assert.equal(w.rpc.broadcasts, 0);
      assert.ok(!w.kinds().includes('TESTNET_TX_SUBMITTED'));
    });
  });

  it('an ambiguous broadcast that did land is found by its hash — and nothing is resent', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      w.rpc.broadcastBehaviour = 'ERROR_BUT_MINED';
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'CONFIRMED');
      assert.equal(w.rpc.prepared, 1);
      assert.equal(w.rpc.broadcasts, 1);
      assert.equal(w.rpc.chain.txs.length, 1);
    });
  });

  it('an ambiguous broadcast the chain does not know: SUBMITTED_UNCONFIRMED with its hash, never a second transaction', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      w.rpc.broadcastBehaviour = 'ERROR_NOT_SENT';
      const records: string[] = [];
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath(), record: (x) => records.push(x.state) });
      assert.equal(r.status, 'SUBMITTED_UNCONFIRMED');
      if (r.status === 'SUBMITTED_UNCONFIRMED') assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
      assert.equal(w.rpc.prepared, 1);
      assert.equal(w.rpc.broadcasts, 1);
      assert.deepEqual(records, ['SUBMISSION_STARTED', 'UNKNOWN', 'UNKNOWN']);
      assert.ok(!w.kinds().includes('DOMAIN_EXECUTION_SETTLED'));
      const again = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(again.status, 'INELIGIBLE');
      assert.equal(w.rpc.prepared, 1);
      assert.equal(w.rpc.broadcasts, 1);
    });
  });

  it('a transaction hash without a receipt is SUBMITTED, not SETTLED', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      w.rpc.withholdReceipts = true;
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'SUBMITTED_UNCONFIRMED');
      if (r.status === 'SUBMITTED_UNCONFIRMED') assert.equal(r.evidence, 'SUBMITTED_UNCONFIRMED');
      assert.ok(w.kinds().includes('TESTNET_TX_SUBMITTED'));
      assert.ok(!w.kinds().includes('TESTNET_TX_CONFIRMED'));
      assert.ok(!w.kinds().includes('DOMAIN_EXECUTION_SETTLED'));
    });
  });

  it('a reverted receipt is FAILED, never LIVE_TESTNET', async () => {
    await withWorld(async (w) => {
      w.rpc.transport = 'ROBINHOOD_TESTNET_RPC';
      const p = await prepared(w);
      // The allowance disappears between simulation and inclusion: the gate reverts on chain.
      w.rpc.beforeMine = () => w.rpc.chain.approve(MDUSD, PRINCIPAL, GATE, 0n);
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'FAILED');
      if (r.status === 'FAILED') {
        assert.equal(r.evidence, 'FAILED');
        assert.equal(r.receipt?.status, 'REVERTED');
      }
      assert.ok(w.kinds().includes('TESTNET_TX_FAILED'));
      assert.ok(!w.kinds().includes('DOMAIN_EXECUTION_SETTLED'));
    }, { kind: 'LIVE' });
  });
});

describe('confirmed settlement and its evidence', () => {
  it('a live-model decision, confirmed with status 1 over the testnet transport, verified postconditions → LIVE_TESTNET', async () => {
    await withWorld(async (w) => {
      w.rpc.transport = 'ROBINHOOD_TESTNET_RPC';
      const p = await prepared(w);
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'CONFIRMED');
      if (r.status !== 'CONFIRMED') return;
      assert.equal(r.evidence, 'LIVE_TESTNET');
      assert.equal(r.receipt.status, 'SUCCESS');
      assert.deepEqual(r.postconditions.failures, []);
      assert.equal(r.postconditions.principalMdusdDelta, (-p.settlement.debit).toString());
      assert.equal(r.postconditions.principalMdemoDelta, p.settlement.quantity.toString());
      assert.equal(r.postconditions.agentMdemoDelta, '0');
      assert.equal(r.explorerUrl, `https://explorer.testnet.chain.robinhood.com/tx/${r.txHash}`);
      const settled = w.of('DOMAIN_EXECUTION_SETTLED');
      assert.equal(settled.length, 1);
      assert.equal(settled[0]?.data['evidence'], 'LIVE_TESTNET');
      assert.deepEqual(w.rpc.executeTargets.every((t) => t === GATE), true);
      // Lifecycle in order: submission started, submitted, confirmed, settled.
      const order = w.kinds().filter((k) => /^TESTNET_TX_|^DOMAIN_EXECUTION_SETTLED$/.test(k));
      assert.deepEqual(order, ['TESTNET_TX_SUBMISSION_STARTED', 'TESTNET_TX_SUBMITTED', 'TESTNET_TX_CONFIRMED', 'DOMAIN_EXECUTION_SETTLED']);
    }, { kind: 'LIVE' });
  });

  it('the same success over the offline reference model is REFERENCE_MODEL, never LIVE_TESTNET', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'CONFIRMED');
      if (r.status === 'CONFIRMED') assert.equal(r.evidence, 'REFERENCE_MODEL');
      assert.ok(w.session.events.events.every((e) => e.data['evidence'] !== 'LIVE_TESTNET'));
    }, { kind: 'LIVE' });
  });

  it('every settlement event carries the fixture-asset qualification and the stock agent, and no key, raw transaction or signature', async () => {
    await withWorld(async (w) => {
      w.rpc.transport = 'ROBINHOOD_TESTNET_RPC';
      const p = await prepared(w);
      await w.settlement.run(p, { mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: w.ledgerPath() });
      await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      const events = settlementEvents(w);
      assert.ok(events.length >= 10);
      for (const e of events) {
        assert.equal(e.agent, 'stock', e.kind);
        assert.equal(e.data['qualification'], ASSET_QUALIFICATION, e.kind);
        assert.match(String(e.data['qualification']), /valueless demo assets/);
      }
      const all = JSON.stringify(w.session.events.events).toLowerCase();
      for (const k of ALL_TEST_KEYS) assert.ok(!all.includes(k), 'a private key reached the event stream');
      assert.equal(containsKey(all), false);
      assert.doesNotMatch(all, /"(raw|calldata|signature|principalsignature|agentsignature|privatekey|apikey)"/);
    }, { kind: 'LIVE' });
  });

  it('the other four domains stay what they were: nothing but the Stock child is ever settled, and nothing else is LIVE_TESTNET', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      assert.equal(p.execution.role, 'stock');
      w.rpc.transport = 'ROBINHOOD_TESTNET_RPC';
      await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      for (const e of w.of('PORTFOLIO_AUTHORIZED')) {
        for (const x of e.data['executions'] as readonly { readonly evidence: string }[]) assert.notEqual(x.evidence, 'LIVE_TESTNET');
      }
      for (const e of w.session.events.events) if (e.data['evidence'] === 'LIVE_TESTNET') assert.equal(e.agent, 'stock');
      assert.equal(w.rpc.chain.txs.length, 1);
      // All five reserved; only the Stock child was ever handed to the settlement path.
      assert.deepEqual([...new Set(w.session.reservedExecutions.map((r) => r.role))].sort(), ['nft', 'perps', 'stock', 'swap', 'yield']);
      assert.ok(settlementEvents(w).every((e) => e.agent === 'stock'));
    }, { kind: 'LIVE', others: { swap: propose('route-a', 200), nft: propose('genesis-11', 300), yield: propose('alpha-usd-vault', 300), perps: propose('btc-long-2x', 200) } });
  });
});
