/**
 * VALID AGENT ≠ VALID ACTION.
 *
 * Every agent here holds its real key and its real delegation. Each tries to
 * do something its authority does not cover — substitute a representation,
 * a recipient, an amount, or the candidate itself after approval — first
 * through the portfolio, then by going around it straight to Core. The first
 * layer refuses before any key or transaction; Core refuses whatever reaches
 * it; and a mutation after signing is refused by the gate itself.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from '@mandate/kernel';
import { encodeGateCandidate, encodeGateMandate, executionCommitment, gateRevertData, type GateAttempt } from '@mandate/execution-gate';
import { LocalAgentSigner, buildGateArtifact, executeCalldata, gateAdapterRef, type GateArtifact } from '@mandate/evm-robinhood';
import {
  candidateDigest,
  checkBeforeSign,
  childAuthorizationDigest,
  childExecutionAuthorizationInputOf,
  compileAction,
  executeFixtureChild,
  fullAvailability,
  portfolioMandateDigest,
  releaseDigest,
  requestFor,
  reserveChild,
  runMandateRoom,
  validateChildExecutionAuthorization,
  verifyPortfolio,
  type ActionCandidate,
  type AgentMessage,
  type AllocationOp,
  type ChildExecutionAuthorization,
  type SignedProposal,
} from '../src/index.ts';
import { DEMO_DOMAIN_SEPARATOR, DEMO_GATE_CODEHASH, DEMO_GATE_CONFIG, PRINCIPAL, STOCK_COUNTERFEIT, STOCK_LOOKALIKE, USDC, demoBindings, demoKey, demoMandate, demoParty } from '../src/demo/index.ts';
import { NOW, nftBuy, perpOpen, stockBuy, swap, yieldDeposit } from './support/candidates.ts';
import { gateWorld, type GateWorld } from './support/gate.ts';
import { ScriptedAgent, authorizationFor, childFor, principalSignature, proposal, release, world, type World } from './support/world.ts';

const m = demoMandate();
const propose = (signed: SignedProposal): AgentMessage => ({ kind: 'PROPOSE', signed });
const roomSays = (role: string, signed: SignedProposal) => {
  const o = runMandateRoom({ mandate: m, signature: principalSignature(m), bindings: demoBindings(), availability: fullAvailability(m), now: NOW, agents: [new ScriptedAgent(role, [[1, propose(signed)]])] });
  const d = o.decisions[0];
  return { outcome: d?.outcome, codes: [...new Set(d?.reasons.map((r) => r.code))].sort() };
};

/** A candidate each agent could legitimately have been authorized for. */
const BASELINE: { readonly [role: string]: () => ActionCandidate } = { stock: () => stockBuy(), swap: () => swap(), perps: () => perpOpen({ usdc: 400n }) };

/**
 * Going around the portfolio: the agent takes a child it could have been
 * given, re-points it at the candidate it actually wants — never verified —
 * compiles that into a Core action under its own delegation and asks the
 * control engine directly.
 */
async function bypass(w: World, role: string, candidate: ActionCandidate): Promise<string> {
  const honest = childFor(w.m, role, (BASELINE[role] as () => ActionCandidate)());
  const forged = validateChildExecutionAuthorization({ ...childExecutionAuthorizationInputOf(honest), candidate: candidateDigest(candidate) });
  assert.ok(forged.ok);
  const req = requestFor(w.core, forged.value, candidate, NOW);
  if (!req.ok) return `NOT_COMPILABLE:${req.error.code}`;
  const out = await w.core.engine.authorizeAndReserve(req.value, { maxAttempts: 1 });
  return out.status === 'AUTHORIZED' ? 'AUTHORIZED' : `${out.refusal.code}/${out.refusal.reason}`;
}

