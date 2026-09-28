/**
 * The 7D extension point: a configured `InvariantOrdering` lets the reducer
 * accept a restated invariant whose parameters its definition proves no
 * weaker (authority-model.md §4, "parameters no weaker").
 *
 * What must hold: without an ordering nothing changes from 7C; with one, the
 * reducer — at commit and at replay — asks it and never an input; a failing
 * or dishonest comparator can only refuse; and a history that relied on a
 * proof does not replay without it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StateInvariantInput, StateInvariantTerm } from '@mandate/core';
import {
  AuthorityLedger,
  CORE_RULES,
  InMemoryLedgerStore,
  checkDelegationSubset,
  encodeBatch,
  replay,
  replayEncoded,
  type InvariantNarrowing,
  type InvariantOrdering,
  type LedgerRefusal,
  type ReducerRules,
} from '../src/index.ts';
import { ALL_MODULES, DELEGATE, ONCE, PRINCIPAL, REGISTRY, T0, TRADING, child, committed, policy, refused, root } from './support/fixtures.ts';

const leverage = (params: string): StateInvariantInput => ({ kind: 'STATE_INVARIANT', invariantId: 'perp.accountLeverage', version: 1, scope: [], params });

/** A test ordering over one-byte parameters: a lower byte is narrower. It records every question it is asked. */
function byteOrdering(asked: [string, string][] = []): InvariantOrdering {
  return {
    noWeaker(parent: StateInvariantTerm, c: StateInvariantTerm): InvariantNarrowing {
      asked.push([parent.params, c.params]);
      if (parent.invariantId !== 'perp.accountLeverage') return 'UNPROVABLE';
      return BigInt(c.params) <= BigInt(parent.params) ? 'NO_WEAKER' : 'WEAKER';
    },
  };
}

function rulesWith(ordering: InvariantOrdering): ReducerRules {
  return { invariantOrdering: ordering };
}

function violations(r: LedgerRefusal): string[] {
  assert.equal(r.code, 'DELEGATION_REFUSED');
  return r.code === 'DELEGATION_REFUSED' ? r.violations.map((v) => v.code) : [];
}

function ledgerWith(rules: ReducerRules): { store: InMemoryLedgerStore; ledger: AuthorityLedger } {
  const store = new InMemoryLedgerStore({}, rules);
  return { store, ledger: new AuthorityLedger(store, REGISTRY, rules) };
}

const parentGrant = root({ holder: TRADING, terms: [ALL_MODULES, DELEGATE(2), leverage('0x04')] });

