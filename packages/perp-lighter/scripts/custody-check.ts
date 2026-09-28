/**
 * `npm run lighter:custody:check` — offline, but needs the built Go custody
 * (`npm run lighter:custody:build`, which needs Go and the pinned modules).
 * Not part of `npm run check`, which stays Go-free and reproducible.
 *
 * 1. Real hash reproduction: every create-order in the pinned testnet fixture
 *    is re-hashed by the custody process from its published fields, and must
 *    equal the hash Lighter published — the exact artifact identity
 *    ADMIT_ATTEMPT commits.
 * 2. Custody's own refusals, before the key is touched: forbidden types, a
 *    foreign account or key, an uncommitted hash, a generic sign operation,
 *    and a second, different transaction for a nonce slot already signed.
 * 3. One full issuance through the real custody (fake venue, SQLite ledger):
 *    the signed transaction's hash is the one ADMIT_ATTEMPT committed.
 *
 * Keys are disposable, generated into a temporary directory and deleted.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoKeyCustody, type CustodyTx } from '../src/index.ts';

const BIN = 'packages/perp-lighter/custody/bin/lighter-custody';
const dir = mkdtempSync(join(tmpdir(), 'mandate-custody-check-'));

interface Info {
  AccountIndex: number;
  ApiKeyIndex: number;
  MarketIndex: number;
  ClientOrderIndex: number;
  BaseAmount: number;
  Price: number;
  IsAsk: number;
  Type: number;
  TimeInForce: number;
  ReduceOnly: number;
  OrderExpiry: number;
  ExpiredAt: number;
  Nonce: number;
  L2TxAttributes: { [k: string]: number } | null;
}

function keygen(name: string): string {
  const file = join(dir, `${name}.lighter-key`);
  const r = spawnSync(BIN, ['keygen', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return file;
}

function custodyFor(account: bigint, apiKey: number, name: string): GoKeyCustody {
  return new GoKeyCustody({ binary: BIN, keyFile: keygen(name), chainId: 300, accountIndex: account, apiKeyIndex: apiKey, journal: join(dir, `${name}.journal`) });
}

function txOf(i: Info): CustodyTx {
  const a = i.L2TxAttributes ?? {};
  return {
    type: 'CREATE_ORDER', chainId: 300, accountIndex: BigInt(i.AccountIndex), apiKeyIndex: i.ApiKeyIndex, marketIndex: i.MarketIndex, clientOrderIndex: BigInt(i.ClientOrderIndex), baseAmount: BigInt(i.BaseAmount), price: BigInt(i.Price),
    isAsk: i.IsAsk, orderType: i.Type, timeInForce: i.TimeInForce, reduceOnly: i.ReduceOnly, orderExpiry: BigInt(i.OrderExpiry), cancelIndex: 0n, expiredAt: BigInt(i.ExpiredAt), nonce: BigInt(i.Nonce),
    selfTradeBehavior: a['6'] ?? 0, selfTradeEquality: a['7'] ?? 0,
  };
}

async function main(): Promise<void> {
  const fixture = JSON.parse(readFileSync('packages/perp-lighter/test/fixtures/testnet-transactions.json', 'utf8')) as { records: { type: number; hash: string; info: string }[] };
  let reproduced = 0;
  let skipped = 0;
  for (const r of fixture.records.filter((x) => x.type === 14)) {
    const info = JSON.parse(r.info) as Info;
    const attrs = Object.keys(info.L2TxAttributes ?? {});
    if (attrs.some((k) => k !== '6' && k !== '7')) {
      // Integrator attributes: custody never signs them, so it does not hash them either.
      skipped += 1;
      continue;
    }
    const c = custodyFor(BigInt(info.AccountIndex), info.ApiKeyIndex, `vector-${reproduced}`);
    const h = await c.hash(txOf(info));
    c.close();
    assert.ok(h.ok, h.ok ? '' : h.error);
    assert.equal(h.value.hash, r.hash, `hash of ${r.hash}`);
    reproduced += 1;
  }
  process.stdout.write(`1. reproduced ${reproduced} real testnet transaction hashes (${skipped} skipped: integrator attributes)\n`);

  const c = custodyFor(281_474_976_710_600n, 5, 'refusals');
  const base: CustodyTx = { type: 'CREATE_ORDER', chainId: 300, accountIndex: 281_474_976_710_600n, apiKeyIndex: 5, marketIndex: 4096, clientOrderIndex: 7n, baseAmount: 100n, price: 836_250n, isAsk: 0, orderType: 0, timeInForce: 0, reduceOnly: 0, orderExpiry: 0n, cancelIndex: 0n, expiredAt: 1_790_637_000_000n, nonce: 3n, selfTradeBehavior: 1, selfTradeEquality: 0 };
  for (const type of ['WITHDRAW', 'TRANSFER', 'MINT_SHARES', 'CHANGE_PUB_KEY', 'UPDATE_LEVERAGE']) {
    const r = await c.hash({ ...base, type });
    assert.ok(!r.ok && r.error === 'TX_TYPE_FORBIDDEN', type);
  }
  const foreign = await c.hash({ ...base, accountIndex: 1n });
  assert.ok(!foreign.ok && foreign.error === 'TX_BINDING_MISMATCH');
  const h = await c.hash(base);
  assert.ok(h.ok);
  const uncommitted = await c.sign(base, '00'.repeat(40), 'x');
  assert.ok(!uncommitted.ok && uncommitted.error === 'HASH_NOT_COMMITTED');
  const signed = await c.sign(base, h.value.hash, 'attempt-1');
  assert.ok(signed.ok && signed.value.hash === h.value.hash && JSON.parse(signed.value.txInfo).Nonce === 3);
  const same = await c.sign(base, h.value.hash, 'attempt-1');
  assert.ok(same.ok, 'the identical transaction may be re-signed: it is the same artifact');
  const other = { ...base, baseAmount: 101n };
  const otherHash = await c.hash(other);
  assert.ok(otherHash.ok);
  const slot = await c.sign(other, otherHash.value.hash, 'attempt-2');
  assert.ok(!slot.ok && slot.error === 'SLOT_ALREADY_SIGNED');
  c.close();
  const generic = spawnSync(BIN, [], { input: '{"op":"signBytes","bytes":"00"}\n', encoding: 'utf8', env: { LIGHTER_CUSTODY_KEY_FILE: keygen('generic'), LIGHTER_CUSTODY_CHAIN_ID: '300', LIGHTER_CUSTODY_ACCOUNT_INDEX: '1', LIGHTER_CUSTODY_API_KEY_INDEX: '5', LIGHTER_CUSTODY_JOURNAL: join(dir, 'g.journal') } });
  assert.match(generic.stdout, /"error":"OP_FORBIDDEN"/);
  // The journal survives the process: a restarted custody still refuses the slot.
  const again = new GoKeyCustody({ binary: BIN, keyFile: join(dir, 'refusals.lighter-key'), chainId: 300, accountIndex: 281_474_976_710_600n, apiKeyIndex: 5, journal: join(dir, 'refusals.journal') });
  const after = await again.sign(other, otherHash.value.hash, 'attempt-2');
  again.close();
  assert.ok(!after.ok && after.error === 'SLOT_ALREADY_SIGNED');
  process.stdout.write('2. custody refused forbidden types, a foreign account, an uncommitted hash, a generic sign and a second transaction for a signed slot (also after restart)\n');

  const { issuanceWorld, authorizeOrder } = await import('../test/support/signer-world.ts');
  const x = await issuanceWorld();
  const real = new GoKeyCustody({ binary: BIN, keyFile: keygen('issuer'), chainId: 300, accountIndex: x.deps.config.accountIndex, apiKeyIndex: x.deps.config.apiKeyIndex, journal: join(dir, 'issuer.journal') });
  const pk = await real.publicKey();
  assert.ok(pk.ok);
  x.venue.keys = [{ apiKeyIndex: x.deps.config.apiKeyIndex, publicKey: pk.value }];
  const { VenueSigner } = await import('../src/index.ts');
  const signer = new VenueSigner({ ...x.deps, custody: real });
  const { rec, issue } = await authorizeOrder(x);
  const out = await signer.issueAuthorizedPerpOrder(rec, issue);
  assert.equal(out.status, 'ISSUED');
  const attempt = [...x.store.readCommitted(rec.principal).state.attempts.values()][0];
  const committed = attempt === undefined ? '' : [...attempt.artifact.id].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.ok(out.status === 'ISSUED' && out.txHash === committed, 'the signed hash is the committed one');
  const sent = JSON.parse(x.venue.sent[0]?.txInfo ?? '{}') as { Sig?: string; Nonce?: number };
  assert.ok(typeof sent.Sig === 'string' && sent.Sig.length > 0);
  real.close();
  x.close();
  process.stdout.write(`3. full issuance through the real custody: ADMIT_ATTEMPT committed ${committed.slice(0, 16)}…, signed and submitted exactly that\n`);
}

main()
  .catch((e: Error) => {
    process.stderr.write(`${e.stack ?? e.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    // Custody processes left open by a failed assertion must not keep the check alive.
    process.exit();
  });