describe('the canonical asset and representation hero case', () => {
  it('the agent prefers the cheaper same-ticker token; the room refuses it through the registry and authorizes the approved one', () => {
    assert.deepEqual(roomSays('stock', proposal(m, 'stock', stockBuy({ representation: STOCK_LOOKALIKE }))), { outcome: 'REJECTED', codes: ['REGISTRY:ISSUER_NOT_ALLOWED', 'REGISTRY:SYNTHETIC_NOT_ALLOWED'] });
    assert.deepEqual(roomSays('stock', proposal(m, 'stock', stockBuy({ representation: STOCK_COUNTERFEIT }))), { outcome: 'REJECTED', codes: ['REGISTRY:REPRESENTATION_UNKNOWN'] });
    // 4.0 × 125.00 = 500: inside the stock agent's preferred allocation.
    assert.deepEqual(roomSays('stock', proposal(m, 'stock', stockBuy({ tenths: 40n }))), { outcome: 'ACCEPTED', codes: [] });
  });

  it('around the portfolio, Core refuses the look-alike and the counterfeit too: no reviewed market, no covered market', async () => {
    const w = await world();
    for (const rep of [STOCK_LOOKALIKE, STOCK_COUNTERFEIT]) {
      const verdict = await bypass(w, 'stock', stockBuy({ representation: rep }));
      // The binding cannot even express a buy of a token the reviewed gate does not list; nothing reaches the engine.
      assert.equal(verdict, 'NOT_COMPILABLE:INSTRUMENT_UNKNOWN');
    }
    // Hand-built, the engine's own coverage and GateSpotPolicy refuse it.
    const honest = childFor(w.m, 'stock', stockBuy());
    const req = requestFor(w.core, honest, stockBuy(), NOW);
    assert.ok(req.ok);
    const { encodeGateBuy, marketResource, accountResource } = await import('@mandate/evm-robinhood');
    const { actionPayloadDigest, validateActionEnvelope, validateModuleRef, actionEnvelopeInputOf } = await import('@mandate/core');
    const env = req.value.action;
    const lookalikeMarket = marketResource(46_630n, `0x${'a7'.repeat(20)}`);
    const payload = encodeGateBuy({ account: accountResource(46_630n, PRINCIPAL.value), market: lookalikeMarket, quantity: 10n ** 18n });
    const mod = validateModuleRef(actionEnvelopeInputOf(env).module);
    assert.ok(mod.ok);
    const pd = actionPayloadDigest(mod.value, payload);
    assert.ok(pd.ok);
    const forged = validateActionEnvelope({ ...actionEnvelopeInputOf(env), target: lookalikeMarket, payloadDigest: pd.value });
    assert.ok(forged.ok);
    const out = await w.core.engine.authorizeAndReserve({ ...req.value, action: forged.value, payload }, { maxAttempts: 1 });
    assert.equal(out.status, 'REFUSED');
    assert.ok(out.status === 'REFUSED' && ['MARKET_NOT_REVIEWED', 'MARKETS_NOT_PERMITTED'].includes(out.refusal.reason), out.status === 'REFUSED' ? out.refusal.reason : '');
  });
});

