import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { presetDraft, withField } from '../src/authoring/draft-types.ts';
import { PAUSE_CONFIRMATION } from '../src/authoring/mandate-versioning.ts';
import type { AuthorizeResult } from '../src/authoring/mandate-versioning.ts';
import type { NegotiationRequest } from '../src/runtime/provider.ts';
import { CONFLICTING, keep, propose, reduce, release, scriptedSession, type Negotiation } from './support/session.ts';

describe('timeouts, failures and late replies in the Room', () => {
  it('test 26: a reply to an earlier generation, arriving after the next began, is ignored', async () => {
    // 2,800 of 2,500: only yield offers anything (reduce 300 to 500).
    const n: Negotiation = (r) => {
      if (r.role !== 'yield') return { text: keep };
      // Generation 1: yield answers far too late, and ignores the abort. Generation 2: promptly.
      return r.generation === 1 ? { text: reduce(100), delayMs: 250, ignoreAbort: true } : { text: reduce(500) };
    };
    const t = await scriptedSession(CONFLICTING, n, { roomRoundTimeoutMs: 60 });
    const result = await t.session.run();
    await t.session.complete();
    assert.equal(result.status, 'AUTHORIZED');
    assert.equal(t.of('ROOM_AGENT_TIMEOUT')[0]?.agent, 'yield');
    assert.equal(t.of('ROOM_AGENT_TIMEOUT')[0]?.generation, 1);
    const stale = t.of('ROOM_AGENT_STALE_RESPONSE').filter((e) => e.agent === 'yield');
    assert.equal(stale.length, 1);
    assert.equal(stale[0]?.data['answeredGeneration'], 1);
    assert.equal(stale[0]?.data['reason'], 'ANSWERED_AFTER_TIMEOUT');
    assert.equal(stale[0]?.data['effect'], 'IGNORED');
    // The late "reduce to 100" never mattered: generation 2's 500 is what was reserved.
    assert.equal(result.final.find((f) => f.role === 'yield')?.requested, 500_000_000n);
  });

  it('a timed-out agent is unchanged and does not block others from finding a solution', async () => {
    // Need 500. Generation 1: perps offers 200, stock never answers — not enough. Generation 2: NFT releases 300.
    const n: Negotiation = (r) => {
      if (r.role === 'stock') return { text: keep, delayMs: 5_000 };
      if (r.role === 'perps') return { text: reduce(400) };
      if (r.role === 'nft') return { text: r.generation === 1 ? keep : release };
      return { text: keep };
    };
    const t = await scriptedSession(CONFLICTING, n, { roomRoundTimeoutMs: 80 });
    const result = await t.session.run();
    assert.equal(result.status, 'AUTHORIZED');
    const timeouts = t.of('ROOM_AGENT_TIMEOUT');
    assert.ok(timeouts.some((e) => e.agent === 'stock' && e.generation === 1));
    assert.match(String(timeouts[0]?.data['effect']), /no consent, no release, no new authority/);
    assert.equal(t.of('ROOM_GENERATION_STARTED').length, 2);
    // Stock kept exactly what it signed for: neither reduced on its behalf nor dropped.
    assert.equal(result.final.find((f) => f.role === 'stock')?.requested, 800_000_000n);
    // 3,000 − 200 (perps) − 300 (NFT): exactly the 2,500 limit.
    assert.equal(result.reservedAtoms, 2_500_000_000n);
  });

  it('a provider failure in the Room is a runtime failure: the agent is unchanged', async () => {
    const n: Negotiation = (r) => (r.role === 'stock' ? { text: '', fail: true } : r.role === 'perps' ? { text: reduce(400) } : r.role === 'nft' ? { text: release } : { text: keep });
    const t = await scriptedSession(CONFLICTING, n);
    const result = await t.session.run();
    assert.equal(result.status, 'AUTHORIZED');
    const failed = t.of('ROOM_AGENT_RESPONSE').find((e) => e.agent === 'stock');
    assert.equal(failed?.data['status'], 'FAILED');
    assert.equal(failed?.data['effect'], 'UNCHANGED');
  });
});

