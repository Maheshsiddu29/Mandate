/**
 * EVM enforcement through the Robinhood gate signer, offline: the real
 * control engine and SQLite ledger, the real custody check, and a chain that
 * executes every call through the Phase 6 reference model — the model the
 * differential corpus proves byte-equal in its decisions to the Solidity gate.
 *
 * Every refusal is asserted with the gate's own revert data, so a test that
 * passes here names the exact check that stopped the execution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGateCandidate, encodeGateMandate, encodeRevert, errorSignature, executionCommitment, gateRevertData, type GateAttempt } from '@mandate/execution-gate';
import { keccak256 } from '@mandate/kernel';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { adapterRefsEqual } from '@mandate/core';
import {
  ARTIFACT_KIND,
  GateSigner,
  LocalAgentSigner,
  LocalGateCustody,
  buildGateArtifact,
  executeCalldata,
  gateAdapterRef,
  gateMandateId,
  representationIdOf,
  slotScope,
  verifyAdmitted,
  type ArtifactTerms,
  type GateArtifact,
} from '../src/index.ts';
import { agentSigningHash, principalSigningHash } from '../src/gate.ts';
import {
  ADAPTER_CONFIG,
  AGENT,
  AGENT_KEY,
  CHAIN,
  GATE,
  MARKET,
  MDEMO,
  MDUSD,
  ONCE,
  OTHER_TOKEN,
  PRINCIPAL,
  PRINCIPAL_ID,
  PRINCIPAL_KEY,
  ModelChain,
  REVIEWED,
  STRANGER_KEY,
  T,
  authorizeBuy,
  context,
  marketStates,
  mdemo,
  mdusd,
  withWorld,
  type GateWorld,
} from './support/world.ts';

const rev = (name: string, ...args: bigint[]) => gateRevertData({ error: name as never, args });
const addr = (a: string) => a.toLowerCase();

/** The attempt the signer submitted for `txIndex`. */
function submitted(w: GateWorld, i = 0): GateAttempt {
  const tx = w.chain.txs[i];
  assert.ok(tx !== undefined, 'a transaction was submitted');
  return tx.call.attempt;
}

/** Re-submit a (possibly altered) attempt straight to the chain, as anyone may. */
function mine(w: GateWorld, attempt: GateAttempt) {
  return w.chain.mine({ calldata: executeCalldata(attempt.mandate, attempt.principalSignature, attempt.candidate, attempt.terms, attempt.agentSignature), attempt });
}

/** An attempt re-signed by the (compromised) agent key after mutation: the agent's signature is valid, the principal's mandate is unchanged. */
function agentResign(_w: GateWorld, a: GateAttempt, change: (x: GateAttempt) => GateAttempt): GateAttempt {
  const m = change(a);
  const artifact = buildArtifactFrom(m);
  const sig = new LocalAgentSigner(AGENT_KEY).signExecution(artifact);
  assert.ok(sig.ok);
  return { ...m, agentSignature: sig.ok ? sig.value : '' };
}

function buildArtifactFrom(a: GateAttempt): GateArtifact {
  // The digests and commitment of an arbitrary attempt, under the reviewed gate's domain.
  const art = buildGateArtifact(
    { executionId: '0x' + '01'.repeat(32) as never, authorizationId: a.candidate.evaluationStateDigest as never, reservation: '0x' + '02'.repeat(32) as never, generation: 1n as never, adapter: gateAdapterRef(ADAPTER_CONFIG), evaluatedAt: a.mandate.createdAtUnixSeconds, validUntil: a.mandate.expiresAtUnixSeconds },
    { gate: REVIEWED, market: MARKET, principal: PRINCIPAL, agent: AGENT, quantity: a.candidate.quantity.atoms, nonce: a.mandate.nonce, deadline: a.terms.deadline },
  );
  const mandateDigest = keccak256(encodeGateMandate(a.mandate));
  const candidateDigest = keccak256(encodeGateCandidate(a.candidate));
  return { ...art, mandate: a.mandate, candidate: a.candidate, terms: a.terms, mandateDigest, candidateDigest, commitment: executionCommitment({ mandateDigest, candidateDigest, terms: a.terms }) };
}