describe('malicious authorized agents', () => {
  it('A — the stock agent substitutes the representation after approval: the child binds its candidate, and nothing is reserved', async () => {
    const w = await world();
    const authorization = authorizationFor(w.m, 'stock', stockBuy());
    const forged = validateChildExecutionAuthorization({ ...childExecutionAuthorizationInputOf(authorization.verified.child), candidate: candidateDigest(stockBuy({ representation: STOCK_LOOKALIKE })) });
    assert.ok(forged.ok);
    const r = await reserveChild(w.core, authorization.transcript, childAuthorizationDigest(forged.value), NOW);
    assert.ok(r.status === 'REFUSED' && r.reasons.some((x) => x.code === 'CHILD_AUTHORIZATION_UNKNOWN'));
    const snap = await w.core.engine.read(w.m.principal);
    assert.equal(snap.state.reservations.size, 0);
  });

  it('B — the swap agent substitutes the recipient: refused in the room with a valid signature, and by Core around it', async () => {
    const thief = 'eip155:421614/account:0x9999999999999999999999999999999999999999';
    assert.deepEqual(roomSays('swap', proposal(m, 'swap', swap({ recipient: thief }))), { outcome: 'REJECTED', codes: ['RECIPIENT_NOT_ALLOWED'] });
    const w = await world();
    const verdict = await bypass(w, 'swap', swap({ recipient: thief }));
    assert.match(verdict, /^(ACTION_INVALID|ACTION_NOT_COVERED)\//);
  });

  it('C — the swap agent asks beyond its child authority: asked to reduce in the room; around it, the ledger refuses its own leg', async () => {
    assert.deepEqual(roomSays('swap', proposal(m, 'swap', swap({ amount: USDC(600n) }), { minimum: false })), { outcome: 'REDUCE_REQUESTED', codes: ['AGENT_LIMIT_EXCEEDED'] });
    const w = await world();
    assert.equal(await bypass(w, 'swap', swap({ amount: USDC(600n) })), 'AUTHORITY_UNAVAILABLE/LEDGER_LIMIT_EXCEEDED');
    // The perps agent beyond its 600 hard maximum is refused the same way, whatever the portfolio-wide room.
    assert.deepEqual(roomSays('perps', proposal(m, 'perps', perpOpen({ usdc: 700n }), { minimum: false })).codes, ['AGENT_LIMIT_EXCEEDED', 'PORTFOLIO_LIMIT_EXCEEDED']);
  });

  it('D — a candidate changed after authorization is refused before any key: the action no longer compiles to the child', async () => {
    const w = await world();
    const candidate = swap();
    const authorization = authorizationFor(w.m, 'swap', candidate);
    const child = authorization.verified.child;
    const r = await reserveChild(w.core, authorization.transcript, authorization.verified.digest, NOW);
    assert.ok(r.status === 'RESERVED');
    const issued = await executeFixtureChild(w.core, authorization.transcript, child, candidate, r.record, NOW + 5n);
    assert.ok(issued.ok);
    const snap = await w.core.engine.read(w.m.principal);
    const reasons = checkBeforeSign(w.core, authorization.transcript, { agent: child.agent, child, candidate: swap({ amount: USDC(301n) }), reservation: r.record.reservation, action: r.record.actionId, generation: r.record.generation, authorization: r.record.executionId, attempt: issued.value.attempt.attempt, at: NOW + 5n }, snap.state);
    assert.ok(reasons.some((x) => x.code === 'CHILD_ACTION_MUTATED'), JSON.stringify(reasons));
  });
});

// --- The ONCHAIN_DEFENSE_TEST: the stock child through the real signer, against the gate's reference model ---

const rev = (name: string) => gateRevertData({ error: name as never, args: [] });

function artifactOf(a: GateAttempt): GateArtifact {
  const art = buildGateArtifact(
    { executionId: `0x${'01'.repeat(32)}` as never, authorizationId: a.candidate.evaluationStateDigest as never, reservation: `0x${'02'.repeat(32)}` as never, generation: 1n as never, adapter: gateAdapterRef({ gate: DEMO_GATE_CONFIG, gateCodehash: DEMO_GATE_CODEHASH, domainSeparator: DEMO_DOMAIN_SEPARATOR }), evaluatedAt: a.mandate.createdAtUnixSeconds, validUntil: a.mandate.expiresAtUnixSeconds },
    { gate: DEMO_GATE_CONFIG, market: DEMO_GATE_CONFIG.markets[0] as never, principal: PRINCIPAL.value, agent: demoParty('stock').value, quantity: a.candidate.quantity.atoms, nonce: a.mandate.nonce, deadline: a.terms.deadline },
  );
  const mandateDigest = keccak256(encodeGateMandate(a.mandate));
  const candidateDigest = keccak256(encodeGateCandidate(a.candidate));
  return { ...art, mandate: a.mandate, candidate: a.candidate, terms: a.terms, mandateDigest, candidateDigest, commitment: executionCommitment({ mandateDigest, candidateDigest, terms: a.terms }) };
}

/** The (compromised) stock agent key re-signs a mutated attempt; the principal's signed mandate is unchanged. */
function resign(a: GateAttempt): GateAttempt {
  const sig = new LocalAgentSigner(demoKey('stock')).signExecution(artifactOf(a));
  assert.ok(sig.ok);
  return { ...a, agentSignature: sig.ok ? sig.value : '' };
}

const mine = (g: GateWorld, a: GateAttempt) => g.chain.mine({ calldata: executeCalldata(a.mandate, a.principalSignature, a.candidate, a.terms, a.agentSignature), attempt: a });

async function issuedStock(g: GateWorld, verify = true): Promise<{ attempt: GateAttempt; child: ChildExecutionAuthorization }> {
  const candidate = stockBuy({ tenths: 48n });
  const authorization = authorizationFor(g.core.compiled.mandate, 'stock', candidate);
  const child = authorization.verified.child;
  const r = await reserveChild(g.core, authorization.transcript, authorization.verified.digest, NOW);
  assert.ok(r.status === 'RESERVED');
  const transcript = verify ? authorization.transcript : { ...authorization.transcript, candidate: { ...authorization.transcript.candidate, accepted: [] } };
  g.children.set(r.record.reservation, { child, candidate, record: r.record, transcript });
  const compiled = compileAction(g.core.compiled, child, candidate);
  assert.ok(compiled.ok);
  const at = NOW + 5n;
  const out = await g.signer.issueAuthorizedBuy(r.record, { payload: compiled.value.payload, states: g.binding.states(candidate, at), context: { evaluationTime: at, sources: [...g.binding.sources()], blockHeads: [], sequenceWatermarks: [] } });
  if (!verify) {
    assert.equal(out.status, 'REFUSED');
    return { attempt: null as never, child };
  }
  assert.equal(out.status, 'ISSUED', JSON.stringify(out, (_, v: bigint | string) => (typeof v === 'bigint' ? v.toString() : v)));
  const tx = g.chain.txs[0];
  assert.ok(tx !== undefined);
  return { attempt: tx.call.attempt, child };
}

describe('Phase 7F.1 hostile five-agent boundary', () => {
  it('preserves legitimate reservations while stale swap, custody bypass and release replay use no key and send no transaction', async () => {
    const g = await gateWorld();
    try {
      const cases = [
        ['stock', stockBuy({ tenths: 48n })],
        ['swap', swap({ amount: USDC(300n) })],
        ['nft', nftBuy({ price: USDC(250n) })],
        ['yield', yieldDeposit({ amount: USDC(450n) })],
        ['perps', perpOpen({ usdc: 400n })],
      ] as const;
      const reserved = new Map<string, { authorization: ReturnType<typeof authorizationFor>; record: import('@mandate/control').AuthorizationRecord; candidate: ActionCandidate }>();
      for (const [role, candidate] of cases) {
        const authorization = authorizationFor(g.core.compiled.mandate, role, candidate);
        const out = await reserveChild(g.core, authorization.transcript, authorization.verified.digest, NOW);
        assert.equal(out.status, 'RESERVED', role);
        assert.ok(out.status === 'RESERVED');
        reserved.set(role, { authorization, record: out.record, candidate });
      }
      const before = await g.core.engine.read(g.core.compiled.mandate.principal);
      assert.equal(before.state.reservations.size, 5);

      const swapAuthorization = reserved.get('swap') as NonNullable<ReturnType<typeof reserved.get>>;
      const staleCandidate = swap({ minOut: 0n, observedAt: NOW - 10_000n });
      const rebound = validateChildExecutionAuthorization({ ...childExecutionAuthorizationInputOf(swapAuthorization.authorization.verified.child), candidate: candidateDigest(staleCandidate) });
      assert.ok(rebound.ok);
      assert.equal((await reserveChild(g.core, swapAuthorization.authorization.transcript, childAuthorizationDigest(rebound.value), NOW)).status, 'REFUSED');

      const mandate = g.core.compiled.mandate;
      const a = release(mandate, 'nft', [['portfolio-notional', 10n]], 9n);
      const b = release(mandate, 'nft', [['portfolio-notional', 5n]], 9n);
      const allocationLog: AllocationOp[] = [a, b].map((signed) => ({ kind: 'RELEASE', agent: signed.release.agent, id: `release/${releaseDigest(signed.release)}` as never, amounts: signed.release.amounts }));
      const replay = verifyPortfolio({ mandate, signature: principalSignature(mandate), bindings: demoBindings(), availability: fullAvailability(mandate), now: NOW, candidate: { portfolioMandate: portfolioMandateDigest(mandate), accepted: [], allocationLog }, proposals: [], releases: [a, b] });
      assert.ok(replay.status === 'REFUSED' && replay.reasons.some((r) => r.code === 'RELEASE_SEQUENCE_INVALID'));

      const stock = reserved.get('stock') as NonNullable<ReturnType<typeof reserved.get>>;
      const badTranscript = { ...stock.authorization.transcript, candidate: { ...stock.authorization.transcript.candidate, accepted: [] } };
      g.children.set(stock.record.reservation, { child: stock.authorization.verified.child, candidate: stock.candidate, record: stock.record, transcript: badTranscript });
      const compiled = compileAction(g.core.compiled, stock.authorization.verified.child, stock.candidate);
      assert.ok(compiled.ok);
      const outcome = await g.signer.issueAuthorizedBuy(stock.record, { payload: compiled.value.payload, states: g.binding.states(stock.candidate, NOW + 5n), context: { evaluationTime: NOW + 5n, sources: [...g.binding.sources()], blockHeads: [], sequenceWatermarks: [] } });
      assert.equal(outcome.status, 'REFUSED');
      assert.equal(g.keyUses(), 0);
      assert.equal(g.chain.txs.length, 0);
      const after = await g.core.engine.read(mandate.principal);
      assert.equal(after.state.reservations.size, 5);
    } finally {
      g.close();
    }
  });
});

describe('ONCHAIN_DEFENSE_TEST (SIMULATED against the Phase 6 reference model; no transaction sent)', () => {
  it('the verified stock child executes exactly: 4.8 tokens for 600 USDC, into the principal', async () => {
    const g = await gateWorld();
    try {
      const { attempt } = await issuedStock(g);
      assert.equal(g.chain.txs[0]?.result, 'SUCCESS');
      assert.equal(attempt.candidate.quantity.atoms, 48n * 10n ** 17n);
      assert.equal(attempt.terms.fundingLimit, USDC(600n));
      assert.equal(attempt.terms.recipient, PRINCIPAL.value);
    } finally {
      g.close();
    }
  });

  it('amount or recipient changed after signing: AgentSignatureInvalid; re-signed by a compromised agent key: MaxNotionalExceeded, RecipientNotPrincipal', async () => {
    const g = await gateWorld();
    try {
      const { attempt: a } = await issuedStock(g);
      g.chain.consumed.clear(); // judge each mutation alone, not the replay key
      const more = { ...a, candidate: { ...a.candidate, quantity: { ...a.candidate.quantity, atoms: a.candidate.quantity.atoms + 1n } } };
      assert.equal(mine(g, more).revert, rev('AgentSignatureInvalid'));
      const thief = '0x000000000000000000000000000000000000beef';
      assert.equal(mine(g, { ...a, terms: { ...a.terms, recipient: thief } }).revert, rev('AgentSignatureInvalid'));
      const bigger = resign({ ...a, candidate: { ...a.candidate, quantity: { ...a.candidate.quantity, atoms: 64n * 10n ** 17n }, notional: { ...a.candidate.notional, atoms: USDC(800n) } } });
      assert.equal(mine(g, bigger).revert, rev('MaxNotionalExceeded'));
      assert.equal(mine(g, resign({ ...a, terms: { ...a.terms, recipient: thief } })).revert, rev('RecipientNotPrincipal'));
    } finally {
      g.close();
    }
  });

  it('replay: the byte-identical executed call, re-broadcast, reverts MandateAlreadyConsumed; a second issuance request gets the existing attempt', async () => {
    const g = await gateWorld();
    try {
      const { attempt } = await issuedStock(g);
      assert.equal(mine(g, attempt).revert, rev('MandateAlreadyConsumed'));
      assert.equal(g.chain.txs.filter((t) => t.result === 'SUCCESS').length, 1);
    } finally {
      g.close();
    }
  });

  it('a stock reservation the portfolio never verified reaches the signer but never the principal’s key: nothing is signed or sent', async () => {
    const g = await gateWorld();
    try {
      await issuedStock(g, false);
      assert.equal(g.chain.txs.length, 0);
      assert.equal(g.keyUses(), 0);
    } finally {
      g.close();
    }
  });
});
