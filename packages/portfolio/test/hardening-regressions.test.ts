/**
 * Phase 7F.1 audit reproductions.
 *
 * These tests deliberately describe the pre-hardening behavior. The first
 * hardening commit changes each assertion from "the bypass succeeds" to the
 * corresponding fail-closed property while keeping the same attack inputs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Identifier } from '@mandate/kernel';
import {
  candidateDigest,
  childAuthorizationDigest,
  childExecutionAuthorizationInputOf,
  executeFixtureChild,
  fullAvailability,
  portfolioMandateDigest,
  proposalDigest,
  receiptDigest,
  releaseDigest,
  reserveChild,
  runMandateRoom,
  runPortfolio,
  screenProposal,
  validateChildExecutionAuthorization,
  verifyPortfolio,
  type AllocationOp,
  type PortfolioCandidate,
  type SignedProposal,
  type SignedRelease,
} from '../src/index.ts';
import { USDC, demoBindings, demoMandate, demoParty } from '../src/demo/index.ts';
import { NOW, stockBuy, swap, yieldDeposit } from './support/candidates.ts';
import { ScriptedAgent, authorizationFor, childFor, principalSignature, proposal, release, world } from './support/world.ts';

describe('Phase 7F.1 independent audit reproductions', () => {
  it('reproduces candidate semantic rebinding on the real reservation path', async () => {
    const w = await world();
    const approved = swap();
    const substituted = swap({ minOut: 0n });
    const child = childFor(w.m, 'swap', approved);
    const rebound = validateChildExecutionAuthorization({
      ...childExecutionAuthorizationInputOf(child),
      candidate: candidateDigest(substituted),
    });
    assert.ok(rebound.ok);

    const authorization = authorizationFor(w.m, 'swap', approved);
    const out = await reserveChild(w.core, authorization.transcript, childAuthorizationDigest(rebound.value), NOW);
    assert.equal(out.status, 'REFUSED');
  });

  it('binds every material swap field from verification through reservation, while the exact candidate succeeds', async () => {
    const mutations = [
      ['zero-min-out', swap({ minOut: 0n })],
      ['lower-min-out', swap({ minOut: 119_639_999_999_999_999n })],
      ['quote-timestamp', swap({ observedAt: NOW - 11n })],
      ['recipient', swap({ recipient: 'eip155:421614/account:0x9999999999999999999999999999999999999999' })],
      ['router', swap({ router: 'eip155:421614/router:0x0000000000000000000000000000000000005a02' })],
      ['route', swap({ route: ['eip155:421614/pool:0x0000000000000000000000000000000000005a02'] })],
      ['input-amount', swap({ amount: USDC(301n) })],
      ['output-representation', swap({ tokenOut: 'eip155:421614/erc20:0x00000000000000000000000000000000000e7402' })],
    ] as const;
    for (const [name, mutated] of mutations) {
      const w = await world();
      const authorization = authorizationFor(w.m, 'swap', swap());
      const forged = validateChildExecutionAuthorization({
        ...childExecutionAuthorizationInputOf(authorization.verified.child),
        candidate: candidateDigest(mutated),
      });
      assert.ok(forged.ok);
      const out = await reserveChild(w.core, authorization.transcript, childAuthorizationDigest(forged.value), NOW);
      assert.equal(out.status, 'REFUSED', name);
      const snapshot = await w.core.engine.read(w.m.principal);
      assert.equal(snapshot.state.reservations.size, 0, name);
    }

    const stale = await world();
    const staleAuthorization = authorizationFor(stale.m, 'swap', swap());
    const staleOut = await reserveChild(stale.core, staleAuthorization.transcript, staleAuthorization.verified.digest, NOW + 61n);
    assert.ok(staleOut.status === 'REFUSED' && staleOut.reasons.some((r) => r.code === 'QUOTE_STALE'));
    assert.equal((await stale.core.engine.read(stale.m.principal)).state.reservations.size, 0);

    const exact = await world();
    const exactAuthorization = authorizationFor(exact.m, 'swap', swap());
    assert.equal((await reserveChild(exact.core, exactAuthorization.transcript, exactAuthorization.verified.digest, NOW)).status, 'RESERVED');
  });

  it('reproduces caller-forged verifier membership at the pre-sign boundary', async () => {
    const w = await world();
    const candidate = yieldDeposit({ amount: USDC(100n) });
    const authorization = authorizationFor(w.m, 'yield', candidate);
    const child = authorization.verified.child;
    const reserved = await reserveChild(w.core, authorization.transcript, authorization.verified.digest, NOW);
    assert.equal(reserved.status, 'RESERVED');
    assert.ok(reserved.status === 'RESERVED');

    const forgedMembership = { ...authorization.transcript, candidate: { ...authorization.transcript.candidate, accepted: [] } };
    const executed = await executeFixtureChild(w.core, forgedMembership, child, candidate, reserved.record, NOW + 5n);
    assert.ok(!executed.ok);
  });

  it('reproduces verifier acceptance of two distinct releases with the same sequence', () => {
    const mandate = demoMandate();
    const first = release(mandate, 'nft', [['portfolio-notional', 100n]], 7n);
    const second = release(mandate, 'nft', [['portfolio-notional', 50n]], 7n);
    const operations: AllocationOp[] = [first, second].map((signed) => ({
      kind: 'RELEASE',
      agent: signed.release.agent,
      id: `release/${releaseDigest(signed.release)}` as Identifier,
      amounts: signed.release.amounts,
    }));
    const result = verifyPortfolio({
      mandate,
      signature: principalSignature(mandate),
      bindings: demoBindings(),
      availability: fullAvailability(mandate),
      now: NOW,
      candidate: { portfolioMandate: portfolioMandateDigest(mandate), accepted: [], allocationLog: operations },
      proposals: [],
      releases: [first, second],
    });
    assert.ok(result.status === 'REFUSED' && result.reasons.some((r) => r.code === 'RELEASE_SEQUENCE_INVALID'));
  });

  it('reproduces a receipt collision when a committed amount changes', async () => {
    const w = await world();
    const signed = {
      kind: 'PROPOSE' as const,
      signed: proposal(w.m, 'swap', swap({ amount: USDC(100n) })),
    };
    const run = await runPortfolio({
      core: w.core,
      signature: principalSignature(w.m),
      now: NOW,
      agents: [new ScriptedAgent('swap', [[1, signed]])],
      execute: null,
    });
    const log = run.receipt.allocationAfter.log.map((op) =>
      op.kind === 'COMMIT'
        ? { ...op, amounts: op.amounts.map((a) => ({ ...a, atoms: a.atoms + 1n })) }
        : op,
    );
    const altered = {
      ...run.receipt,
      allocationAfter: { ...run.receipt.allocationAfter, log },
    };
    assert.notEqual(receiptDigest(altered), run.digest);
  });

  it('Receipt V2 commits every material field and preserves event-stream order', async () => {
    const w = await world();
    const run = await runPortfolio({
      core: w.core,
      signature: principalSignature(w.m),
      now: NOW,
      agents: [
        new ScriptedAgent('nft', [[1, { kind: 'RELEASE', signed: release(w.m, 'nft', [['portfolio-notional', 250n]], 3n) }]]),
        new ScriptedAgent('stock', [[1, { kind: 'PROPOSE', signed: proposal(w.m, 'stock', stockBuy({ tenths: 48n })) }]]),
        new ScriptedAgent('swap', [[1, { kind: 'PROPOSE', signed: proposal(w.m, 'swap', swap()) }]]),
      ],
      execute: null,
    });
    const base = run.receipt;
    const different = (changed: typeof base, name: string) => assert.notEqual(receiptDigest(changed), run.digest, name);
    different({ ...base, mandate: { ...base.mandate, nonce: base.mandate.nonce + 1n } as never }, 'mandate nonce');
    different({ ...base, proposals: base.proposals.map((p, i) => (i === 0 ? { ...p, candidate: `0x${'aa'.repeat(32)}` as never } : p)) }, 'candidate digest');
    different({ ...base, releases: base.releases.map((r, i) => (i === 0 ? { ...r, sequence: r.sequence + 1n, amounts: r.amounts.map((a) => ({ ...a, atoms: a.atoms + 1n })) } : r)) }, 'release sequence and amounts');
    different({ ...base, allocationAfter: { ...base.allocationAfter, log: [...base.allocationAfter.log].reverse() } }, 'event order');
    for (const kind of ['COMMIT', 'RELEASE', 'CLAIM'] as const) {
      different({
        ...base,
        allocationAfter: {
          ...base.allocationAfter,
          log: base.allocationAfter.log.map((op) => {
            if (op.kind !== kind) return op;
            return op.kind === 'CLAIM'
              ? { ...op, amount: op.amount + 1n }
              : { ...op, amounts: op.amounts.map((a) => ({ ...a, atoms: a.atoms + 1n })) };
          }),
        },
      }, `${kind} value`);
    }
    different({ ...base, childAuthorizations: base.childAuthorizations.map((c, i) => (i === 0 ? { ...c, action: null } : c)) }, 'child action');
    different({ ...base, reservations: base.reservations.map((r, i) => (i === 0 && r.generation !== null ? { ...r, generation: (r.generation + 1n) as never } : r)) }, 'reservation generation');
    different({ ...base, representationDecisions: base.representationDecisions.map((r, i) => (i === 0 ? { ...r, asset: `${r.asset ?? 'none'}-changed` } : r)) }, 'canonical asset decision');
  });
});

describe('Phase 7F.2 audit follow-ups', () => {
  const verifyWith = (mandate: ReturnType<typeof demoMandate>, candidate: PortfolioCandidate, proposals: readonly SignedProposal[], releases: readonly SignedRelease[]) =>
    verifyPortfolio({ mandate, signature: principalSignature(mandate), bindings: demoBindings(), availability: fullAvailability(mandate), now: NOW, candidate, proposals, releases });
  const releaseOp = (signed: SignedRelease): AllocationOp => ({ kind: 'RELEASE', agent: signed.release.agent, id: `release/${releaseDigest(signed.release)}` as Identifier, amounts: signed.release.amounts });

  it('INFO-2: the verifier refuses a strictly decreasing and an equal release sequence, and a release applied twice', () => {
    const mandate = demoMandate();
    const empty = (log: AllocationOp[]): PortfolioCandidate => ({ portfolioMandate: portfolioMandateDigest(mandate), accepted: [], allocationLog: log });
    const five = release(mandate, 'nft', [['portfolio-notional', 10n]], 5n);
    const three = release(mandate, 'nft', [['portfolio-notional', 20n]], 3n);
    const alsoFive = release(mandate, 'nft', [['portfolio-notional', 30n]], 5n);
    const decreasing = verifyWith(mandate, empty([releaseOp(five), releaseOp(three)]), [], [five, three]);
    assert.ok(decreasing.status === 'REFUSED');
    assert.deepEqual(decreasing.reasons.map((r) => r.code), ['RELEASE_SEQUENCE_INVALID']);
    const equal = verifyWith(mandate, empty([releaseOp(five), releaseOp(alsoFive)]), [], [five, alsoFive]);
    assert.ok(equal.status === 'REFUSED');
    assert.deepEqual(equal.reasons.map((r) => r.code), ['RELEASE_SEQUENCE_INVALID']);
    // The same signed release twice is refused by the book's own replay before the sequence rule is reached.
    const twice = verifyWith(mandate, empty([releaseOp(five), releaseOp(five)]), [], [five]);
    assert.ok(twice.status === 'REFUSED' && twice.reasons.every((r) => r.code === 'CANDIDATE_BOOK_MISMATCH'));
    // In increasing order the same releases verify.
    assert.equal(verifyWith(mandate, empty([releaseOp(three), releaseOp(five)]), [], [three, five]).status, 'VERIFIED');
  });

  it('INFO-3: freshly signed hostile swap proposals are refused by screening itself — in the room, and when a malicious room accepts them', async () => {
    const hostile = [
      ['zero minimum out', swap({ amount: USDC(100n), minOut: 0n }), 'SLIPPAGE_NOT_ALLOWED'],
      ['slippage one basis point over the bound', swap({ amount: USDC(100n), minOut: (120_000_000_000_000_000n * 9_949n) / 10_000n }), 'SLIPPAGE_NOT_ALLOWED'],
      ['quote one second past its bound', swap({ amount: USDC(100n), observedAt: NOW - 61n }), 'QUOTE_STALE'],
    ] as const;
    for (const [name, candidate, code] of hostile) {
      const w = await world();
      const signed = proposal(w.m, 'swap', candidate);
      const digest = proposalDigest(signed.proposal);
      const room = runMandateRoom({ mandate: w.m, signature: principalSignature(w.m), bindings: demoBindings(), availability: fullAvailability(w.m), now: NOW, agents: [new ScriptedAgent('swap', [[1, { kind: 'PROPOSE', signed }]])] });
      const decision = room.decisions.find((d) => d.proposal === digest);
      assert.ok(decision !== undefined && decision.outcome === 'REJECTED', name);
      assert.deepEqual(decision.reasons.map((r) => r.code), [code], name);
      assert.deepEqual(room.candidate.accepted, [], name);

      // A malicious room accepts and commits it anyway: the verifier re-screens the signed proposal and refuses.
      const forced: PortfolioCandidate = { portfolioMandate: portfolioMandateDigest(w.m), accepted: [digest], allocationLog: [{ kind: 'COMMIT', agent: signed.proposal.agent, id: digest as unknown as Identifier, amounts: signed.proposal.requested }] };
      const verdict = verifyWith(w.m, forced, [signed], []);
      assert.ok(verdict.status === 'REFUSED', name);
      assert.deepEqual(verdict.reasons.map((r) => r.code), [code], name);
      const transcript = { signature: principalSignature(w.m), availability: fullAvailability(w.m), verifiedAt: NOW, candidate: forced, proposals: [signed], releases: [] };
      const child = screenProposal(w.m, demoBindings(), signed, NOW).child;
      assert.equal(child, null, name);
      const out = await reserveChild(w.core, transcript, `0x${'00'.repeat(32)}` as never, NOW);
      assert.ok(out.status === 'REFUSED' && out.reasons.some((r) => r.code === code), name);
      assert.equal((await w.core.engine.read(w.m.principal)).state.reservations.size, 0, name);
    }
  });
});
