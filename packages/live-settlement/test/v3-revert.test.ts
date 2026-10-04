import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ERC20_INSUFFICIENT_BALANCE_SELECTOR,
  classifyV3SimulationRevert,
  decodeErc20InsufficientBalance,
} from '../src/v3/revert.ts';

const VENUE = '0xfb6d93beb3e800f44d4253a0805af257ca0e9855';
const PRINCIPAL = '0xdea526b6c506e612a4177ad3a88c3dcc6d524fe1';
const LIVE_REVERT = '0xe450d38c000000000000000000000000fb6d93beb3e800f44d4253a0805af257ca0e9855000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000058d15e1762800000';

describe('V3 simulation revert decoding', () => {
  it('decodes the complete live ERC20InsufficientBalance evidence', () => {
    const d = decodeErc20InsufficientBalance(LIVE_REVERT);
    assert.ok(d);
    assert.equal(ERC20_INSUFFICIENT_BALANCE_SELECTOR, '0xe450d38c');
    assert.equal(d.sender, VENUE);
    assert.equal(d.balance, 0n);
    assert.equal(d.needed, 6_400_000_000_000_000_000n);
    assert.equal(d.rawRevert, LIVE_REVERT);
  });

  it('classifies the venue separately from the principal and preserves raw evidence', () => {
    const venue = classifyV3SimulationRevert(LIVE_REVERT, PRINCIPAL, VENUE);
    assert.equal(venue.code, 'V3_FIXTURE_INVENTORY_INSUFFICIENT');
    assert.equal(venue.detail?.rawRevert, LIVE_REVERT);

    const principalRevert = LIVE_REVERT.replace(VENUE.slice(2), PRINCIPAL.slice(2));
    assert.equal(
      classifyV3SimulationRevert(principalRevert, PRINCIPAL, VENUE).code,
      'V3_PRINCIPAL_BALANCE_INSUFFICIENT',
    );
    assert.match(classifyV3SimulationRevert('0xdeadbeef', PRINCIPAL, VENUE).code, /^SIMULATION_REVERT\./);
  });

  it('rejects truncated or non-canonical balance error payloads', () => {
    assert.equal(decodeErc20InsufficientBalance('0xe450d38c'), null);
    assert.equal(decodeErc20InsufficientBalance(`${LIVE_REVERT}00`), null);
    assert.equal(decodeErc20InsufficientBalance(`0xdeadbeef${LIVE_REVERT.slice(10)}`), null);
  });
});
