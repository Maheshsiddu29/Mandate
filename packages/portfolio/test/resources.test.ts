/**
 * Resources: every amount carries its declared measure, only the same
 * resource combines, and a domain quantity reaches a resource only by Core's
 * matching rule — so economically incomparable quantities are never summed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAmounts,
  addVectors,
  amountOf,
  demandOf,
  exceeding,
  resourceTable,
  subtractVectors,
  undeclared,
  validateResourceDefinitions,
  validateResourceVector,
  vectorsEqual,
  type Contribution,
} from '../src/index.ts';
import { RESOURCES, USDC6, codeOf, must } from './support/mandate.ts';

const table = resourceTable(must(validateResourceDefinitions([...RESOURCES, { resource: 'usd-notional', kind: 'NOTIONAL', unit: 'USD', decimals: 2, domain: null }], 'r')));
const vec = (entries: [string, bigint][]) => must(validateResourceVector(entries.map(([resource, atoms]) => ({ resource, atoms })), 'v'));
const c = (kind: Contribution['kind'], unit: string, decimals: number, atoms: bigint, domain: string): Contribution => ({ kind, unit, decimals, atoms, domain });

describe('resources are typed and never summed across measures', () => {
  it('spot capital and perp margin, both in USDC, are two resources and cannot be added', () => {
    const [capital, margin] = [vec([['spot-capital', USDC6(10n)]]), vec([['perp-margin', USDC6(10n)]])];
    const sum = addAmounts(capital[0] as never, margin[0] as never);
    assert.deepEqual(sum.ok ? 'added' : sum.error, { code: 'RESOURCE_INCOMPARABLE', subject: 'spot-capital+perp-margin' });
    // Vector addition keeps them apart: two entries, never one number.
    assert.deepEqual(addVectors(capital, margin).map((a) => [a.resource, a.atoms]), [['perp-margin', USDC6(10n)], ['spot-capital', USDC6(10n)]]);
  });

  it('NOTIONAL in USDC and NOTIONAL in USD are two resources', () => {
    const usdc = vec([['portfolio-notional', 1n]]);
    const usd = vec([['usd-notional', 1n]]);
    assert.equal(addAmounts(usdc[0] as never, usd[0] as never).ok, false);
    const d = must(demandOf(table, [c('NOTIONAL', 'USD', 2, 100n, 'swap-fixture')]));
    assert.equal(amountOf(d, 'portfolio-notional'), 0n);
    assert.equal(amountOf(d, 'usd-notional'), 100n);
  });

  it('a contribution counts toward every resource it matches, by kind, unit and domain scope — as the ledger charges', () => {
    const perp = must(demandOf(table, [c('NOTIONAL', 'USDC', 6, USDC6(400n), 'lighter-perp'), c('MARGIN', 'USDC', 6, USDC6(201n), 'lighter-perp'), c('COUNT', 'COUNT', 0, 1n, 'lighter-perp')]));
    assert.deepEqual(perp.map((a) => [a.resource, a.atoms]), [['perp-margin', USDC6(201n)], ['portfolio-notional', USDC6(400n)], ['derivative-notional', USDC6(400n)]]);
    const spot = must(demandOf(table, [c('NOTIONAL', 'USDC', 6, USDC6(600n), 'robinhood-evm'), c('CAPITAL', 'USDC', 6, USDC6(600n), 'robinhood-evm')]));
    assert.equal(amountOf(spot, 'derivative-notional'), 0n, 'a domain-scoped resource ignores other domains');
    assert.equal(amountOf(spot, 'perp-margin'), 0n, 'capital is not margin');
    assert.equal(amountOf(spot, 'spot-capital'), USDC6(600n));
  });

  it('rescales exactly or refuses: no rounding direction exists', () => {
    assert.equal(amountOf(must(demandOf(table, [c('NOTIONAL', 'USDC', 2, 150n, 'swap-fixture')])), 'portfolio-notional'), 1_500_000n);
    const inexact = demandOf(table, [c('NOTIONAL', 'USDC', 8, 123n, 'swap-fixture')]);
    assert.deepEqual(inexact.ok ? 'ok' : inexact.error, { code: 'RESOURCE_INCOMPARABLE', subject: 'portfolio-notional' });
  });

  it('closed world: an unlimited resource has limit zero; undeclared resources are named', () => {
    assert.deepEqual(exceeding(vec([['perp-margin', 1n], ['portfolio-notional', 5n]]), vec([['portfolio-notional', 5n]])), ['perp-margin']);
    assert.deepEqual(undeclared(vec([['made-up', 1n]]), table), [{ code: 'RESOURCE_UNDECLARED', subject: 'made-up' }]);
  });

  it('subtraction never goes negative; equality compares per resource', () => {
    const a = vec([['portfolio-notional', 10n]]);
    assert.equal(subtractVectors(a, vec([['portfolio-notional', 11n]])).ok, false);
    assert.equal(subtractVectors(a, vec([['perp-margin', 1n]])).ok, false);
    assert.ok(vectorsEqual(must(subtractVectors(a, vec([['portfolio-notional', 10n]]))), vec([])));
  });

  it('a vector refuses a second entry for one resource instead of summing it', () => {
    const r = validateResourceVector([{ resource: 'portfolio-notional', atoms: 1n }, { resource: 'portfolio-notional', atoms: 2n }], 'v');
    assert.equal(codeOf(r), 'DUPLICATE_SET_MEMBER');
  });
});