async function executed(w: GateWorld, quantity = mdemo(30n)) {
  const { rec, a, issue } = await authorizeBuy(w, quantity);
  const out = await w.signer.issueAuthorizedBuy(rec, issue);
  assert.equal(out.status, 'ISSUED', JSON.stringify(out, (_, v: bigint | string) => (typeof v === 'bigint' ? v.toString() : v)));
  return { rec, a, issue, out };
}

describe('successful exact execution', () => {
  it('settles exactly the authorized quantity for exactly the reserved capital, into the principal, and records the commitment', () =>
    withWorld(async (w) => {
      const { rec, out } = await executed(w);
      if (out.status !== 'ISSUED') return;
      assert.equal(out.issuance, 'SUBMISSION_ACKNOWLEDGED');
      assert.equal(out.detail, 'MINED_SUCCESS');
      const at = submitted(w);
      // Exact binding, field by field.
      assert.equal(at.candidate.representationId, representationIdOf(CHAIN, MDEMO));
      assert.equal(at.candidate.quantity.atoms, mdemo(30n));
      assert.equal(at.terms.recipient, PRINCIPAL);
      assert.equal(at.terms.fundingLimit, mdusd(300n));
      assert.equal(at.mandate.economicLimit.atoms, mdusd(300n));
      assert.equal(at.mandate.maxNotional.atoms, mdusd(300n));
      assert.equal(at.terms.executionData, '0x');
      assert.equal(at.mandate.expiresAtUnixSeconds, rec.validUntil);
      assert.ok(at.terms.deadline < rec.validUntil);
      assert.equal(at.mandate.mandateId, gateMandateId({ executionId: rec.executionId, reservation: rec.reservation, generation: rec.generation, adapter: rec.adapter }));
      assert.equal(at.candidate.evaluationStateDigest, rec.id);
      // Onchain effect: 300 MDUSD out, 30 MDEMO in, the replay key holds the agent-signed commitment.
      assert.equal(w.chain.balanceOf(MDUSD, PRINCIPAL), mdusd(700n));
      assert.equal(w.chain.balanceOf(MDEMO, PRINCIPAL), mdemo(30n));
      assert.equal(w.chain.consumed.get(out.mandateDigest), out.commitment);
      // The ledger holds exactly one ADMIT_ATTEMPT naming that commitment, in the principal's gate slot 1.
      const attempt = w.store.readCommitted(PRINCIPAL_ID).state.attempts.get(out.attempt);
      assert.equal(attempt?.artifact.kind, ARTIFACT_KIND);
      assert.equal(`0x${Buffer.from(attempt?.artifact.id ?? []).toString('hex')}`, out.commitment);
      assert.deepEqual(attempt?.slot, { scope: slotScope(CHAIN, GATE, PRINCIPAL), sequence: 1n });
      // What the agent received carries no signature and no calldata.
      assert.deepEqual(Object.keys(out).sort(), ['attempt', 'blockNumber', 'commitment', 'detail', 'gasUsed', 'issuance', 'mandateDigest', 'status', 'txHash']);
      assert.equal(JSON.stringify(out, (_, v: bigint | string) => (typeof v === 'bigint' ? v.toString() : v)).includes(at.principalSignature.slice(2, 40)), false);
    }));

  it('ADMIT_ATTEMPT is durable before the principal key is used', () =>
    withWorld(async (w) => {
      const { rec, issue } = await authorizeBuy(w, mdemo(30n));
      let seen: boolean | null = null;
      const custody = w.deps.custody;
      const probe = { principal: () => custody.principal(), signMandate: (a: GateArtifact, t: ArtifactTerms, c: Parameters<typeof custody.signMandate>[2]) => { seen = w.store.readCommitted(PRINCIPAL_ID).state.attempts.has(c.attempt); return custody.signMandate(a, t, c); } };
      const signer = new GateSigner({ ...w.deps, custody: probe });
      const out = await signer.issueAuthorizedBuy(rec, issue);
      assert.equal(out.status, 'ISSUED');
      assert.equal(seen, true);
    }));
});

