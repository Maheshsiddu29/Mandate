/**
 * C3.3 / C3.4 — screen + reserve facade parity with portfolio / ledger.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_AGENTS, LiveSession, presetDraft, StubProvider } from '@mandate/live-agents';
import { ManualClock } from '../../live-agents/src/runtime/clock.ts';
import { CountingEntropy } from '../../live-agents/src/runtime/entropy.ts';
import { TestTime } from '../../live-agents/test/support/world.ts';
import { buildProposal } from '../../live-agents/src/mandate/proposal-builder.ts';
import { createAgentSigners } from '../../live-agents/src/mandate/signer.ts';
import {
  mandateSigningHash,
  portfolioMandateDigest,
  reserveChild,
  screenProposal,
  type ActionCandidate,
  type SignedProposal,
} from '@mandate/portfolio';
import {
  demoKey,
  demoParty,
  signPrehash,
  STOCK_LOOKALIKE,
  UNKNOWN_ROUTER,
} from '@mandate/portfolio/demo';
import { authorizationFor, proposal, world } from '../../portfolio/test/support/world.ts';
import { NOW, perpOpen, stockBuy, swap } from '../../portfolio/test/support/candidates.ts';
import { createMandateClient } from '../src/index.ts';
import { handleAgentProposal } from '../src/examples/agent-integration.ts';

async function portfolioClient() {
  const w = await world();
  const client = createMandateClient({
    principal: w.m.principal.value,
    chainId: 1,
    now: () => NOW,
    bindings: w.compiled.bindings,
  });
  client.attachAuthority({
    mandate: w.m,
    signature: signPrehash(mandateSigningHash(portfolioMandateDigest(w.m)), demoKey('principal')),
    core: w.core,
    bindings: w.compiled.bindings,
  });
  return { w, client };
}

async function liveLabClient() {
  const time = new TestTime();
  const session = new LiveSession({
    provider: new StubProvider(0),
    clock: new ManualClock(),
    sessionId: 'sdk-reserve',
    agentTimeoutMs: 1_000,
    roomRoundTimeoutMs: 1_000,
    protocolNow: time.read,
    entropy: new CountingEntropy(3n),
  });
  const auth = await session.authorize(presetDraft('balanced'), 'AUTHORIZE MANDATE V1');
  assert.equal(auth.ok, true);
  const active = session.versions.active;
  assert.ok(active !== null);
  const client = createMandateClient({
    principal: active.mandate.principal.value,
    chainId: 1,
    now: () => time.now,
    bindings: active.core.compiled.bindings,
    session,
  });
  client.attachAuthority({
    mandate: active.mandate,
    signature: active.signature,
    core: active.core,
    bindings: active.core.compiled.bindings,
  });
  return { session, client, active, time };
}

describe('sdk screen', () => {
  it('valid proposal result matches direct screenProposal', async () => {
    const { w, client } = await portfolioClient();
    const signed = proposal(w.m, 'stock', stockBuy());
    const direct = screenProposal(w.m, w.compiled.bindings, signed, NOW);
    const viaSdk = await client.screen({ proposal: signed });
    assert.equal(viaSdk.authorized, true);
    assert.ok(direct.child !== null);
    assert.deepEqual(viaSdk.reasons, direct.reasons);
    assert.deepEqual(viaSdk.screening.reasons, direct.reasons);
  });

  it('refusal reasons match the direct path (venue + representation)', async () => {
    const { w, client } = await portfolioClient();
    const cases: readonly { readonly role: string; readonly candidate: ActionCandidate }[] = [
      { role: 'swap', candidate: swap({ router: UNKNOWN_ROUTER }) },
      { role: 'stock', candidate: stockBuy({ representation: STOCK_LOOKALIKE }) },
    ];
    for (const c of cases) {
      const signed = proposal(w.m, c.role, c.candidate);
      const direct = screenProposal(w.m, w.compiled.bindings, signed, NOW);
      const viaSdk = await client.screen({ proposal: signed });
      assert.equal(viaSdk.authorized, false);
      assert.deepEqual(
        viaSdk.reasons.map((r) => r.code).sort(),
        direct.reasons.map((r) => r.code).sort(),
      );
    }
  });

  it('unknown agent refuses with matching codes', async () => {
    const { w, client } = await portfolioClient();
    const signed = proposal(w.m, 'stock', stockBuy());
    const bad = {
      proposal: {
        ...signed.proposal,
        agent: demoParty('unknown-agent'),
      },
      signature: signed.signature,
    } as SignedProposal;
    const viaSdk = await client.screen({ proposal: bad });
    const direct = screenProposal(w.m, w.compiled.bindings, bad, NOW);
    assert.equal(viaSdk.authorized, false);
    assert.deepEqual(
      viaSdk.reasons.map((r) => r.code).sort(),
      direct.reasons.map((r) => r.code).sort(),
    );
  });

  it('over-limit refuses with matching codes', async () => {
    const { w, client } = await portfolioClient();
    const signed = proposal(w.m, 'perps', perpOpen({ usdc: 10_000n }));
    const direct = screenProposal(w.m, w.compiled.bindings, signed, NOW);
    const viaSdk = await client.screen({ proposal: signed });
    assert.equal(viaSdk.authorized, direct.child !== null && direct.reasons.length === 0);
    assert.deepEqual(
      viaSdk.reasons.map((r) => r.code).sort(),
      direct.reasons.map((r) => r.code).sort(),
    );
    assert.equal(viaSdk.authorized, false);
  });

  it('expired mandate window refuses', async () => {
    const { w, client } = await portfolioClient();
    const signed = proposal(w.m, 'stock', stockBuy());
    const expired = w.m.expiresAt;
    const direct = screenProposal(w.m, w.compiled.bindings, signed, expired);
    const viaSdk = await client.screen({ proposal: signed, now: expired });
    assert.equal(viaSdk.authorized, false);
    assert.deepEqual(
      viaSdk.reasons.map((r) => r.code).sort(),
      direct.reasons.map((r) => r.code).sort(),
    );
  });

  it('example handleAgentProposal refuses unauthorized venue', async () => {
    const { client } = await portfolioClient();
    const w = await world();
    const signed = proposal(w.m, 'swap', swap({ router: UNKNOWN_ROUTER }));
    // Re-bind to the world that signed the proposal digest.
    client.attachAuthority({
      mandate: w.m,
      signature: signPrehash(mandateSigningHash(portfolioMandateDigest(w.m)), demoKey('principal')),
      core: w.core,
      bindings: w.compiled.bindings,
    });
    const result = await handleAgentProposal(client, signed);
    assert.equal(result.status, 'REFUSED');
    if (result.status === 'REFUSED') assert.ok(result.reasons.includes('VENUE_NOT_ALLOWED'));
  });
});

describe('sdk reserve', () => {
  it('underlying ledger replay refuses; SDK cannot reserve a refused decision', async () => {
    const w = await world();
    const auth = authorizationFor(w.m, 'stock', stockBuy());
    const first = await reserveChild(w.core, auth.transcript, auth.verified.digest, NOW);
    assert.equal(first.status, 'RESERVED');
    const replay = await reserveChild(w.core, auth.transcript, auth.verified.digest, NOW + 1n);
    assert.equal(replay.status, 'REFUSED');

    const { client } = await portfolioClient();
    const signed = proposal(w.m, 'swap', swap({ router: UNKNOWN_ROUTER }));
    const decision = await client.screen({ proposal: signed });
    assert.equal(decision.authorized, false);
    const reserved = await client.reserve(decision);
    assert.equal(reserved.ok, false);
    assert.equal(reserved.broadcasts, 0);
    if (!reserved.ok) assert.equal(reserved.code, 'SDK:REFUSED_DECISION');
  });

  it('live-lab single proposal reserves via SDK (preferred empty)', async () => {
    const { client, active, time } = await liveLabClient();
    const signers = createAgentSigners();
    const stockSigner = signers.get('stock');
    assert.ok(stockSigner !== undefined);
    const trusted = DOMAIN_AGENTS.stock.candidates[0];
    assert.ok(trusted !== undefined);
    const built = buildProposal({
      mandate: active.mandate,
      bindings: active.core.compiled.bindings,
      agent: stockSigner.party,
      candidate: trusted.build(100_000_000n, time.now),
      sizeAtoms: 100_000_000n,
      minimumAtoms: 100_000_000n,
      sequence: 1n,
      now: time.now,
    });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const signed = stockSigner.sign(built.proposal);
    const decision = await client.screen({ proposal: signed, now: time.now });
    assert.equal(decision.authorized, true, JSON.stringify(decision.reasons));
    const reserved = await client.reserve(decision);
    assert.equal(reserved.ok, true, JSON.stringify(reserved));
    if (!reserved.ok) return;
    assert.equal(reserved.broadcasts, 0);
    assert.match(reserved.reservationId, /^0x[0-9a-f]+$/i);

    const again = await client.reserve(decision);
    assert.equal(again.ok, false);
  });
});
