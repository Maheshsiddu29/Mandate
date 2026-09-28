/**
 * Identifiers, digests, parties, resources and the primitive parsers every
 * validator is built from. Every rejection is a structured error with a
 * stable code and the offending field's path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkFields,
  parseDigest,
  parseIdentifierAs,
  parseInteger,
  parseSmallUint,
  partyIdsEqual,
  principalAsAgent,
  resourceIdsEqual,
  validateAgentId,
  validatePartyId,
  validatePrincipalId,
  validateResourceId,
  RESOURCE_KINDS,
  UINT32_MAX,
  type CoreResult,
  type ResourceIdInput,
} from '../src/index.ts';
import { BTC, BTC_PERP_L, BTC_PERP_M, PRINCIPAL, TRADING_AGENT, USDG, digestOf, must } from './support/basics.ts';

function code<T>(r: CoreResult<T>): string {
  return r.ok ? 'OK' : r.error.code;
}

describe('digests', () => {
  const valid = digestOf('x');

  it('accept exactly 0x + 64 lowercase hex digits', () => {
    assert.equal(code(parseDigest(valid, 'd')), 'OK');
  });

  it('refuse uppercase, mixed case, short, long, unprefixed and non-string forms rather than normalizing them', () => {
    for (const bad of [valid.toUpperCase(), `0x${valid.slice(2, 10).toUpperCase()}${valid.slice(10)}`, valid.slice(0, 65), `${valid}0`, valid.slice(2), `0X${valid.slice(2)}`, '']) {
      assert.equal(code(parseDigest(bad, 'd')), 'MALFORMED_DIGEST', bad);
    }
    assert.equal(code(parseDigest(42 as unknown as string, 'd')), 'WRONG_TYPE');
  });
});

describe('identifiers', () => {
  it('use the kernel charset and refuse anything outside it', () => {
    assert.equal(code(parseIdentifierAs('perp-policy', 'x')), 'OK');
    assert.equal(code(parseIdentifierAs('venue-l:BTC-PERP', 'x')), 'OK');
    for (const bad of ['', ' perp', 'perp ', '-perp', 'perp.', 'pérp', 'a'.repeat(129), 'perp policy']) {
      assert.equal(code(parseIdentifierAs(bad, 'x')), 'MALFORMED_IDENTIFIER', bad);
    }
  });
});

describe('integers', () => {
  it('accept a bigint or a canonical decimal string', () => {
    assert.deepEqual(parseInteger(12n, 'n'), { ok: true, value: 12n });
    assert.deepEqual(parseInteger('-12', 'n'), { ok: true, value: -12n });
    assert.deepEqual(parseInteger('0', 'n'), { ok: true, value: 0n });
  });

  it('refuse a JavaScript number, whatever its magnitude', () => {
    for (const n of [1, 0, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      assert.equal(code(parseInteger(n as unknown as bigint, 'n')), 'NUMBER_NOT_PERMITTED');
    }
  });

  it('refuse non-canonical decimal strings', () => {
    for (const bad of ['01', '+1', '-0', '1e3', '1.0', ' 1', '1 ', '', '0x10', '１']) {
      assert.equal(code(parseInteger(bad, 'n')), 'NON_CANONICAL_INTEGER', bad);
    }
  });

  it('bound the length of a decimal string before converting it', () => {
    assert.equal(code(parseInteger('9'.repeat(81), 'n')), 'INTEGER_OUT_OF_RANGE');
  });

  it('small fields refuse NaN, infinities, fractions, unsafe integers and out-of-range values distinctly', () => {
    assert.equal(code(parseSmallUint(Number.NaN, 10, 'n')), 'NON_FINITE_NUMBER');
    assert.equal(code(parseSmallUint(Number.POSITIVE_INFINITY, 10, 'n')), 'NON_FINITE_NUMBER');
    assert.equal(code(parseSmallUint(1.5, 10, 'n')), 'NON_INTEGER');
    assert.equal(code(parseSmallUint(2 ** 53, Number.MAX_VALUE, 'n')), 'UNSAFE_INTEGER');
    assert.equal(code(parseSmallUint(-1, 10, 'n')), 'INTEGER_OUT_OF_RANGE');
    assert.equal(code(parseSmallUint(UINT32_MAX + 1, UINT32_MAX, 'n')), 'INTEGER_OUT_OF_RANGE');
    assert.equal(code(parseSmallUint('3' as unknown as number, 10, 'n')), 'WRONG_TYPE');
  });
});

describe('closed-world object shapes', () => {
  it('refuse an unknown field, naming it', () => {
    const r = checkFields({ a: 1, b: 2, c: 3 }, ['a', 'b'], 'obj');
    assert.deepEqual(r, { ok: false, error: { code: 'UNKNOWN_FIELD', path: 'obj.c' } });
  });

  it('refuse a missing field and an explicitly undefined one alike: absence is spelled null', () => {
    assert.deepEqual(checkFields({ a: 1 }, ['a', 'b'], 'obj'), { ok: false, error: { code: 'MISSING_FIELD', path: 'obj.b' } });
    assert.deepEqual(checkFields({ a: 1, b: undefined }, ['a', 'b'], 'obj'), { ok: false, error: { code: 'MISSING_FIELD', path: 'obj.b' } });
    assert.equal(code(checkFields({ a: 1, b: null }, ['a', 'b'], 'obj')), 'OK');
  });

  it('refuse arrays and primitives where an object is expected', () => {
    assert.equal(code(checkFields([] as object, [], 'obj')), 'WRONG_TYPE');
    assert.equal(code(checkFields('x' as unknown as object, [], 'obj')), 'WRONG_TYPE');
  });
});

describe('parties', () => {
  it('reuse the kernel PartyId rule, including the eip155 address shape', () => {
    assert.equal(code(validatePartyId(PRINCIPAL, 'p')), 'OK');
    assert.equal(code(validatePartyId({ kind: 'eip155-address', value: '0xABC' }, 'p')), 'MALFORMED_PARTY');
    assert.equal(code(validatePartyId({ kind: 'eip155-address', value: `0x${'AB'.repeat(20)}` }, 'p')), 'MALFORMED_PARTY');
    assert.equal(code(validatePartyId({ kind: 'eip155-address' } as never, 'p')), 'MISSING_FIELD');
  });

  it('carry a role: a principal becomes an agent only through the explicit conversion', () => {
    const principal = must(validatePrincipalId(PRINCIPAL, 'p'));
    const agent = must(validateAgentId(TRADING_AGENT, 'a'));
    const principalActing = principalAsAgent(principal);
    assert.ok(partyIdsEqual(principalActing, principal));
    assert.ok(!partyIdsEqual(agent, principal));
  });
});

describe('resources', () => {
  it('are (domain, kind, localId), compared exactly: one instrument on two venues is two markets', () => {
    const l = must(validateResourceId(BTC_PERP_L, ['MARKET'], 'm'));
    const m = must(validateResourceId(BTC_PERP_M, ['MARKET'], 'm'));
    assert.ok(!resourceIdsEqual(l, m));
    assert.ok(resourceIdsEqual(l, must(validateResourceId({ ...BTC_PERP_L }, ['MARKET'], 'm'))));
  });

  it('keep canonical assets and token representations distinct kinds (INV-6)', () => {
    const canonical = must(validateResourceId(BTC, ['CANONICAL_ASSET', 'REPRESENTATION_ASSET'], 'a'));
    const token = must(validateResourceId(USDG, ['CANONICAL_ASSET', 'REPRESENTATION_ASSET'], 'a'));
    assert.equal(canonical.kind, 'CANONICAL_ASSET');
    assert.equal(token.kind, 'REPRESENTATION_ASSET');
    const sameIdOtherForm: ResourceIdInput = { ...BTC, kind: 'REPRESENTATION_ASSET' };
    assert.ok(!resourceIdsEqual(canonical, must(validateResourceId(sameIdOtherForm, RESOURCE_KINDS, 'a'))));
  });

  it('refuse a kind the slot does not accept, and an unknown kind', () => {
    assert.deepEqual(validateResourceId(BTC, ['MARKET'], 'market'), { ok: false, error: { code: 'RESOURCE_KIND_MISMATCH', path: 'market.kind' } });
    assert.equal(code(validateResourceId({ ...BTC, kind: 'ASSET' as never }, RESOURCE_KINDS, 'r')), 'UNKNOWN_ENUM_VALUE');
  });
});