describe('replay', () => {
  it('the same authorization is never issued twice: a second request refers to the existing attempt', () =>
    withWorld(async (w) => {
      const { rec, issue, out } = await executed(w);
      const again = await w.signer.issueAuthorizedBuy(rec, issue);
      assert.equal(again.status, 'EXISTING');
      if (again.status === 'EXISTING' && out.status === 'ISSUED') assert.equal(again.attempt, out.attempt);
      assert.equal(w.chain.txs.length, 1);
    }));

  it('the byte-identical executed call, re-broadcast, reverts MandateAlreadyConsumed and moves nothing', () =>
    withWorld(async (w) => {
      await executed(w);
      const before = [w.chain.balanceOf(MDUSD, PRINCIPAL), w.chain.balanceOf(MDEMO, PRINCIPAL)];
      const replay = mine(w, submitted(w));
      assert.equal(replay.result, 'REVERTED');
      assert.equal(replay.revert, rev('MandateAlreadyConsumed'));
      assert.deepEqual([w.chain.balanceOf(MDUSD, PRINCIPAL), w.chain.balanceOf(MDEMO, PRINCIPAL)], before);
    }));

  it('100 concurrent issuance calls for one generation: one ADMIT_ATTEMPT, one signature, one transaction', () =>
    withWorld(async (w) => {
      const { rec, issue } = await authorizeBuy(w, mdemo(30n));
      const outs = await Promise.all(Array.from({ length: 100 }, () => w.signer.issueAuthorizedBuy(rec, issue)));
      assert.equal(outs.filter((o) => o.status === 'ISSUED').length, 1);
      assert.equal(outs.filter((o) => o.status === 'EXISTING').length, 99);
      assert.equal(w.chain.txs.length, 1);
      assert.equal([...w.store.readCommitted(PRINCIPAL_ID).state.attempts.values()].length, 1);
    }));
});

describe('mutation: the authorized amount, recipient and target cannot be changed', () => {
  it('amount N+1 with the original signatures: AgentSignatureInvalid', () =>
    withWorld(async (w) => {
      await executed(w);
      const a = submitted(w);
      w.chain.consumed.clear(); // judge the mutation alone, not the replay key
      const tx = mine(w, { ...a, candidate: { ...a.candidate, quantity: { ...a.candidate.quantity, atoms: a.candidate.quantity.atoms + 1n } } });
      assert.equal(tx.revert, rev('AgentSignatureInvalid'));
    }));

  it('amount N+1 re-signed by a compromised agent key: the principal-signed bound refuses it (MaxNotionalExceeded)', () =>
    withWorld(async (w) => {
      await executed(w);
      w.chain.consumed.clear();
      const bigger = agentResign(w, submitted(w), (x) => ({
        ...x,
        candidate: { ...x.candidate, quantity: { ...x.candidate.quantity, atoms: mdemo(31n) }, notional: { ...x.candidate.notional, atoms: mdusd(310n) } },
      }));
      assert.equal(mine(w, bigger).revert, rev('MaxNotionalExceeded'));
      const pricier = agentResign(w, submitted(w), (x) => ({ ...x, terms: { ...x.terms, fundingLimit: mdusd(301n) } }));
      assert.equal(mine(w, pricier).revert, encodeRevert(errorSignature('FundingLimitExceedsMandate', ['uint256', 'uint256']), [mdusd(301n), mdusd(300n)]));
    }));

  it('recipient R2: AgentSignatureInvalid with the original signatures, RecipientNotPrincipal when re-signed', () =>
    withWorld(async (w) => {
      await executed(w);
      w.chain.consumed.clear();
      const r2 = '0x000000000000000000000000000000000000beef';
      assert.equal(mine(w, { ...submitted(w), terms: { ...submitted(w).terms, recipient: r2 } }).revert, rev('AgentSignatureInvalid'));
      assert.equal(mine(w, agentResign(w, submitted(w), (x) => ({ ...x, terms: { ...x.terms, recipient: r2 } }))).revert, rev('RecipientNotPrincipal'));
    }));

  it('target B / token Y: another representation is unsupported; another gate is another EIP-712 domain', () =>
    withWorld(async (w) => {
      await executed(w);
      w.chain.consumed.clear();
      const tokenY = agentResign(w, submitted(w), (x) => ({ ...x, candidate: { ...x.candidate, representationId: representationIdOf(CHAIN, OTHER_TOKEN) } }));
      assert.equal(mine(w, tokenY).revert, rev('UnsupportedRepresentation'));
      // The same signatures presented to a gate at another address: the principal's domain names this gate.
      const otherGate = { ...REVIEWED, gate: '0x000000000000000000000000000000000000a7e1' };
      const g2 = new ModelChain(w.chain.time, otherGate);
      g2.fund(MDUSD, PRINCIPAL, mdusd(1_000n));
      g2.approve(MDUSD, PRINCIPAL, otherGate.gate, mdusd(1_000n));
      assert.equal(g2.mine({ calldata: executeCalldata(submitted(w).mandate, submitted(w).principalSignature, submitted(w).candidate, submitted(w).terms, submitted(w).agentSignature), attempt: submitted(w) }).revert, rev('PrincipalSignatureInvalid'));
    }));
});

