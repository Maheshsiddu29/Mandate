/**
 * One Stock candidate, the same one, from the model's choice to the
 * settlement binding:
 *
 * ```text
 * MODEL_SELECTED_CANDIDATE == SCREENED_CANDIDATE == RESERVED_CANDIDATE == SETTLED_SEMANTIC_CANDIDATE
 * ```
 *
 * for both approved notes, with and without a Mandate Room. Both notes are
 * exercised through the same valueless MDEMO fixture; the binding, not the
 * token, says which note was settled. Nothing here ever substitutes one note
 * for the other, and anything the settlement profile does not name still
 * fails closed at settlement.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { candidateDigest, proposalDigest } from '@mandate/portfolio';
import { STOCK_APPROVED, STOCK_LOOKALIKE, STOCK_SERIES_C } from '@mandate/portfolio/demo';
import { DOMAIN_AGENTS, LIVE_LAB_SETTLEMENT_PROFILE, type SettlementProfile } from '@mandate/live-agents';
import { everyCandidate } from '../../live-agents/test/support/world.ts';
import { checkEligibility } from '../src/eligibility.ts';
import { mapToFixture, settlementBindingDigest } from '../src/fixture-mapping.ts';
import type { Prepared } from '../src/settlement.ts';
import { json } from '../../live-agents/test/support/providers.ts';
import { SendGate } from '../src/send-gate.ts';
import { abstain, propose, settlementWorld, testDeployment, USDC, type SettlementWorld } from './support/world.ts';

const reduce = (whole: number) => json({ action: 'REDUCE', newRequestedAtoms: USDC(whole), rationale: `reduce to ${whole}` });
const release = json({ action: 'RELEASE', newRequestedAtoms: null, rationale: 'withdraw' });
const keep = json({ action: 'KEEP', newRequestedAtoms: null, rationale: 'keep' });

const REPRESENTATION: { readonly [id: string]: string } = { 'nvda-note-a': STOCK_APPROVED, 'nvda-note-c': STOCK_SERIES_C };

/** With note C at 600 (598.50 notional): 2,598.50 of 2,500 — a real capital conflict. */
const CROWDED = { swap: propose('route-a', 500), nft: propose('genesis-11', 300), yield: propose('alpha-usd-vault', 800), perps: propose('btc-long-2x', 400) };
/** With note C at 600: 1,948.50 of 2,500 — everything fits. */
const ROOMY = { swap: propose('route-c', 250), nft: propose('genesis-11', 300), yield: propose('beta-usd-vault', 400), perps: propose('btc-long-2x', 400) };

async function withWorld(o: Parameters<typeof settlementWorld>[0], f: (w: SettlementWorld) => Promise<void>): Promise<void> {
  const w = await settlementWorld(o);
  try {
    await f(w);
  } finally {
    w.close();
  }
}

async function prepared(w: SettlementWorld): Promise<Prepared> {
  const p = await w.settlement.prepare();
  if ('ineligible' in p) assert.fail(`not prepared: ${p.stage} ${p.ineligible}`);
  return p;
}

/** Every link of the chain, for the note `id` the model chose. */
async function assertBoundThrough(w: SettlementWorld, id: string): Promise<Prepared> {
  // 18: what the model selected is what was proposed and screened.
  const decided = w.of('AGENT_DECISION_COMPLETED').find((e) => e.agent === 'stock');
  assert.equal(decided?.data['candidateId'], id);
  const screened = w.of('PROPOSAL_ADMISSIBLE').find((e) => e.agent === 'stock');
  const signedAtDiscovery = w.of('PROPOSAL_SIGNED').find((e) => e.agent === 'stock' && e.data['phase'] === undefined);
  assert.equal(screened?.data['proposal'], signedAtDiscovery?.data['proposal']);
  // 19: the reservation is that candidate.
  const stock = w.session.reservedExecutions.filter((x) => x.role === 'stock');
  assert.equal(stock.length, 1);
  const r = stock[0]!;
  assert.equal(r.candidateId, id);
  assert.ok(r.verified.candidate.kind === 'STOCK_BUY' && r.signed.proposal.candidate.kind === 'STOCK_BUY');
  assert.equal(candidateDigest(r.verified.candidate), candidateDigest(r.signed.proposal.candidate));
  assert.equal(r.verified.candidate.representation, REPRESENTATION[id]);
  // 20: the settlement exercises that same semantic candidate.
  const p = await prepared(w);
  assert.equal(p.execution.reserved, r);
  assert.equal(p.execution.candidateId, id);
  assert.equal(p.execution.proposal, proposalDigest(r.signed.proposal));
  assert.equal(p.execution.candidateDigest, candidateDigest(r.verified.candidate));
  assert.deepEqual([p.settlement.semantic.candidateId, p.settlement.semantic.representation], [id, REPRESENTATION[id]]);
  assert.equal(p.settlement.quantity, p.execution.candidate.quantity);
  assert.equal(settlementBindingDigest(p.settlement), p.settlement.bindingDigest);
  assert.equal(p.settlement.actionNonce, BigInt(p.settlement.bindingDigest.slice(0, 18)));
  return p;
}