describe('invariant ordering (7D extension point)', () => {
  it('without an ordering, 7C behaviour is unchanged: different parameters are unproven', () => {
    const c = child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] });
    assert.deepEqual(checkDelegationSubset(parentGrant, c, 2).map((v) => v.code), ['DELEGATION_NARROWING_UNPROVEN']);
    assert.deepEqual(checkDelegationSubset(parentGrant, c, 2, null).map((v) => v.code), ['DELEGATION_NARROWING_UNPROVEN']);
    assert.equal(CORE_RULES.invariantOrdering, null);
    assert.ok(Object.isFrozen(CORE_RULES));
  });

  it('a proven narrowing is accepted, a proven widening is DELEGATION_WEAKENS_INVARIANT', () => {
    const o = byteOrdering();
    assert.deepEqual(checkDelegationSubset(parentGrant, child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] }), 2, o), []);
    assert.deepEqual(
      checkDelegationSubset(parentGrant, child(parentGrant, { terms: [ALL_MODULES, leverage('0x05')] }), 2, o).map((v) => v.code),
      ['DELEGATION_WEAKENS_INVARIANT'],
    );
  });

  it('is asked only for a restated invariant whose parameters differ', () => {
    const asked: [string, string][] = [];
    const o = byteOrdering(asked);
    checkDelegationSubset(parentGrant, child(parentGrant, { terms: [ALL_MODULES, leverage('0x04')] }), 2, o);
    assert.deepEqual(asked, []);
    checkDelegationSubset(parentGrant, child(parentGrant, { terms: [ALL_MODULES, leverage('0x02')] }), 2, o);
    assert.deepEqual(asked, [['0x04', '0x02']]);
  });

  it('a comparator that throws or answers outside the vocabulary can only refuse', () => {
    const thrower: InvariantOrdering = {
      noWeaker() {
        throw new Error('comparator fault');
      },
    };
    const junk = { noWeaker: () => 'YES' } as unknown as InvariantOrdering;
    const c = child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] });
    for (const o of [thrower, junk]) assert.deepEqual(checkDelegationSubset(parentGrant, c, 2, o).map((v) => v.code), ['DELEGATION_NARROWING_UNPROVEN']);
  });

  it('dropping the invariant is still refused whatever the ordering says', () => {
    const always: InvariantOrdering = { noWeaker: () => 'NO_WEAKER' };
    const c = child(parentGrant, { terms: [ALL_MODULES] });
    assert.deepEqual(checkDelegationSubset(parentGrant, c, 2, always).map((v) => v.code), ['DELEGATION_DROPS_INVARIANT']);
  });

  it('the store applies its configured ordering at commit; the engine refuses the same way before writing', async () => {
    const narrow = child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] });
    const wide = child(parentGrant, { terms: [ALL_MODULES, leverage('0x05')], nonce: 1n });

    const plain = ledgerWith(CORE_RULES);
    committed(await plain.ledger.registerPolicy(policy(), T0, ONCE));
    committed(await plain.ledger.registerGrant(parentGrant, T0, ONCE));
    assert.deepEqual(violations(refused(await plain.ledger.registerGrant(narrow, T0, ONCE))), ['DELEGATION_NARROWING_UNPROVEN']);

    const ordered = ledgerWith(rulesWith(byteOrdering()));
    committed(await ordered.ledger.registerPolicy(policy(), T0, ONCE));
    committed(await ordered.ledger.registerGrant(parentGrant, T0, ONCE));
    committed(await ordered.ledger.registerGrant(narrow, T0, ONCE));
    assert.deepEqual(violations(refused(await ordered.ledger.registerGrant(wide, T0, ONCE))), ['DELEGATION_WEAKENS_INVARIANT']);

    // A writer bypassing the engine meets the same rule inside the store's critical section.
    const s = await ordered.store.read(PRINCIPAL);
    const direct = await ordered.store.compareAndAppend(PRINCIPAL, s.version, s.head, [{ kind: 'REGISTER_GRANT', at: T0, grant: wide }]);
    assert.equal(direct.status, 'REFUSED');
  });

  it('a history that relied on a proof replays under the ordering and refuses without it', async () => {
    const rules = rulesWith(byteOrdering());
    const { store, ledger } = ledgerWith(rules);
    committed(await ledger.registerPolicy(policy(), T0, ONCE));
    committed(await ledger.registerGrant(parentGrant, T0, ONCE));
    committed(await ledger.registerGrant(child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] }), T0, ONCE));
    const history = await store.history(PRINCIPAL);
    const events = history.map((b) => b.events);
    const bytes = history.map((b) => b.encoded);

    const withOrdering = replay(PRINCIPAL, events, rules);
    assert.ok(withOrdering.ok);
    assert.ok(replayEncoded(PRINCIPAL, bytes, rules).ok);
    for (const r of [replay(PRINCIPAL, events), replayEncoded(PRINCIPAL, bytes)]) {
      assert.ok(!r.ok);
      if (!r.ok) assert.deepEqual(violations(r.error), ['DELEGATION_NARROWING_UNPROVEN']);
    }
  });

  it('no event carries a verdict: the registration bytes are the same with or without an ordering', async () => {
    const narrow = child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] });
    const event = { kind: 'REGISTER_GRANT', at: T0, grant: narrow } as const;
    assert.deepEqual(Object.keys(event).sort(), ['at', 'grant', 'kind']);
    const { store, ledger } = ledgerWith(rulesWith(byteOrdering()));
    committed(await ledger.registerPolicy(policy(), T0, ONCE));
    committed(await ledger.registerGrant(parentGrant, T0, ONCE));
    const before = await store.read(PRINCIPAL);
    committed(await ledger.registerGrant(narrow, T0, ONCE));
    const stored = (await store.history(PRINCIPAL)).at(-1);
    assert.ok(stored !== undefined);
    assert.deepEqual(stored.encoded, encodeBatch(PRINCIPAL, stored.version, before.head, [event]));
  });
});