describe('adapter identity', () => {
  it('an authorization made for another adapter is never issued by this one', () =>
    withWorld(async (w) => {
      const { rec, issue } = await authorizeBuy(w, mdemo(30n));
      const otherAdapter = gateAdapterRef({ ...ADAPTER_CONFIG, gateCodehash: `0x${'c1'.repeat(32)}` });
      assert.equal(adapterRefsEqual(otherAdapter, rec.adapter), false);
      const signer = new GateSigner({ ...w.deps, config: { ...w.deps.config, adapter: otherAdapter } });
      const out = await signer.issueAuthorizedBuy(rec, issue);
      assert.deepEqual(out, { status: 'REFUSED', stage: 'RESOLVE', reason: 'ADAPTER_NOT_THIS_SIGNER', attemptAdmitted: false });
      // Control refuses the same substitution on its own.
      const direct = await w.engine.admitAttempt(rec, { revalidation: { payload: issue.payload, states: issue.states, context: issue.context }, adapter: otherAdapter, venueAccount: rec.action.resources[0] as never, artifact: { kind: ARTIFACT_KIND as never, id: new Uint8Array(32).fill(1) }, slot: null, validUntil: T + 60n, requirements: [], results: [] }, ONCE);
      assert.ok(direct.status === 'REFUSED' && direct.refusal.reason === 'ADAPTER_MISMATCH');
      assert.equal(w.chain.txs.length, 0);
    }));

  it('the gate mandate id names the adapter digest: the same reservation under another adapter is another mandate', () =>
    withWorld(async (w) => {
      const { rec } = await authorizeBuy(w, mdemo(30n));
      const base = { executionId: rec.executionId, reservation: rec.reservation, generation: rec.generation };
      assert.notEqual(gateMandateId({ ...base, adapter: rec.adapter }), gateMandateId({ ...base, adapter: gateAdapterRef({ ...ADAPTER_CONFIG, gateCodehash: `0x${'c1'.repeat(32)}` }) }));
    }));

  it('custody refuses to sign for an adapter it does not serve', () =>
    withWorld(async (w) => {
      const { rec, issue } = await authorizeBuy(w, mdemo(30n));
      const otherAdapter = gateAdapterRef({ ...ADAPTER_CONFIG, gateCodehash: `0x${'c1'.repeat(32)}` });
      const custody = new LocalGateCustody(PRINCIPAL_KEY, { ledger: () => w.store.readCommitted(PRINCIPAL_ID).state, issued: () => false, lifecycle: () => ({ status: 'ACTIVE', digest: '' }), now: () => w.chain.time }, { module: w.policy.ref, adapter: otherAdapter });
      const signer = new GateSigner({ ...w.deps, custody });
      const out = await signer.issueAuthorizedBuy(rec, issue);
      assert.deepEqual(out.status === 'REFUSED' ? [out.stage, out.reason, out.attemptAdmitted] : null, ['SIGN', 'CUSTODY.ADAPTER_NOT_SERVED', true]);
      assert.equal(w.chain.txs.length, 0);
    }));
});