describe('tests 28–29: freshness under real negotiation latency', () => {
  it('a quote that ages past its bound during negotiation is refused, marked stale, and needs a genuinely fresh decision', async () => {
    const draft = withField(presetDraft('balanced'), 'market.maxQuoteAgeSeconds', '10', 'USER');
    let aged = false;
    const n: Negotiation = (r: NegotiationRequest) => {
      if (!aged) {
        aged = true;
        // Twelve protocol seconds pass while the agents negotiate.
        t.time.now += 12n;
      }
      return { text: r.role === 'perps' ? reduce(400) : r.role === 'yield' ? reduce(500) : r.role === 'nft' ? release : keep };
    };
    const observedAt = (e: { data: { [k: string]: unknown } }) => BigInt(String(e.data['quoteObservedAt']));
    const t = await scriptedSession((role, call) => (call === 0 ? CONFLICTING[role] ?? { text: '' } : role === 'swap' ? { text: propose('route-a', 300) } : { text: propose('alpha-usd-vault', 500) }), n, { draft });
    const t0 = t.time.now;
    const result = await t.session.run();

    const stale = t.of('PROPOSAL_STALE').filter((e) => e.data['cause'] === 'QUOTE_STALE');
    assert.deepEqual(stale.map((e) => e.agent).sort(), ['swap', 'yield']);
    for (const e of stale) {
      assert.equal(e.data['next'], 'REFRESH_REQUIRED');
      assert.ok((e.data['reasons'] as string[]).some((x) => x.startsWith('QUOTE_STALE')));
    }
    // The stale proposals were signed with the original quote time: never re-stamped.
    const finalSwap = t.of('PROPOSAL_SIGNED').find((e) => e.agent === 'swap' && e.data['phase'] === 'FINAL');
    assert.ok(finalSwap);
    assert.equal(observedAt(finalSwap), t0);
    // The refresh is a new decision on a newly observed candidate, bounded by what the Room agreed.
    const refreshRequests = t.provider.requests.filter((r) => r.kind === 'DECISION' && r.role === 'swap');
    assert.equal(refreshRequests.length, 2);
    const refresh = refreshRequests[1];
    assert.ok(refresh?.kind === 'DECISION');
    assert.equal(refresh.candidates.length, 1);
    assert.equal(refresh.candidates[0]?.maxAtoms, '500000000');
    const fresh = t.of('AGENT_REQUEST_STARTED').filter((e) => e.agent === 'swap').at(-1);
    assert.equal(BigInt(String(fresh?.data['quoteObservedAt'])), t0 + 12n);
    assert.deepEqual(result.refreshed.map((p) => [p.role, p.outcome]).sort(), [['swap', 'RESERVED'], ['yield', 'RESERVED']]);
    assert.equal(result.status, 'AUTHORIZED');
    assert.equal(t.of('PORTFOLIO_AUTHORIZED').filter((e) => e.data['phase'] === 'REFRESH').length, 1);
  });
});

