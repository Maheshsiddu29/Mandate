import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOnchainTokenObservation, type RawOnchainTokenObservation } from '../src/onchain.ts';
import { deriveCorporateActionEpoch, parseMultiplierEvent, UI_MULTIPLIER_UPDATED_TOPIC } from '../src/epoch.ts';

const word = (value: bigint) => value.toString(16).padStart(64, '0');
const resultWord = (value: bigint) => `0x${word(value)}`;
function abiString(value: string): string {
  const body = Buffer.from(value).toString('hex');
  return `0x${word(32n)}${word(BigInt(body.length / 2))}${body.padEnd(Math.ceil(body.length / 64) * 64, '0')}`;
}
function token(multiplier: bigint, blockTimestamp = 1_790_289_408n) {
  const raw: RawOnchainTokenObservation = {
    chainId: '0x1237', blockNumber: '0x4468e5a', blockTimestamp: `0x${blockTimestamp.toString(16)}`,
    contractAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', code: '0x6000',
    symbolResult: abiString('NVDA'), nameResult: abiString('NVIDIA • Robinhood Token'), decimalsResult: resultWord(18n),
    uidResult: '0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5',
    uiMultiplierResult: resultWord(multiplier), newUIMultiplierResult: resultWord(multiplier),
    effectiveAtResult: resultWord(1_788_998_430n), oraclePausedResult: resultWord(0n),
  };
  const parsed = parseOnchainTokenObservation(raw);
  if (!parsed.ok) throw new Error('token fixture must parse');
  return parsed.value;
}
function event(oldMultiplier: bigint, newMultiplier: bigint, effectiveAt: bigint, block = 100n) {
  const parsed = parseMultiplierEvent({
    address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', topics: [UI_MULTIPLIER_UPDATED_TOPIC],
    data: `0x${word(oldMultiplier)}${word(newMultiplier)}${word(effectiveAt)}`,
    blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${'ab'.repeat(32)}`, logIndex: '0x0', removed: false,
  });
  if (!parsed.ok) throw new Error('event fixture must parse');
  return parsed.value;
}

describe('corporate-action epoch authority', () => {
  test('initial multiplier with no event has epoch zero', () => {
    assert.deepEqual(deriveCorporateActionEpoch(token(1_000_000_000_000_000_000n), []), { ok: true, value: 0n });
  });

  test('completed multiplier event advances epoch to effectiveAt', () => {
    const changed = 1_000_775_159_164_630_595n;
    assert.deepEqual(
      deriveCorporateActionEpoch(token(changed), [event(1_000_000_000_000_000_000n, changed, 1_788_998_430n)]),
      { ok: true, value: 1_788_998_430n },
    );
  });

  test('pending future event does not advance current epoch', () => {
    const current = 1_000_775_159_164_630_595n;
    const completed = event(1_000_000_000_000_000_000n, current, 1_788_998_430n);
    const pending = event(current, 2_000_000_000_000_000_000n, 1_800_000_000n, 200n);
    assert.deepEqual(deriveCorporateActionEpoch(token(current), [completed, pending]), { ok: true, value: 1_788_998_430n });
  });

  test('missing history, conflicting timestamp and current mismatch fail closed', () => {
    assert.equal(deriveCorporateActionEpoch(token(2_000_000_000_000_000_000n), []).ok, false);
    const one = event(1n, 2n, 100n);
    const conflict = event(1n, 3n, 100n, 101n);
    assert.equal(deriveCorporateActionEpoch(token(2n), [one, conflict]).ok, false);
    assert.equal(deriveCorporateActionEpoch(token(3n), [one]).ok, false);
  });

  test('removed or malformed logs reject', () => {
    const raw = {
      address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', topics: [UI_MULTIPLIER_UPDATED_TOPIC],
      data: `0x${word(1n)}${word(2n)}${word(3n)}`, blockNumber: '0x1', transactionHash: `0x${'ab'.repeat(32)}`,
      logIndex: '0x0', removed: true,
    };
    assert.equal(parseMultiplierEvent(raw).ok, false);
  });
});