describe('expiry', () => {
  it('an authorization past its ceiling is refused before any artifact exists', () =>
    withWorld(async (w) => {
      const { rec, issue } = await authorizeBuy(w, mdemo(30n));
      w.chain.time = rec.validUntil + 1n;
      const out = await w.signer.issueAuthorizedBuy(rec, { ...issue, states: marketStates(w.policy, rec.validUntil + 1n), context: context(rec.validUntil + 1n) });
      assert.equal(out.status, 'REFUSED');
      if (out.status === 'REFUSED') assert.equal(out.attemptAdmitted, false);
      assert.equal(w.chain.txs.length, 0);
    }));

  it('an issued artifact landing after its deadline reverts ExecutionDeadlinePassed; after the mandate ceiling, MandateExpired', () =>
    withWorld(async (w) => {
      w.chain.submitBehaviour = 'UNKNOWN'; // signed, never landed
      const { rec, issue } = await authorizeBuy(w, mdemo(30n));
      await w.signer.issueAuthorizedBuy(rec, issue);
      const j = [...w.journal.list(PRINCIPAL_ID)][0];
      assert.equal(j?.state, 'OUTCOME_UNKNOWN');
      // Rebuild the exact attempt the signer signed from its journal calldata's source: the model chain saw none, so re-derive it.
      const at = w.chain.lastSimulated;
      assert.ok(at !== null);
      if (at === null) return;
      w.chain.time = at.terms.deadline + 1n;
      assert.equal(mine(w, at).revert, rev('ExecutionDeadlinePassed'));
      w.chain.time = at.mandate.expiresAtUnixSeconds;
      assert.equal(mine(w, at).revert, rev('MandateExpired'));
      assert.equal(w.chain.consumed.size, 0);
    }));
});

describe('principal and generation identity', () => {
  it('an authorization of another principal is refused; a mandate signed by any key but the principal’s reverts', () =>
    withWorld(async (w) => {
      const { rec, issue } = await authorizeBuy(w, mdemo(30n));
      const foreign = { ...rec, principal: { kind: 'eip155-address', value: '0x000000000000000000000000000000000000beef' } as never };
      assert.deepEqual(await w.signer.issueAuthorizedBuy(foreign, issue), { status: 'REFUSED', stage: 'RESOLVE', reason: 'PRINCIPAL_NOT_THIS_SIGNER', attemptAdmitted: false });
      await w.signer.issueAuthorizedBuy(rec, issue);
      w.chain.consumed.clear();
      const a = submitted(w);
      const art = buildArtifactFrom(a);
      const forged = new LocalGateCustody(STRANGER_KEY, { ledger: () => w.store.readCommitted(PRINCIPAL_ID).state, issued: () => false, lifecycle: () => null, now: () => 0n }, { module: w.policy.ref, adapter: rec.adapter });
      // The stranger's custody will not even sign (it is not the principal) — so sign the hash directly, as an attacker would.
      assert.equal(forged.signMandate(art, {} as ArtifactTerms, { attempt: '0x' as never, reservation: rec.reservation, generation: rec.generation, action: rec.actionId }).ok, false);
      const s = secp256k1.sign(principalSigningHash(art), Buffer.from(STRANGER_KEY.slice(2), 'hex'), { prehash: false, format: 'recovered' });
      const sig = `0x${Buffer.from([...s.subarray(1), (s[0] as number) + 27]).toString('hex')}`;
      assert.equal(mine(w, { ...a, principalSignature: sig }).revert, rev('PrincipalSignatureInvalid'));
    }));

  it('custody refuses a claim naming another generation; a generation-1 mandate cannot be read as generation 2', () =>
    withWorld(async (w) => {
      const { rec, issue } = await authorizeBuy(w, mdemo(30n));
      await w.signer.issueAuthorizedBuy(rec, issue);
      const state = w.store.readCommitted(PRINCIPAL_ID).state;
      const attempt = [...state.attempts.values()][0];
      assert.ok(attempt !== undefined);
      if (attempt === undefined) return;
      const a = submitted(w);
      const art = buildArtifactFrom(a);
      const terms: ArtifactTerms = { gate: REVIEWED, market: MARKET, principal: PRINCIPAL, agent: AGENT, quantity: a.candidate.quantity.atoms, nonce: a.mandate.nonce, deadline: a.terms.deadline };
      const view = { ledger: () => w.store.readCommitted(PRINCIPAL_ID).state, issued: () => false, lifecycle: (k: 'MODULE' | 'ADAPTER') => ({ status: 'ACTIVE', digest: k === 'MODULE' ? w.policy.ref.moduleDigest : rec.adapter.adapterDigest }), now: () => w.chain.time };
      assert.equal(verifyAdmitted(view, { module: w.policy.ref, adapter: rec.adapter }, PRINCIPAL, art, terms, { attempt: attempt.attempt, reservation: attempt.reservation, generation: 2n as never, action: attempt.action }), 'RESERVATION_MISMATCH');
      const g1 = gateMandateId({ executionId: rec.executionId, reservation: rec.reservation, generation: rec.generation, adapter: rec.adapter });
      const g2 = gateMandateId({ executionId: rec.executionId, reservation: rec.reservation, generation: 2n as never, adapter: rec.adapter });
      assert.notEqual(g1, g2);
      // And the executed attempt is recorded as issued: custody will not sign it again.
      assert.equal(verifyAdmitted({ ...view, issued: () => true }, { module: w.policy.ref, adapter: rec.adapter }, PRINCIPAL, art, terms, { attempt: attempt.attempt, reservation: attempt.reservation, generation: attempt.generation, action: attempt.action }), 'ATTEMPT_ALREADY_ISSUED');
    }));
});

