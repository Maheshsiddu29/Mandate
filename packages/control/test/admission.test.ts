/**
 * State requirements, admission and bindings (STATE-1…4; action-state-model.md
 * §5.3–5.5; brief §6–§10). Each refusal the admission rules can produce is
 * produced here, and the boundary of each freshness mode is tested on both
 * sides.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stateId, type AuthorityTermInput, type StateRequirementInput } from '@mandate/core';
import { readmitBinding } from '../src/admission.ts';
import { statePayloadDigest, validateEvaluationContext, type ControlRefusal, type SuppliedState } from '../src/index.ts';
import {
  AGENT_A,
  FEED_SOURCE,
  ONCE,
  PRICE,
  T,
  VENUE_SOURCE,
  account,
  action,
  capitalDim,
  context,
  encodeMark,
  instrumentsState,
  markState,
  must,
  policy,
  positionState,
  refused,
  request,
  root,
  setup,
  sizeFor,
  world,
  type SyntheticModule,
} from './support/world.ts';

async function fixture(extraTerms: readonly AuthorityTermInput[] = []) {
  const w = world();
  const m = w.modules[0] as SyntheticModule;
  const spot = w.modules[1] as SyntheticModule;
  const acct = account(m);
  const r0 = root({ mods: [m], holder: AGENT_A, terms: [capitalDim('capital', 100_000), ...extraTerms] });
  await setup(w, policy(), [r0]);
  const ctx = (o: Parameters<typeof context>[1] = {}) => context([m, spot], { accounts: [{ module: m, account: acct }], ...o });
  const states = (o: { mark?: SuppliedState | null; position?: SuppliedState | null; instruments?: SuppliedState | null; extra?: SuppliedState[] } = {}): SuppliedState[] =>
    [
      o.mark === undefined ? markState(m, 'x:BTC-PERP') : o.mark,
      o.position === undefined ? positionState(m, acct) : o.position,
      o.instruments === undefined ? instrumentsState(m) : o.instruments,
      ...(o.extra ?? []),
    ].filter((x): x is SuppliedState => x !== null);
  const attempt = async (s: SuppliedState[], c = ctx()): Promise<ControlRefusal> => refused(await w.engine.authorizeAndReserve(request(action(m, { authority: r0, size: sizeFor(1_000) }), s, c), ONCE));
  const pass = async (s: SuppliedState[], c = ctx()) => {
    const d = await w.engine.decide(request(action(m, { authority: r0, size: sizeFor(1_000) }), s, c));
    assert.ok(d.ok, d.ok ? '' : `${d.error.code}/${d.error.reason}`);
    return d.ok ? d.value : (null as never);
  };
  return { w, m, spot, acct, r0, ctx, states, attempt, pass };
}

function expect(r: ControlRefusal, code: string, reason: string): void {
  assert.deepEqual([r.code, r.reason], [code, reason]);
}

describe('admission refusals', () => {
  it('missing state', async () => {
    const f = await fixture();
    expect(await f.attempt(f.states({ mark: null })), 'STATE_MISSING', 'STATE_NOT_SUPPLIED');
  });

  it('stale by age, past the source\'s own validity, and from the future', async () => {
    const f = await fixture();
    expect(await f.attempt(f.states({ mark: markState(f.m, 'x:BTC-PERP', PRICE, { observedAt: T - 31n }) })), 'STATE_STALE', 'AGE_EXCEEDED');
    expect(await f.attempt(f.states({ mark: markState(f.m, 'x:BTC-PERP', PRICE, { observedAt: T - 5n, validUntil: T }) })), 'STATE_STALE', 'SOURCE_VALIDITY_ENDED');
    expect(await f.attempt(f.states({ mark: markState(f.m, 'x:BTC-PERP', PRICE, { observedAt: T + 1n }) })), 'STATE_INVALID', 'OBSERVED_IN_FUTURE');
  });

  it('SEQUENCE: behind the reconciliation watermark, no watermark given, or no sequence at all', async () => {
    const f = await fixture();
    expect(await f.attempt(f.states(), f.ctx({ accounts: [{ module: f.m, account: f.acct, watermark: 11n }] })), 'STATE_STALE', 'BEHIND_WATERMARK');
    expect(await f.attempt(f.states(), f.ctx({ accounts: [] })), 'STATE_STALE', 'WATERMARK_UNKNOWN');
    expect(await f.attempt(f.states({ position: positionState(f.m, f.acct, [], undefined, { sequence: { kind: 'NONE' } }) })), 'STATE_INVALID', 'SEQUENCE_KIND_MISMATCH');
    // Exactly at the watermark is admitted.
    await f.pass(f.states(), f.ctx({ accounts: [{ module: f.m, account: f.acct, watermark: 10n }] }));
  });

  it('VERSION: a different pinned version, or one relied on too long', async () => {
    const f = await fixture();
    const other = { ...instrumentsState(f.m), payload: new Uint8Array([...f.m.instrumentsPayload, 0]) };
    const reissued = instrumentsState(f.m);
    const wrong: SuppliedState = { payload: other.payload, envelope: must(validateEnvelopeWithPayload(reissued, other.payload, f.m)) };
    expect(await f.attempt(f.states({ instruments: wrong })), 'STATE_STALE', 'PINNED_VERSION_MISMATCH');
    expect(await f.attempt(f.states({ instruments: instrumentsState(f.m, { observedAt: T - 86_401n }) })), 'STATE_STALE', 'AGE_EXCEEDED');
  });

  it('finality below the required level, on another ladder, or undeclared', async () => {
    const f = await fixture();
    const at = (ladder: string, level: string) => f.states({ position: positionState(f.m, f.acct, [], undefined, { finality: { ladder, level } }) });
    expect(await f.attempt(at('synth.venue', 'RECEIVED')), 'STATE_FINALITY_INSUFFICIENT', 'FINALITY_BELOW_REQUIRED');
    expect(await f.attempt(at('synth.feed', 'PUBLISHED')), 'STATE_FINALITY_INSUFFICIENT', 'FINALITY_LADDER_MISMATCH');
    expect(await f.attempt(at('synth.venue', 'RUMOURED')), 'STATE_FINALITY_INSUFFICIENT', 'FINALITY_LEVEL_UNDECLARED');
    // Higher than required is admitted.
    await f.pass(at('synth.venue', 'FINAL'));
  });

  it('untrusted: unconfigured source, a self-declared trust class, a source not configured for the kind or not admitted, and trust below the minimum', async () => {
    const f = await fixture();
    const base = f.ctx();
    expect(await f.attempt(f.states({ mark: markState(f.m, 'x:BTC-PERP', PRICE, { sourceId: 'rogue.feed' }) })), 'STATE_UNTRUSTED', 'SOURCE_NOT_CONFIGURED');
    expect(await f.attempt(f.states({ mark: markState(f.m, 'x:BTC-PERP', PRICE, { trustClass: 'AUTHORITATIVE' }) })), 'STATE_UNTRUSTED', 'TRUST_CLASS_MISMATCH');
    expect(await f.attempt(f.states({ mark: markState(f.m, 'x:BTC-PERP', PRICE, { sourceId: VENUE_SOURCE }) })), 'STATE_UNTRUSTED', 'SOURCE_NOT_CONFIGURED_FOR_KIND');
    const withOther = { ...base, sources: [...base.sources, { sourceId: 'synth.other-feed', trustClass: 'VERIFIED' as const, kinds: [{ domain: f.m.ref.domainId, stateKind: 'synth.mark' }] }] };
    expect(await f.attempt(f.states({ mark: markState(f.m, 'x:BTC-PERP', PRICE, { sourceId: 'synth.other-feed' }) }), withOther), 'STATE_UNTRUSTED', 'SOURCE_NOT_ADMITTED');
    const advisory = { ...base, sources: base.sources.map((s) => (s.sourceId === FEED_SOURCE ? { ...s, trustClass: 'ADVISORY' as const } : s)) };
    expect(await f.attempt(f.states({ mark: markState(f.m, 'x:BTC-PERP', PRICE, { trustClass: 'ADVISORY' }) }), advisory), 'STATE_UNTRUSTED', 'TRUST_INSUFFICIENT');
  });

  it('conflicting snapshots of one subject refuse; the same snapshot twice is one', async () => {
    const f = await fixture();
    const a = markState(f.m, 'x:BTC-PERP', PRICE);
    const b = markState(f.m, 'x:BTC-PERP', PRICE + 1n);
    expect(await f.attempt(f.states({ mark: a, extra: [b] })), 'STATE_CONFLICT', 'AMBIGUOUS_SNAPSHOTS');
    // A newer observation of the same price is still a different snapshot: never "take the newest".
    expect(await f.attempt(f.states({ mark: a, extra: [markState(f.m, 'x:BTC-PERP', PRICE, { observedAt: T - 1n })] })), 'STATE_CONFLICT', 'AMBIGUOUS_SNAPSHOTS');
    await f.pass(f.states({ mark: a, extra: [a] }));
  });

  it('state normalized under another ModuleRef, or whose payload is not what its digest commits to, is not admitted', async () => {
    const f = await fixture();
    expect(await f.attempt(f.states({ mark: markState(f.m, 'x:BTC-PERP', PRICE, { under: f.spot }) })), 'STATE_INVALID', 'MODULE_MISMATCH');
    expect(await f.attempt(f.states({ mark: markState(f.m, 'x:BTC-PERP', PRICE, { payloadDigest: `0x${'12'.repeat(32)}` }) })), 'STATE_INVALID', 'PAYLOAD_DIGEST_MISMATCH');
    // A payload that is its digest's, but that the module cannot read as this subject's.
    const foreign = markState(f.m, 'x:BTC-PERP');
    const payload = encodeMark({ domain: f.m.ref.domainId, kind: 'MARKET', localId: 'x:SOMETHING-ELSE' }, PRICE);
    const r = await f.attempt(f.states({ mark: { payload, envelope: must(validateEnvelopeWithPayload(foreign, payload, f.m)) } }));
    expect(r, 'STATE_INVALID', 'MARK_PAYLOAD_INVALID');
    assert.equal(r.origin, 'MODULE');
  });

  it('every failing requirement is reported, the first in canonical order leads', async () => {
    const f = await fixture();
    const r = await f.attempt(f.states({ mark: null, position: positionState(f.m, f.acct, [], undefined, { observedAt: T + 5n }) }));
    assert.equal(r.detail.kind, 'STATE');
    if (r.detail.kind === 'STATE') assert.equal(r.detail.failures.length, 2);
  });
});

describe('effective requirements', () => {
  const tighterMark = (
    maxAge: bigint,
    freshness: StateRequirementInput['freshness'] = { kind: 'AGE', maxAgeSeconds: maxAge },
    atExecution: StateRequirementInput['atExecution'] = { kind: 'BOUNDED_BY_FRESHNESS' },
  ): AuthorityTermInput => ({
    kind: 'STATE_POLICY',
    domain: 'synth-perp',
    stateKind: 'synth.mark',
    admittedSources: [FEED_SOURCE],
    requirement: { freshness, minTrust: 'VERIFIED', minFinality: { ladder: 'synth.feed', level: 'PUBLISHED' }, atIssue: 'RECHECK', atExecution },
  });

  it('a lineage state policy tightens the module default, and the binding records the tightened requirement', async () => {
    const f = await fixture([tighterMark(10n)]);
    expect(await f.attempt(f.states({ mark: markState(f.m, 'x:BTC-PERP', PRICE, { observedAt: T - 15n }) })), 'STATE_STALE', 'AGE_EXCEEDED');
    const d = await f.pass(f.states({ mark: markState(f.m, 'x:BTC-PERP', PRICE, { observedAt: T - 5n }) }));
    const mark = d.bindings.find((b) => b.stateKind === 'synth.mark');
    assert.deepEqual(mark?.requirement.freshness, { kind: 'AGE', maxAgeSeconds: 10n });
    // And the authorization's lifetime follows the tighter bound: observed at T − 5, 10 s.
    assert.equal(d.validUntil, T + 5n);
  });

  it('requirements that cannot be combined refuse rather than choosing one', async () => {
    const f = await fixture([tighterMark(0n, { kind: 'SEQUENCE' }, { kind: 'NOT_REQUIRED' })]);
    const r = await f.attempt(f.states());
    expect(r, 'STATE_POLICY_CONFLICT', 'FRESHNESS_INCOMPARABLE');
  });
});

describe('bindings and no smuggling (STATE-4; brief §9–§10)', () => {
  it('binds exactly the admitted snapshots; unrequired state is never admitted or shown to the module', async () => {
    const f = await fixture();
    const extra = positionState(f.m, account(f.m, 'acct-unrelated'), [{ localId: 'x:BTC-PERP', size: sizeFor(99_000) }]);
    const s = f.states({ extra: [extra] });
    const d = await f.pass(s);
    assert.equal(d.bindings.length, 3);
    const admitted = new Set(d.admissions.map((a) => a.state.stateId));
    assert.ok(!admitted.has(stateId(extra.envelope)));
    for (const b of d.bindings) {
      const supplied = s.find((x) => stateId(x.envelope) === b.stateDigest);
      assert.ok(supplied !== undefined);
      assert.equal(b.sourceId, supplied.envelope.sourceId);
      assert.equal(b.observedAt, supplied.envelope.observedAt);
      assert.deepEqual(b.finality, supplied.envelope.finality);
      assert.deepEqual(b.sequence, supplied.envelope.sequence);
    }
    const part = d.projection.participants[0];
    assert.deepEqual([...(part?.states ?? [])].sort(), [...admitted].sort());
    // The unrelated account's 99,000 never reached the projection.
    assert.ok(!(part?.projection.facts ?? []).some((f2) => f2.account?.localId === 'acct-unrelated'));
  });
});

describe('re-admission at issue time', () => {
  it('re-admission reads a binding alone, under the requirement it was admitted with', async () => {
    const f = await fixture();
    const d = await f.pass(f.states());
    const position = d.bindings.find((b) => b.stateKind === 'synth.position');
    assert.ok(position !== undefined);
    const at = (t: bigint, watermark = 0n) => must(validateEvaluationContext(context([f.m], { at: t, accounts: [{ module: f.m, account: f.acct, watermark }] })));
    assert.equal(readmitBinding(position, f.m.ref.domainId, f.m.finalityLadders, at(T + 3_600n)), null);
    // Superseded: the ledger has reconciled past its sequence.
    assert.equal(readmitBinding(position, f.m.ref.domainId, f.m.finalityLadders, at(T + 1n, 11n))?.reason, 'BEHIND_WATERMARK');
  });
});

/** An envelope identical to `base`'s but committing to `payload`. */
function validateEnvelopeWithPayload(base: SuppliedState, payload: Uint8Array, m: SyntheticModule): { ok: true; value: SuppliedState['envelope'] } {
  return { ok: true, value: { ...base.envelope, payloadDigest: statePayloadDigest(m.ref, payload) } as SuppliedState['envelope'] };
}