describe('18–20: the chosen note is the proposed, reserved and settled note', () => {
  for (const id of ['nvda-note-a', 'nvda-note-c']) {
    it(`${id}: selected == screened == reserved == settled semantic candidate, and the dry run is READY`, async () => {
      await withWorld({ stock: propose(id, 400) }, async (w) => {
        assert.deepEqual(w.of('AGENT_CANDIDATES_EVALUATED').find((e) => e.agent === 'stock')?.data['executable'], ['nvda-note-a', 'nvda-note-c']);
        const p = await assertBoundThrough(w, id);
        const run = await w.settlement.run(p, { mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: w.ledgerPath() });
        assert.equal(run.status, 'READY');
        assert.equal(run.broadcasts, 0);
        assert.equal(w.rpc.broadcasts, 0);
      });
    });
  }

  it('the two notes bind differently through the same fixture token; note A’s binding is unchanged', async () => {
    const digests = new Map<string, string>();
    for (const id of ['nvda-note-a', 'nvda-note-c']) {
      await withWorld({ stock: propose(id, 400) }, async (w) => {
        const p = await prepared(w);
        assert.equal(p.settlement.tokenOut, w.deployment.mdemo.address);
        digests.set(id, p.settlement.bindingDigest);
      });
    }
    assert.notEqual(digests.get('nvda-note-a'), digests.get('nvda-note-c'));
    // The note A binding for this deterministic world, as it was before note C had a settlement definition.
    assert.equal(digests.get('nvda-note-a'), '0x8732895ed2b2c9440dadc183be917d29a8acf47635c9c8657bd4a4e9cf2a6bcb');
  });
});

describe('C: the Room and the settlement capability', () => {
  it('C1: a portfolio that fits — no Room, and the note C reservation is settlement-ready', async () => {
    await withWorld({ stock: propose('nvda-note-c', 600), others: ROOMY }, async (w) => {
      assert.equal(w.of('ROOM_OPENED').length, 0);
      assert.equal(w.session.reservedExecutions.length, 5);
      const p = await assertBoundThrough(w, 'nvda-note-c');
      // A dry run needs no send authorization: the gate stays closed.
      const run = await w.settlement.run(p, { mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: w.ledgerPath() });
      assert.equal(run.status, 'READY');
      assert.equal(run.broadcasts, 0);
    });
  });

  it('C2 / 21: the Room reduces note C’s amount, never its identity', async () => {
    await withWorld({ stock: propose('nvda-note-c', 600), others: CROWDED, negotiate: (role) => (role === 'stock' ? reduce(400) : keep) }, async (w) => {
      assert.equal(w.of('ROOM_OPENED').length, 1);
      const p = await assertBoundThrough(w, 'nvda-note-c');
      const original = w.of('PROPOSAL_SIGNED').find((e) => e.agent === 'stock' && e.data['phase'] === undefined);
      assert.notEqual(p.execution.proposal, original?.data['proposal']);
      // The reduced size, built from the very same trusted candidate.
      const note = DOMAIN_AGENTS.stock.candidates.find((c) => c.id === 'nvda-note-c')!;
      const at400 = note.build(400_000_000n, 0n);
      assert.ok(at400.kind === 'STOCK_BUY');
      assert.equal(p.execution.candidate.quantity, at400.quantity);
    });
  });

  it('C3 / 22: when the Room releases Stock, nothing settles and nothing is substituted', async () => {
    await withWorld({ stock: propose('nvda-note-c', 600), others: CROWDED, negotiate: (role) => (role === 'stock' ? release : keep) }, async (w) => {
      assert.equal(w.of('ROOM_RELEASE')[0]?.agent, 'stock');
      assert.ok(!w.session.reservedExecutions.some((x) => x.role === 'stock'));
      const p = await w.settlement.prepare();
      assert.ok('ineligible' in p && p.ineligible === 'NO_STOCK_RESERVATION');
      assert.equal(w.rpc.simulations + w.rpc.prepared + w.rpc.broadcasts, 0);
    });
  });
});

describe('16: what the profile does not name still fails closed at settlement', () => {
  it('a relabelled or swapped candidate is undefined for the fixture, and eligibility refuses the relabel on its own', async () => {
    await withWorld({}, async (w) => {
      const p = await prepared(w);
      const x = p.execution;
      const d = testDeployment();
      const asNoteC = { ...x, candidateId: 'nvda-note-c' };
      const lookalike = { ...x, candidateId: 'nvda-token-b', candidate: { ...x.candidate, representation: STOCK_LOOKALIKE as never } };
      const unknown = { ...x, candidateId: 'nvda-note-z' };
      for (const bad of [asNoteC, lookalike, unknown]) assert.deepEqual(mapToFixture(bad, d), { ok: false, reason: 'FIXTURE_UNDEFINED_FOR_CANDIDATE' }, bad.candidateId);
      // Conditions 1–2 come first: no ledger is consulted before the relabel is refused.
      const e = checkEligibility({ active: w.session.versions.active, paused: false, ledger: { reservations: new Map(), nodes: new Map() } as never, now: w.time.now }, asNoteC);
      assert.deepEqual(e, { eligible: false, condition: 2, reason: 'CANDIDATE_NOT_TRUSTED_BUILD' });
    });
  });

  it('17: a profile that calls the look-alike capable changes nothing downstream — it is blocked, never reserved, never settled', async () => {
    const everything: SettlementProfile = { ...LIVE_LAB_SETTLEMENT_PROFILE, id: 'test.everything', capabilityOf: (_role, c) => ({ candidateId: c.id, status: 'SETTLEMENT_CAPABLE', profile: 'test.everything', connector: 'robinhood-testnet-fixture', reason: null }) };
    await withWorld({ stock: propose('nvda-token-b', 400), eligibility: everyCandidate, settlement: everything }, async (w) => {
      assert.equal(w.of('PROPOSAL_BLOCKED')[0]?.agent, 'stock');
      assert.equal(w.session.reservedExecutions.length, 0);
      const p = await w.settlement.prepare();
      assert.ok('ineligible' in p && p.ineligible === 'NO_STOCK_RESERVATION');
    });
  });

  it('no Stock decision at all: nothing to settle', async () => {
    await withWorld({ stock: abstain }, async (w) => {
      const p = await w.settlement.prepare();
      assert.ok('ineligible' in p && p.ineligible === 'NO_STOCK_RESERVATION');
    });
  });
});