describe('no unauthorized direct path', () => {
  it('the agent key alone cannot settle: a mandate the agent signs for the principal reverts, and custody signs nothing unadmitted', () =>
    withWorld(async (w) => {
      const { rec, issue } = await authorizeBuy(w, mdemo(30n));
      await w.signer.issueAuthorizedBuy(rec, issue);
      w.chain.consumed.clear();
      const a = submitted(w);
      const art = buildArtifactFrom(a);
      const s = secp256k1.sign(principalSigningHash(art), Buffer.from(AGENT_KEY.slice(2), 'hex'), { prehash: false, format: 'recovered' });
      const agentAsPrincipal = `0x${Buffer.from([...s.subarray(1), (s[0] as number) + 27]).toString('hex')}`;
      assert.equal(mine(w, { ...a, principalSignature: agentAsPrincipal }).revert, rev('PrincipalSignatureInvalid'));
      // A mandate naming the agent as its own principal settles nothing of the principal's: the agent has no funds or allowance there.
      assert.equal(w.chain.allowance(MDUSD, AGENT, GATE), 0n);
      // Custody, asked to sign an artifact with no ADMIT_ATTEMPT behind it, refuses before the key is used.
      const fresh = buildGateArtifact({ executionId: rec.executionId, authorizationId: rec.id, reservation: rec.reservation, generation: rec.generation, adapter: rec.adapter, evaluatedAt: rec.evaluatedAt, validUntil: rec.validUntil }, { gate: REVIEWED, market: MARKET, principal: PRINCIPAL, agent: AGENT, quantity: mdemo(1n), nonce: 99n, deadline: rec.validUntil - 10n });
      const r = w.deps.custody.signMandate(fresh, { gate: REVIEWED, market: MARKET, principal: PRINCIPAL, agent: AGENT, quantity: mdemo(1n), nonce: 99n, deadline: rec.validUntil - 10n }, { attempt: `0x${'ab'.repeat(32)}` as never, reservation: rec.reservation, generation: rec.generation, action: rec.actionId });
      assert.deepEqual(r, { ok: false, error: 'ATTEMPT_NOT_ADMITTED' });
      assert.ok(agentSigningHash(fresh).length === 32);
    }));
});

