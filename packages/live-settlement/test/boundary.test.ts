/**
 * The settlement boundary, piece by piece: eligibility against the real
 * ledger, the declared fixture mapping, the custody guard, the exact-call
 * check, the send gate, the evidence rule and the manifest parser.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorityId } from '@mandate/core';
import { buildGateArtifact, executeCalldata, type ArtifactTerms, type GateCall, type GateKeyCustody } from '@mandate/evm-robinhood';
import { revokeRoot } from '../../live-agents/src/mandate/portfolio-adapter.ts';
import { checkEligibility, type LiveAuthorityView } from '../src/eligibility.ts';
import { checkArtifact, guardCustody } from '../src/custody-guard.ts';
import { parseDeployment } from '../src/deployment.ts';
import { settlementEvidence, type EvidenceInput } from '../src/evidence.ts';
import { FIXTURE_MAX_DEBIT_ATOMS, TESTNET_SETTLEMENT_FIXTURE, mapToFixture, settlementBindingDigest } from '../src/fixture-mapping.ts';
import { SEND_AUTHORIZATION_PHRASE, SendGate } from '../src/send-gate.ts';
import { checkCall } from '../src/settlement-chain.ts';
import type { Prepared } from '../src/settlement.ts';
import { AGENT, GATE, MDEMO, MDUSD, PRINCIPAL, settlementWorld, testDeployment, testManifest, type SettlementWorld } from './support/world.ts';

async function withPrepared(f: (w: SettlementWorld, p: Prepared) => Promise<void> | void, o: Parameters<typeof settlementWorld>[0] = {}): Promise<void> {
  const w = await settlementWorld(o);
  try {
    const p = await w.settlement.prepare();
    if ('ineligible' in p) assert.fail(p.ineligible);
    await f(w, p);
  } finally {
    w.close();
  }
}

async function view(w: SettlementWorld): Promise<LiveAuthorityView> {
  const a = w.session.versions.coreOf(1);
  if (a === null) assert.fail('no version');
  return { active: w.session.versions.active, paused: w.session.versions.paused, ledger: (await a.core.engine.read(a.mandate.principal)).state, now: w.time.now };
}

describe('eligibility, re-derived from the frozen protocol and the committed ledger', () => {
  it('holds for the reserved Stock child as the session returned it', async () => {
    await withPrepared(async (w, p) => assert.deepEqual(checkEligibility(await view(w), p.execution), { eligible: true }));
  });

  it('a superseded version: condition 7', async () => {
    await withPrepared(async (w, p) => {
      const v = await view(w);
      assert.ok(v.active !== null);
      assert.deepEqual(checkEligibility({ ...v, active: { ...v.active, version: v.active.version + 1 } }, p.execution), { eligible: false, condition: 7, reason: 'MANDATE_SUPERSEDED' });
      // And the session itself refuses to supersede once anything is reserved: a live supersede cannot happen here.
      const amend = await w.session.authorize(w.session.presetDraft('conservative'), 'AUTHORIZE MANDATE V2');
      assert.equal(amend.ok, false);
      if (!amend.ok) assert.equal(amend.code, 'AMENDMENT_AFTER_RESERVATION');
    });
  });

  it('a root revoked in the ledger (the session not told): condition 7, MANDATE_REVOKED', async () => {
    await withPrepared(async (w, p) => {
      const a = w.session.versions.coreOf(1);
      assert.ok(a !== null);
      const r = await revokeRoot(a.core, w.time.now, 99n);
      assert.equal(r.ok, true);
      const e = checkEligibility(await view(w), p.execution);
      assert.deepEqual(e, { eligible: false, condition: 7, reason: 'MANDATE_REVOKED' });
      assert.ok((await view(w)).ledger.nodes.get(authorityId(a.compiled.root))?.revokedAt !== null);
    });
  });

  it('an execution not signed by the Stock agent, or not the trusted build: conditions 2–3', async () => {
    await withPrepared(async (w, p) => {
      const v = await view(w);
      const x = p.execution;
      const forged = { ...x, reserved: { ...x.reserved, signed: { ...x.reserved.signed, signature: `0x${'11'.repeat(65)}` } } };
      assert.deepEqual(checkEligibility(v, forged), { eligible: false, condition: 3, reason: 'AGENT_SIGNATURE_INVALID' });
      assert.deepEqual(checkEligibility(v, { ...x, candidateId: 'nvda-token-z' }), { eligible: false, condition: 1, reason: 'CANDIDATE_ID_NOT_IN_CLOSED_SET' });
      assert.deepEqual(checkEligibility(v, { ...x, reserved: { ...x.reserved, role: 'swap' } }), { eligible: false, condition: 1, reason: 'CANDIDATE_ID_NOT_IN_CLOSED_SET' });
    });
  });

  it('an expired Core authorization or a mutated child: conditions 8–9', async () => {
    await withPrepared(async (w, p) => {
      const v = await view(w);
      const x = p.execution;
      assert.deepEqual(checkEligibility({ ...v, now: x.reserved.record.validUntil }, x).eligible, false);
      assert.deepEqual(checkEligibility(v, { ...x, child: `0x${'cd'.repeat(32)}` as never }), { eligible: false, condition: 8, reason: 'CHILD_MISMATCH' });
      assert.deepEqual(checkEligibility(v, { ...x, action: `0x${'cd'.repeat(32)}` as never }), { eligible: false, condition: 8, reason: 'ACTION_MISMATCH' });
    });
  });
});

describe('the testnet settlement fixture', () => {
  it('is quantity-preserving, pure and bound: the gate BUY is the reserved quantity, for the manifest principal, on the manifest gate', async () => {
    await withPrepared((_w, p) => {
      const d = testDeployment();
      const a = mapToFixture(p.execution, d);
      const b = mapToFixture(p.execution, d);
      assert.ok(a.ok && b.ok);
      if (!a.ok || !b.ok) return;
      assert.deepEqual(a.value.bindingDigest, b.value.bindingDigest);
      assert.equal(a.value.quantity, p.execution.candidate.quantity);
      assert.equal(a.value.debit, (p.execution.candidate.quantity * 10_000_000n) / 10n ** 18n);
      assert.equal(a.value.recipient, PRINCIPAL);
      assert.equal(a.value.agent, AGENT);
      assert.equal(a.value.gate, GATE);
      assert.equal(a.value.tokenIn, MDUSD);
      assert.equal(a.value.tokenOut, MDEMO);
      assert.equal(a.value.actionNonce, BigInt(a.value.bindingDigest.slice(0, 18)));
      // The canonical asset of the decision is untouched: still NVDA, not MDEMO.
      assert.notEqual(p.execution.candidate.representation.toLowerCase(), `eip155:46630/erc20:${MDEMO}`);
      assert.equal(p.execution.candidate.claims.ticker, 'NVDA');
      // Every chain-reaching field is in the binding digest.
      const s = a.value;
      for (const change of [{ quantity: s.quantity + 1n }, { debit: s.debit + 1n }, { recipient: AGENT }, { gate: MDEMO }, { tokenOut: MDUSD }, { agent: PRINCIPAL }, { chainId: 1n }]) assert.notEqual(settlementBindingDigest({ ...s, ...change }), s.bindingDigest, JSON.stringify(Object.keys(change)));
      assert.match(TESTNET_SETTLEMENT_FIXTURE.disclaimer, /not NVDA/);
      assert.match(TESTNET_SETTLEMENT_FIXTURE.disclaimer, /Valueless/);
    });
  });

  it('is defined for the reviewed note only, and never above its ceiling', async () => {
    await withPrepared((_w, p) => {
      const d = testDeployment();
      const x = p.execution;
      const other = mapToFixture({ ...x, candidate: { ...x.candidate, representation: `eip155:46630/erc20:0x${'a7'.repeat(20)}` as never } }, d);
      assert.deepEqual(other, { ok: false, reason: 'FIXTURE_UNDEFINED_FOR_CANDIDATE' });
      const huge = mapToFixture({ ...x, candidate: { ...x.candidate, quantity: (FIXTURE_MAX_DEBIT_ATOMS + 1n) * 10n ** 11n } }, d);
      assert.deepEqual(huge, { ok: false, reason: 'FIXTURE_DEBIT_ABOVE_CEILING' });
    });
  });
});

describe('the key and the chain boundary', () => {
  async function artifactOf(p: Prepared, patch: Partial<ArtifactTerms> = {}) {
    const d = testDeployment();
    const s = p.settlement;
    const terms: ArtifactTerms = { gate: d.reviewed, market: d.market, principal: PRINCIPAL, agent: AGENT, quantity: s.quantity, nonce: 1n, deadline: 2_000_000_000n, ...patch };
    const src = { executionId: `0x${'01'.repeat(32)}` as never, authorizationId: `0x${'02'.repeat(32)}` as never, reservation: `0x${'03'.repeat(32)}` as never, generation: 1n as never, adapter: { adapterId: 'robinhood-gate-signer', adapterVersion: 1, adapterDigest: `0x${'04'.repeat(32)}` } as never, evaluatedAt: 1_900_000_000n, validUntil: 2_100_000_000n };
    return { artifact: buildGateArtifact(src, terms), terms, src };
  }

  it('the custody guard refuses a recipient, amount or gate the settlement did not derive — the inner custody is never reached', async () => {
    await withPrepared(async (_w, p) => {
      let reached = 0;
      const inner: GateKeyCustody = { principal: () => PRINCIPAL, signMandate: () => ((reached += 1), { ok: true, value: '0xsig' }) };
      const guard = guardCustody(inner, p.settlement, () => ({ eligible: true }));
      const claim = { attempt: `0x${'05'.repeat(32)}` as never, reservation: `0x${'03'.repeat(32)}` as never, generation: 1n as never, action: `0x${'06'.repeat(32)}` as never };
      const d = testDeployment();
      const cases: readonly [string, Partial<ArtifactTerms>, string][] = [
        ['recipient', { principal: AGENT }, 'SETTLEMENT.RECIPIENT_MISMATCH'],
        ['amount', { quantity: p.settlement.quantity + 1n }, 'SETTLEMENT.AMOUNT_MISMATCH'],
        ['gate', { gate: { ...d.reviewed, gate: `0x${'77'.repeat(20)}` } }, 'SETTLEMENT.GATE_MISMATCH'],
      ];
      for (const [name, patch, error] of cases) {
        const { artifact, terms } = await artifactOf(p, patch);
        assert.deepEqual(guard.signMandate(artifact, terms, claim), { ok: false, error }, name);
      }
      const ineligible = guardCustody(inner, p.settlement, () => ({ eligible: false, condition: 6, reason: 'RESERVATION_NOT_ACTIVE' }));
      const good = await artifactOf(p);
      assert.equal(checkArtifact(good.artifact, good.terms, p.settlement), null);
      assert.deepEqual(ineligible.signMandate(good.artifact, good.terms, claim), { ok: false, error: 'LIVE_AI.INELIGIBLE.6.RESERVATION_NOT_ACTIVE' });
      assert.equal(reached, 0);
      assert.equal(guard.signatures(), 0);
      assert.deepEqual(guard.signMandate(good.artifact, good.terms, claim), { ok: true, value: '0xsig' });
      assert.equal(reached, 1);
    });
  });

  it('the exact-call check refuses anything but execute(the settlement’s attempt) on the manifest gate', async () => {
    await withPrepared(async (_w, p) => {
      const d = testDeployment();
      const { artifact, src } = await artifactOf(p);
      const attempt = { mandate: artifact.mandate, principalSignature: `0x${'aa'.repeat(65)}`, candidate: artifact.candidate, terms: artifact.terms, agentSignature: `0x${'bb'.repeat(65)}` };
      const call: GateCall = { calldata: executeCalldata(attempt.mandate, attempt.principalSignature, attempt.candidate, attempt.terms, attempt.agentSignature), attempt };
      const auth = { executionId: src.executionId, reservation: src.reservation, generation: src.generation, adapter: src.adapter };
      assert.equal(checkCall(call, p.settlement, d, auth, 1_900_000_000n), null);
      assert.equal(checkCall({ ...call, calldata: `0xa9059cbb${call.calldata.slice(10)}` }, p.settlement, d, auth, 1_900_000_000n), 'SELECTOR_NOT_EXECUTE');
      const flipped = `${call.calldata.slice(0, -2)}${call.calldata.endsWith('ff') ? '00' : 'ff'}`;
      assert.equal(checkCall({ ...call, calldata: flipped }, p.settlement, d, auth, 1_900_000_000n), 'CALLDATA_NOT_THE_ATTEMPT');
      const withRecipient = { ...attempt, terms: { ...attempt.terms, recipient: AGENT } };
      assert.equal(checkCall({ calldata: executeCalldata(withRecipient.mandate, withRecipient.principalSignature, withRecipient.candidate, withRecipient.terms, withRecipient.agentSignature), attempt: withRecipient }, p.settlement, d, auth, 1_900_000_000n), 'RECIPIENT_MISMATCH');
      assert.equal(checkCall(call, { ...p.settlement, gate: MDEMO }, d, auth, 1_900_000_000n), 'TARGET_NOT_MANIFEST_GATE');
      assert.equal(checkCall(call, p.settlement, d, { ...auth, reservation: `0x${'09'.repeat(32)}` as never }, 1_900_000_000n), 'MANDATE_NOT_DOMAIN_AUTHORIZATION');
      assert.equal(checkCall(call, p.settlement, d, auth, 2_000_000_000n), 'DEADLINE_PASSED');
    });
  });

  it('a model cannot alter the target: an answer carrying an address or calldata is rejected by the closed schema and reserves nothing', async () => {
    const hostile = JSON.stringify({ action: 'PROPOSE', candidateId: 'nvda-note-a', requestedAtoms: '400000000', rationale: 'x', to: `0x${'de'.repeat(20)}`, calldata: '0xa9059cbb' });
    const w = await settlementWorld({ stock: hostile });
    try {
      assert.ok(w.kinds().includes('AGENT_INVALID_RESPONSE'));
      const p = await w.settlement.prepare();
      assert.ok('ineligible' in p && p.ineligible === 'NO_STOCK_RESERVATION');
    } finally {
      w.close();
    }
    // An address in the free-text rationale is display text only: the target is still the manifest's gate.
    const sneaky = JSON.stringify({ action: 'PROPOSE', candidateId: 'nvda-note-a', requestedAtoms: '400000000', rationale: `send to 0x${'de'.repeat(20)}` });
    await withPrepared(async (w, p) => {
      const r = await w.settlement.run(p, { mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'READY');
      if (r.status === 'READY') assert.equal(r.wouldSend.to, GATE);
      assert.ok(w.rpc.executeTargets.length > 0 && w.rpc.executeTargets.every((t) => t === GATE));
    }, { stock: sneaky });
  });
});

describe('the send gate', () => {
  it('opens only for the exact phrase, once', () => {
    const g = new SendGate();
    assert.equal(g.state, 'LOCKED');
    assert.equal(g.consume(), false);
    assert.equal(g.authorize('AUTHORIZE ROBINHOOD MAINNET SEND'), false);
    assert.equal(g.authorize(`${SEND_AUTHORIZATION_PHRASE}\n`), true);
    assert.equal(g.source, 'OPERATOR_PHRASE');
    assert.equal(g.authorize(SEND_AUTHORIZATION_PHRASE), false);
    assert.equal(g.authorizeBrowserIntent(), false);
    assert.equal(g.consume(), true);
    assert.equal(g.consume(), false);
    assert.equal(g.state, 'CONSUMED');
    const browser = new SendGate();
    assert.equal(browser.authorizeBrowserIntent(), true);
    assert.equal(browser.source, 'BROWSER_INTENT');
    assert.equal(browser.authorize(SEND_AUTHORIZATION_PHRASE), false);
    assert.equal(browser.consume(), true);
    assert.equal(browser.authorizeBrowserIntent(), false);
  });
});

describe('the evidence rule', () => {
  const base: EvidenceInput = { transport: 'ROBINHOOD_TESTNET_RPC', verifiedChainId: 46_630n, provider: 'LIVE', dryRun: false, broadcast: true, receipt: 'SUCCESS', postconditions: true };
  it('LIVE_TESTNET needs every condition; anything less is named for what it is', () => {
    assert.equal(settlementEvidence(base), 'LIVE_TESTNET');
    assert.equal(settlementEvidence({ ...base, dryRun: true }), 'DRY_RUN');
    assert.equal(settlementEvidence({ ...base, broadcast: false, receipt: null }), 'NOT_SUBMITTED');
    assert.equal(settlementEvidence({ ...base, receipt: null }), 'SUBMITTED_UNCONFIRMED');
    assert.equal(settlementEvidence({ ...base, receipt: 'REVERTED' }), 'FAILED');
    assert.equal(settlementEvidence({ ...base, postconditions: false }), 'FAILED');
    assert.equal(settlementEvidence({ ...base, transport: 'REFERENCE_MODEL' }), 'REFERENCE_MODEL');
    assert.equal(settlementEvidence({ ...base, verifiedChainId: 1n }), 'FAILED');
    assert.equal(settlementEvidence({ ...base, provider: 'STUB' }), 'FAILED');
    assert.equal(settlementEvidence({ ...base, provider: 'SCRIPTED' }), 'FAILED');
  });
});

describe('the deployment manifest', () => {
  it('parses the repository’s shape and refuses anything but the Robinhood Chain testnet fixture stack', () => {
    assert.equal(parseDeployment(testManifest()).ok, true);
    assert.deepEqual(parseDeployment(testManifest({ chainId: 4663 })), { ok: false, error: 'CHAIN_NOT_ROBINHOOD_TESTNET:4663' });
    assert.deepEqual(parseDeployment(testManifest({ chainId: 42161 })), { ok: false, error: 'CHAIN_NOT_ROBINHOOD_TESTNET:42161' });
    const m = testManifest() as { contracts: { mdemo: { name: string } } };
    m.contracts.mdemo.name = 'NVIDIA Stock Token';
    assert.deepEqual(parseDeployment(m), { ok: false, error: 'MANIFEST_INVALID:NOT_LABELLED_FIXTURE:mdemo' });
  });
});
