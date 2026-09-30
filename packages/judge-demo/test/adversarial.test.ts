/**
 * End to end, adversarial, through the public production API — not the
 * demo's narration.
 *
 * One principal-signed Portfolio Mandate; five real agent identities; the
 * deterministic canonical agents negotiate; the real verifier and the real
 * ledger authorize. Then the swap agent, with its legitimate key, signs a
 * prohibited action: it is refused before any executor (the only path to a
 * signer or a venue) is called, and nothing in the ledger moves; a
 * compromised Room committing it anyway is refused by the verifier and by
 * the reservation boundary. Healthy reservations are intact; the same key's
 * compliant action is authorized; every run yields a Receipt V2 — and the
 * receipts are byte for byte the ones the judge demo reports.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PortfolioTag,
  compilePortfolio,
  createPortfolioCore,
  defaultExecutor,
  mandateSignedByPrincipal,
  agentPolicyOf,
  proposalSignedByAgent,
  receiptDigest,
  registerPortfolio,
  reserveChild,
  runPortfolio,
  type ChildExecutor,
} from '@mandate/portfolio';
import { DEMO_NOW, DEMO_T0, demoAgentStrategies, demoBindings, demoMandate, demoParty, demoPrincipalSignature } from '@mandate/portfolio/demo';
import { ATTACK_TIME, COMPLIANT_TIME, CONTINUATION_SWAP_ATOMS, AgentIdentity, ContinuationAgent, compliantSwap, forgeRoomAcceptance, maliciousSwap, nextSequence, transcriptOf } from '../src/index.ts';
import { judgeDemo } from './support/demo.ts';

const corpus = JSON.parse(readFileSync(new URL('../../../corpus/portfolio-demo-v1/receipt.json', import.meta.url), 'utf8')) as { receiptDigest: string };

describe('adversarial judge scenario, end to end', () => {
  it('a valid agent’s prohibited action is refused with zero unauthorized use; the healthy portfolio and the same agent carry on', async () => {
    // One real signed Portfolio Mandate, compiled into Core and registered in the ledger.
    const m = demoMandate();
    const compiled = compilePortfolio(m, demoBindings());
    assert.ok(compiled.ok);
    const core = createPortfolioCore(compiled.value);
    assert.ok((await registerPortfolio(core, DEMO_T0)).ok);
    const signature = demoPrincipalSignature();
    assert.equal(mandateSignedByPrincipal(m, signature), true);

    // Five real, distinct agent identities the mandate names.
    const roles = ['stock', 'swap', 'nft', 'yield', 'perps'];
    assert.equal(new Set(roles.map((r) => demoParty(r).value)).size, 5);
    for (const r of roles) assert.ok(agentPolicyOf(m, demoParty(r)) !== null, r);

    // Every executor call is where a signer or a venue could be reached.
    const exec = defaultExecutor(core);
    let executorCalls = 0;
    const counting: ChildExecutor = async (...a) => {
      executorCalls += 1;
      return exec(...a);
    };
    const read = () => core.engine.read(m.principal);

    // Deterministic proposals, negotiation, real verification, real reservations.
    const initial = await runPortfolio({ core, signature, now: DEMO_NOW, agents: demoAgentStrategies(m, compiled.value.bindings, DEMO_NOW), execute: counting });
    assert.equal(initial.verification.status, 'VERIFIED');
    assert.deepEqual(initial.reservations.map((r) => r.status), ['RESERVED', 'RESERVED', 'RESERVED', 'RESERVED']);
    assert.ok(initial.room.decisions.some((d) => d.outcome === 'REDUCE_REQUESTED'));
    assert.equal(initial.digest, corpus.receiptDigest);
    assert.equal(executorCalls, 4);
    const healthy = await read();

    // The compromised swap agent: its legitimate key signs the approved swap paying an attacker.
    const swap = new AgentIdentity('swap');
    const attacker = new ContinuationAgent(swap, m, compiled.value.bindings, ATTACK_TIME, maliciousSwap(CONTINUATION_SWAP_ATOMS, ATTACK_TIME), nextSequence(initial.room.proposals, swap.party));
    const attack = await runPortfolio({ core, signature, now: ATTACK_TIME, agents: [attacker], execute: counting });
    const signed = attack.room.proposals[0];
    assert.ok(signed !== undefined);
    assert.equal(signed.proposal.agent.value, demoParty('swap').value);
    assert.equal(proposalSignedByAgent(signed.proposal, signed.signature), true);
    assert.deepEqual(attack.room.decisions.map((d) => [d.outcome, d.reasons.map((r) => r.code).join()]), [['REJECTED', 'RECIPIENT_NOT_ALLOWED']]);
    assert.equal(swap.uses, 1);

    // Zero unauthorized use: no executor call, no reservation, no attempt, no transaction; the ledger did not move.
    assert.equal(executorCalls, 4);
    const afterAttack = await read();
    assert.equal(afterAttack.version, healthy.version);
    assert.equal(afterAttack.state.reservations.size, healthy.state.reservations.size);
    assert.equal(afterAttack.state.attempts.size, healthy.state.attempts.size);
    assert.equal(attack.receipt.transactions, 0);

    // A compromised Room commits it anyway: the verifier refuses, and so does the reservation boundary.
    const transcript = transcriptOf(core, signature, attack, ATTACK_TIME);
    const forged = forgeRoomAcceptance(m, core, transcript, signed);
    assert.ok(forged.result.status === 'REFUSED' && forged.result.reasons.some((r) => r.code === 'RECIPIENT_NOT_ALLOWED'));
    const honestSwapChild = initial.verification.status === 'VERIFIED' ? initial.verification.children.find((c) => c.child.agent.value === swap.party.value) : undefined;
    assert.ok(honestSwapChild !== undefined);
    const reserved = await reserveChild(core, { ...transcript, candidate: { ...transcript.candidate, accepted: [forged.proposal] } }, honestSwapChild.digest, ATTACK_TIME);
    assert.equal(reserved.status, 'REFUSED');
    assert.equal((await read()).version, healthy.version);

    // Healthy agents remain intact: every reservation is still the same, ACTIVE, at the same version.
    for (const [id, r] of healthy.state.reservations.entries()) assert.deepEqual(afterAttack.state.reservations.get(id), r);

    // The same key's compliant action still works.
    const honest = new ContinuationAgent(swap, m, compiled.value.bindings, COMPLIANT_TIME, compliantSwap(CONTINUATION_SWAP_ATOMS, COMPLIANT_TIME), nextSequence([...initial.room.proposals, ...attack.room.proposals], swap.party));
    const compliant = await runPortfolio({ core, signature, now: COMPLIANT_TIME, agents: [honest], execute: counting });
    assert.equal(swap.uses, 2);
    assert.equal(compliant.verification.status, 'VERIFIED');
    assert.deepEqual(compliant.reservations.map((r) => r.status), ['RESERVED']);
    assert.deepEqual(compliant.executions.map((e) => [e.status, e.evidence, e.transactions]), [['SETTLED', 'SIMULATED', 0]]);
    assert.equal(executorCalls, 5);

    // Receipt V2 for every run, and they are exactly the judge demo's.
    for (const r of [initial, attack, compliant]) assert.equal(receiptDigest(r.receipt), r.digest);
    assert.equal(PortfolioTag.RECEIPT, 'PORTFOLIO_RECEIPT.V2');
    const { transcript: judge } = await judgeDemo();
    const reported = judge.events.filter((e) => e.kind === 'PORTFOLIO_RECEIPT_CREATED').map((e) => e.artifacts.find((a) => a.name === 'receiptDigest')?.value);
    assert.deepEqual(reported.slice(0, 3), [initial.digest, attack.digest, compliant.digest]);
  });
});