describe('pre-execution requirements refuse before any attempt', () => {
  it('an allowance below the reserved capital: CREDENTIAL_SCOPE fails, nothing is admitted, NEVER_ISSUED stays available', () =>
    withWorld(
      async (w) => {
        const { rec, issue } = await authorizeBuy(w, mdemo(30n));
        const out = await w.signer.issueAuthorizedBuy(rec, issue);
        assert.deepEqual(out, { status: 'REFUSED', stage: 'ADMIT', reason: 'PRE_EXECUTION_FAILED.CREDENTIAL_SCOPE.FAIL.ALLOWANCE_INSUFFICIENT', attemptAdmitted: false });
        const closed = await w.engine.closeNeverIssued(rec, { payload: issue.payload, states: marketStates(w.policy, T + 6n, { ...MARKET, feeBps: 1 }), context: context(T + 6n) }, ONCE);
        assert.equal(closed.status, 'CLOSED');
      },
      { allowance: mdusd(299n) },
    ));

  it('a gate whose code is not the reviewed code: CREDENTIAL_SCOPE fails', () =>
    withWorld(async (w) => {
      w.chain.codehash = `0x${'c1'.repeat(32)}`;
      const { rec, issue } = await authorizeBuy(w, mdemo(30n));
      const out = await w.signer.issueAuthorizedBuy(rec, issue);
      assert.ok(out.status === 'REFUSED' && out.reason === 'PRE_EXECUTION_FAILED.CREDENTIAL_SCOPE.FAIL.GATE_CODE_NOT_REVIEWED');
    }));

  it('a preflight revert keeps the attempt admitted and the reservation held; nothing is broadcast', () =>
    withWorld(async (w) => {
      const { rec, issue } = await authorizeBuy(w, mdemo(30n));
      w.chain.onSimulate = () => w.chain.fund(MDUSD, PRINCIPAL, -mdusd(1_000n)); // funds leave between admission and preflight
      const out = await w.signer.issueAuthorizedBuy(rec, issue);
      assert.ok(out.status === 'REFUSED' && out.stage === 'PREFLIGHT' && out.attemptAdmitted);
      assert.equal(w.chain.txs.length, 0);
      assert.equal(w.store.readCommitted(PRINCIPAL_ID).state.reservations.get(rec.reservation)?.status, 'ACTIVE');
      assert.equal(w.journal.list(PRINCIPAL_ID)[0]?.state, 'OUTCOME_UNKNOWN');
      const c = await w.engine.closeNeverIssued(rec, { payload: issue.payload, states: marketStates(w.policy, T + 6n, { ...MARKET, feeBps: 1 }), context: context(T + 6n) }, ONCE);
      assert.ok(c.status === 'REFUSED' && c.refusal.code === 'NEVER_ISSUED_FORBIDDEN');
    }));
});

describe('after execution nothing is released', () => {
  it('the reservation stays ACTIVE and NEVER_ISSUED is forbidden: consumption is reconciliation’s (7F)', () =>
    withWorld(async (w) => {
      const { rec, issue } = await executed(w);
      assert.equal(w.store.readCommitted(PRINCIPAL_ID).state.reservations.get(rec.reservation)?.status, 'ACTIVE');
      const c = await w.engine.closeNeverIssued(rec, { payload: issue.payload, states: marketStates(w.policy, T + 6n, { ...MARKET, feeBps: 1 }), context: context(T + 6n) }, ONCE);
      assert.ok(c.status === 'REFUSED' && c.refusal.code === 'NEVER_ISSUED_FORBIDDEN');
    }));

  it('recover() marks an interrupted issuance OUTCOME_UNKNOWN and re-signs nothing', () =>
    withWorld(async (w) => {
      w.chain.submitBehaviour = 'UNKNOWN';
      const { rec, issue } = await authorizeBuy(w, mdemo(30n));
      const out = await w.signer.issueAuthorizedBuy(rec, issue);
      assert.ok(out.status === 'ISSUED' && out.issuance === 'OUTCOME_UNKNOWN');
      assert.deepEqual(w.signer.recover(), { unrecorded: 0, interrupted: 0 });
      assert.equal(w.chain.txs.length, 0);
    }));
});
