/**
 * The failure taxonomy (brief §45): the refusals not produced elsewhere are
 * produced here — action validity, coverage over the meet, authority, the
 * context and resource bounds — and every code in `CONTROL_CODES` is produced
 * by at least one test in this package (AGENTS.md §4.5).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { authorityId, type AuthorityTermInput } from '@mandate/core';
import { CONTROL_CODES, type ControlRefusal } from '../src/index.ts';
import {
  ADAPTER,
  AGENT_A,
  AGENT_B,
  ONCE,
  P,
  T,
  T0,
  account,
  action,
  address,
  capitalDim,
  child,
  context,
  marketStates,
  must,
  policy,
  refused,
  request,
  root,
  setup,
  sizeFor,
  world,
  type SyntheticModule,
} from './support/world.ts';
import { validateActionEnvelope, validateAuthorityGrant, actionEnvelopeInputOf } from '@mandate/core';

async function fixture(terms: readonly AuthorityTermInput[] = [], mods?: (m: SyntheticModule) => SyntheticModule[]) {
  const w = world();
  const m = w.modules[0] as SyntheticModule;
  const acct = account(m);
  const r0 = root({ mods: mods === undefined ? [m] : mods(m), delegate: 1, terms: [capitalDim('capital', 10_000)] });
  const a = child(r0, { mods: mods === undefined ? [m] : mods(m), holder: AGENT_A, terms: [capitalDim('capital', 5_000), ...terms] });
  await setup(w, policy(), [r0, a]);
  const ctx = context([m], { accounts: [{ module: m, account: acct }] });
  const states = marketStates(m, [{ account: acct }]);
  const attempt = async (o: Partial<Parameters<typeof action>[1]> = {}, c = ctx, s = states): Promise<ControlRefusal> =>
    refused(await w.engine.authorizeAndReserve(request(action(m, { authority: a, size: sizeFor(1_000), ...o }), s, c), ONCE));
  return { w, m, acct, r0, a, ctx, states, attempt };
}

function is(r: ControlRefusal, code: string, reason: string): void {
  assert.deepEqual([r.code, r.reason], [code, reason]);
}

describe('action validity', () => {
  it('window, payload digest and the module\'s reading of the payload', async () => {
    const f = await fixture();
    is(await f.attempt({ validFrom: T + 1n }), 'ACTION_INVALID', 'ACTION_NOT_YET_VALID');
    is(await f.attempt({ expiresAt: T }), 'ACTION_INVALID', 'ACTION_EXPIRED');
    const good = action(f.m, { authority: f.a, size: sizeFor(1_000) });
    const tampered = refused(await f.w.engine.authorizeAndReserve({ ...request(good, f.states, f.ctx), payload: new Uint8Array([...good.payload, 0]) }, ONCE));
    is(tampered, 'ACTION_INVALID', 'PAYLOAD_DIGEST_MISMATCH');
    // Resources the envelope declares must be the ones the module recomputes from the payload.
    const lying = must(validateActionEnvelope({ ...actionEnvelopeInputOf(good.envelope), resources: [account(f.m, 'acct-other')] }));
    is(refused(await f.w.engine.authorizeAndReserve({ ...request(good, f.states, f.ctx), action: lying }, ONCE)), 'ACTION_INVALID', 'ACTION_RESOURCES_MISMATCH');
    const r = await f.attempt({ size: 0n });
    is(r, 'ACTION_INVALID', 'ORDER_NOT_POSITIVE');
    assert.equal(r.origin, 'MODULE');
    assert.deepEqual(r.module, f.m.ref);
  });
});

describe('coverage over the meet', () => {
  it('module, adapter, action type, market, right, bound and time window', async () => {
    const f = await fixture();
    const otherAdapter = { ...ADAPTER, adapterVersion: 2 };
    const good = action(f.m, { authority: f.a, size: sizeFor(1_000) });
    const withAdapter = must(validateActionEnvelope({ ...actionEnvelopeInputOf(good.envelope), adapter: otherAdapter }));
    is(refused(await f.w.engine.authorizeAndReserve({ ...request(good, f.states, f.ctx), action: withAdapter }, ONCE)), 'ACTION_NOT_COVERED', 'ADAPTER_NOT_PERMITTED');

    // An authority whose grants omit a vocabulary grants nothing of it.
    const narrow = await fixture([], (m) => [m]);
    const noMarkets = must(
      validateAuthorityGrant({
        lineage: { kind: 'DELEGATION', parent: authorityId(narrow.r0), issuer: P },
        principal: P,
        holder: AGENT_B,
        notBefore: T0,
        expiresAt: narrow.r0.expiresAt,
        nonce: 5n,
        terms: [
          { kind: 'SET', vocabulary: 'MODULES', members: [{ domainId: narrow.m.ref.domainId, moduleId: narrow.m.ref.moduleId, moduleVersion: narrow.m.ref.moduleVersion, moduleDigest: narrow.m.ref.moduleDigest }] },
          { kind: 'SET', vocabulary: 'ADAPTERS', members: [ADAPTER] },
          { kind: 'SET', vocabulary: 'ACTION_TYPES', members: [{ domain: narrow.m.ref.domainId, actionType: 'synth.close' }] },
          { kind: 'RIGHT', right: 'REDUCE_RISK' },
        ],
      }),
    );
    assert.equal((await narrow.w.engine.registerDelegation(noMarkets, T0, ONCE)).status, 'REGISTERED');
    const as = (o: Partial<Parameters<typeof action>[1]>) => narrow.w.engine.authorizeAndReserve(request(action(narrow.m, { authority: noMarkets, size: sizeFor(1_000), ...o }), narrow.states, narrow.ctx), ONCE);
    is(refused(await as({})), 'ACTION_NOT_COVERED', 'ACTION_TYPE_NOT_PERMITTED');
    is(refused(await as({ side: 'CLOSE' })), 'ACTION_NOT_COVERED', 'MARKETS_NOT_PERMITTED');

    const noOpen = await fixture();
    const reduceOnly = child(noOpen.r0, { mods: [noOpen.m], holder: AGENT_B, nonce: 6n });
    // Coverage terms grant both rights by default; a grant without OPEN_RISK:
    const reduceOnlyGrant = { ...reduceOnly, terms: reduceOnly.terms.filter((t) => !(t.kind === 'RIGHT' && t.right === 'OPEN_RISK')) } as typeof reduceOnly;
    assert.equal((await noOpen.w.engine.registerDelegation(reduceOnlyGrant, T0, ONCE)).status, 'REGISTERED');
    is(refused(await noOpen.w.engine.authorizeAndReserve(request(action(noOpen.m, { authority: reduceOnlyGrant, size: sizeFor(1_000) }), noOpen.states, noOpen.ctx), ONCE)), 'ACTION_NOT_COVERED', 'RIGHT_NOT_GRANTED');

    const bounded = await fixture([{ kind: 'BOUND', boundId: 'synth.order-leverage', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: 2n, scale: 0 } } }]);
    is(await bounded.attempt({ leverage: { numerator: 3n, scale: 0 } }), 'ACTION_NOT_COVERED', 'BOUND_EXCEEDED');
    const unknownBound = await fixture([{ kind: 'BOUND', boundId: 'synth.something-else', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: 2n, scale: 0 } } }]);
    is(await unknownBound.attempt(), 'ACTION_NOT_COVERED', 'BOUND_NOT_EVALUATED');
    const mismatched = await fixture([{ kind: 'BOUND', boundId: 'synth.order-leverage', polarity: 'MAX', value: { type: 'QUANTITY', quantity: { kind: 'NOTIONAL', unit: 'USD', decimals: 2, atoms: 1n } } }]);
    is(await mismatched.attempt(), 'ACTION_NOT_COVERED', 'BOUND_INCOMPARABLE');
    const windowed = await fixture([{ kind: 'TIME_WINDOW', domain: 'synth-perp', notBefore: T + 100n, expiresAt: T + 200n }]);
    is(await windowed.attempt(), 'ACTION_NOT_COVERED', 'OUTSIDE_TIME_WINDOW');
  });
});

describe('authority, demand and bounds', () => {
  it('actor, principal and lineage', async () => {
    const f = await fixture();
    is(await f.attempt({ actor: AGENT_B }), 'AUTHORITY_INVALID', 'ACTOR_NOT_HOLDER');
    const unknownLeaf = root({ mods: [f.m], holder: AGENT_B, nonce: 99n });
    is(await f.attempt({ authority: unknownLeaf }), 'AUTHORITY_INVALID', 'AUTHORITY_UNKNOWN');
    // An action names its principal, whose ledger is the one read: a principal with no policy authorizes nothing.
    const good = action(f.m, { authority: f.a, size: sizeFor(1_000) });
    const elsewhere = must(validateActionEnvelope({ ...actionEnvelopeInputOf(good.envelope), principal: address('77') }));
    const r = refused(await f.w.engine.authorizeAndReserve({ ...request(good, f.states, f.ctx), action: elsewhere, payload: good.payload }, ONCE));
    is(r, 'AUTHORITY_INVALID', 'PRINCIPAL_POLICY_MISSING');
    // Revoking an ancestor refuses every later decision under the subtree.
    const { validateRevocation } = await import('@mandate/ledger');
    const rev = must(validateRevocation({ target: authorityId(f.r0), issuer: P, effectiveAt: T0, nonce: 0n }));
    assert.equal((await f.w.ledger.revoke(f.r0.principal, rev, T0, ONCE)).status, 'COMMITTED');
    const revoked = await f.attempt();
    is(revoked, 'AUTHORITY_INVALID', 'AUTHORITY_REVOKED');
  });

  it('the ledger refuses what the lineage cannot hold, naming every failing leg', async () => {
    const f = await fixture();
    const r = await f.attempt({ size: sizeFor(6_000) });
    is(r, 'AUTHORITY_UNAVAILABLE', 'LEDGER_LIMIT_EXCEEDED');
    assert.equal(r.origin, 'LEDGER');
  });

  it('a required demand no lineage dimension bounds is unbounded (LEDGER-5)', async () => {
    const w = world();
    const m = w.modules[0] as SyntheticModule;
    const acct = account(m);
    const r0 = root({ mods: [m], holder: AGENT_A });
    await setup(w, policy([capitalDim('global', 1_000_000)]), [r0]);
    const r = refused(await w.engine.authorizeAndReserve(request(action(m, { authority: r0, size: sizeFor(1_000) }), marketStates(m, [{ account: acct }]), context([m], { accounts: [{ module: m, account: acct }] })), ONCE));
    is(r, 'AUTHORITY_UNAVAILABLE', 'UNBOUNDED_CONTRIBUTION');
  });

  it('context and resource bounds', async () => {
    const f = await fixture();
    const dup = { ...f.ctx, sources: [...f.ctx.sources, f.ctx.sources[0] as (typeof f.ctx.sources)[number]] };
    is(await f.attempt({}, dup), 'CONTEXT_INVALID', 'SOURCE_CONFIGURED_TWICE');
    // A later decision already committed at T + 100; one evaluated at T would backdate the ledger.
    assert.equal((await f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.a, size: sizeFor(100), nonce: 9n }), marketStates(f.m, [{ account: f.acct }], undefined, { observedAt: T + 100n }), { ...f.ctx, evaluationTime: T + 100n }), ONCE)).status, 'AUTHORIZED');
    is(await f.attempt(), 'CONTEXT_INVALID', 'EVALUATION_TIME_REGRESSED');
    const many = Array.from({ length: 129 }, () => f.states[0] as (typeof f.states)[number]);
    is(await f.attempt({}, f.ctx, many), 'RESOURCE_BOUND_EXCEEDED', 'TOO_MANY_STATES');
  });
});

describe('every code is produced by some test', () => {
  it('each CONTROL_CODE appears in an assertion in this package\'s tests', () => {
    const dir = new URL('./', import.meta.url);
    const text = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => readFileSync(new URL(f, dir), 'utf8'))
      .join('\n');
    for (const code of CONTROL_CODES) assert.match(text, new RegExp(`['"]${code}['"]`), code);
  });
});
