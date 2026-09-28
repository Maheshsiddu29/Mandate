/**
 * Testnet-derived fixtures, offline (Phase 7E.1 §43). Each fixture is a raw,
 * unmodified Lighter testnet response pinned by digest, with its endpoint,
 * capture time and the SDK/API version it was read under. The tests tie the
 * reviewed market claims to the captured metadata, normalize the captured
 * transactions into the structure 7F will consume, and record what the probes
 * showed. The real hash reproduction runs with the Go custody:
 * `npm run lighter:custody:check`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccakDigest } from '@mandate/core';
import { LIGHTER_TESTNET_CLAIMS, marketStaticOf, txRecordOf, parseJson } from '../src/index.ts';

const dir = new URL('./fixtures/', import.meta.url);
const raw = (f: string) => readFileSync(new URL(f, dir));
const PINNED = {
  'testnet-order-book-details.json': '0xf4b8e7481594bb5450b931a3a199530ad02e0a89faa335fb1315faf3e0ad45ed',
  'testnet-transactions.json': '0x0fc144a2a4a55103171393e81badd157d547cc36d523de24c35c033396fff972',
  'testnet-probes.json': '0x8fb34e9bb182bd8d1f0ac83c043114eaa57bf6b55a7f2b5eee55684cbd5ebb8b',
} as const;

interface Obd { meta: { capturedAt: string }; response: { order_book_details: never[] } }
interface Txs { records: never[]; lookup: { response: never } }
interface Probes { sendTx: { response: { code: number; message: string } }; nextNonceOfNonexistentAccount: { response: { code: number; nonce: number } } }

describe('testnet fixtures', () => {
  it('are pinned: a changed fixture is a reviewed change', () => {
    for (const [f, digest] of Object.entries(PINNED)) assert.equal(keccakDigest(raw(f)), digest, f);
  });

  it('the reviewed market claims are exactly the captured orderBookDetails metadata', () => {
    const obd = JSON.parse(raw('testnet-order-book-details.json').toString()) as Obd;
    for (const claim of LIGHTER_TESTNET_CLAIMS) {
      const entry = obd.response.order_book_details.find((e: { market_id: number }) => e.market_id === claim.static.marketIndex);
      assert.ok(entry !== undefined, `market ${claim.static.marketIndex} captured`);
      assert.deepEqual(marketStaticOf(entry, 300), claim.static);
    }
  });

  it('normalizes captured transactions: every executed tx is status 3, with no Ethereum commitment or verification', () => {
    const txs = JSON.parse(raw('testnet-transactions.json').toString()) as Txs;
    const records = txs.records.map((r) => txRecordOf(r));
    for (const r of records) {
      assert.ok(r !== null);
      assert.equal(r?.status, 3);
      assert.equal(r?.committedAt, 0n);
      assert.equal(r?.verifiedAt, 0n);
    }
    const [first] = records;
    assert.equal(first?.hash, '1cf4401208f19c7c421a3f07b3be3f03e51e6fc15e27119493a91c206c261f2528ace2e2608004c5');
    assert.deepEqual([first?.accountIndex, first?.apiKeyIndex, first?.nonce], [7n, 4, 1n]);
    // The SDK's default deadline, seen in the wild: ExpiredAt = signing time + 599 s, a little under 600 s after queueing.
    const window = first?.expireAt !== null && first?.expireAt !== undefined ? first.expireAt - first.queuedAt : -1n;
    assert.ok(window > 590_000n && window <= 600_000n, String(window));
    // An IOC limit order filled in its own transaction; the trade carries a fee *rate* in 1e-6 units.
    assert.equal(first?.takerOrder?.status, 'filled');
    assert.equal(first?.takerOrder?.remainingBaseAmount, 0n);
    assert.equal(first?.trade?.takerFeeRate, 280n);
    const lookup = txRecordOf(txs.lookup.response);
    assert.ok(lookup !== null && lookup.committedAt === 0n && lookup.verifiedAt === 0n);
  });

  it('an internal cancel (type 22) names the cancelled order by venue and client index', () => {
    const txs = JSON.parse(raw('testnet-transactions.json').toString()) as Txs;
    const cancel = txs.records.map((r) => r as { type: number; event_info: string }).find((r) => r.type === 22);
    assert.ok(cancel !== undefined);
    const ev = parseJson(cancel.event_info) as { i: number; u: number; ae: string };
    assert.ok(Number.isSafeInteger(ev.i) && Number.isSafeInteger(ev.u) && ev.ae === '');
  });

  it('records what the probes showed: an unknown account is refused at the API; nextNonce does not prove an account exists', () => {
    const p = JSON.parse(raw('testnet-probes.json').toString()) as Probes;
    assert.deepEqual(p.sendTx.response, { code: 21100, message: 'account not found' });
    assert.deepEqual(p.nextNonceOfNonexistentAccount.response, { code: 200, nonce: 0 });
  });
});