describe('test 30: the principal may amend during the Room, and only authority changes', () => {
  it('V2 supersedes the Room; in-flight proposals must re-authorize; negotiation restarts under V2', async () => {
    let amendment: Promise<AuthorizeResult> | null = null;
    const n: Negotiation = (r) => {
      if (r.generation === 1 && amendment === null && r.roomId.startsWith('room-v1')) {
        // The principal tightens perps while the Room negotiates. They never touch an allocation.
        const v1 = t.session.versions.active!;
        amendment = t.session.authorize(withField(withField(v1.draft, 'portfolio.maxDerivative', '250', 'USER'), 'agents.perps.maxAllocation', '250', 'USER'), 'AUTHORIZE MANDATE V2');
      }
      return { text: r.role === 'perps' ? reduce(250) : r.role === 'yield' ? reduce(500) : r.role === 'nft' ? release : keep, delayMs: 20 };
    };
    // Under V2 the perps agent still asks for 350: over its new 250 limit. Mandate, not the lab, says so; its own
    // bounded re-plan (no Room: nobody else is involved) then asks for 250.
    const t = await scriptedSession((role, call) => (role !== 'perps' || call === 0 ? CONFLICTING[role] ?? { text: '' } : { text: propose('btc-long-2x', call === 1 ? 350 : 250) }), n);
    const result = await t.session.run();
    assert.ok(amendment !== null);
    assert.ok((await (amendment as Promise<AuthorizeResult>)).ok);

    assert.equal(t.of('MANDATE_AMENDMENT_STARTED').length, 1);
    assert.equal(t.of('MANDATE_AMENDMENT_AUTHORIZED').length, 1);
    assert.equal(t.of('MANDATE_VERSION_SUPERSEDED')[0]?.data['version'], 1);
    const v1Room = t.of('ROOM_FINALIZED').find((e) => String(e.roomId).startsWith('room-v1'));
    assert.equal(v1Room?.data['result'], 'SUPERSEDED');
    assert.equal(t.of('ROOM_PROPOSAL_CREATED').filter((e) => String(e.roomId).startsWith('room-v1')).length, 0);
    const reauth = t.of('PROPOSAL_STALE').filter((e) => e.data['next'] === 'REAUTHORIZE_REQUIRED');
    assert.ok(reauth.length >= 4);
    assert.ok(reauth.every((e) => (e.data['reasons'] as string[]).includes('PORTFOLIO_MANDATE_DIGEST_MISMATCH')));
    // The perps agent's 350 under V2 is over its own limit and re-planned locally, never sent to a Room as a conflict.
    assert.equal(t.of('AGENT_LOCAL_REPLAN_REQUESTED').filter((e) => e.agent === 'perps' && e.mandateVersion === 2).length, 1);
    const v2Perps = t.of('PROPOSAL_ADMISSIBLE').find((e) => e.agent === 'perps' && e.mandateVersion === 2);
    assert.ok((v2Perps?.data['reasons'] as string[]).some((x) => x.startsWith('AGENT_LIMIT_EXCEEDED') || x.startsWith('PORTFOLIO_LIMIT_EXCEEDED')));
    assert.equal(result.version, 2);
    assert.equal(result.status, 'AUTHORIZED');
    assert.equal(result.final.find((f) => f.role === 'perps')?.requested, 250_000_000n);
    assert.equal(t.of('PORTFOLIO_AUTHORIZED')[0]?.mandateVersion, 2);
  });

  it('once anything is reserved, an amendment is refused; the reservation stands', async () => {
    const t = await scriptedSession({ stock: { text: propose('nvda-note-a', 300) } });
    assert.equal((await t.session.run()).status, 'AUTHORIZED');
    const r = await t.session.authorize(presetDraft('conservative'), 'AUTHORIZE MANDATE V2');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'AMENDMENT_AFTER_RESERVATION');
    assert.equal(t.of('MANDATE_AMENDMENT_REFUSED').length, 1);
    assert.equal(t.session.versions.active?.version, 1);
  });

  it('pause during the Room stops everything: nothing is reserved', async () => {
    let paused: Promise<boolean> | null = null;
    const t = await scriptedSession(CONFLICTING, (r) => {
      if (paused === null) paused = t.session.pause(PAUSE_CONFIRMATION);
      return { text: r.role === 'perps' ? reduce(400) : r.role === 'nft' ? release : keep, delayMs: 20 };
    });
    const result = await t.session.run();
    assert.equal(await (paused as unknown as Promise<boolean>), true);
    assert.equal(result.status, 'NO_ACTIVE_MANDATE');
    assert.equal(t.of('MANDATE_REVERIFY_STARTED').length, 0);
    assert.equal(t.of('MANDATE_PAUSED').length, 1);
  });
});
