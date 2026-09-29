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
 *    foreign account or key, a sign request with no attempt id, and a
 *    generic sign operation.
 * 3. Independent verification of the durable ADMIT_ATTEMPT (Phase 7E.2),
 *    against a real SQLite ledger with transaction A admitted (and not
 *    signed): custody refuses B under A's attempt (wrong ledger record), A
 *    under an attempt the ledger does not hold (missing attempt), a claim for
 *    another reservation, and A once the adapter is DISABLED; it signs A, and
 *    a restarted custody still verifies A from the file alone.
 * 4. The Go-level custody mutants (custody_test.go) over that same ledger:
 *    M12 (trust that the transaction is the admitted one) and M13 (no attempt
 *    required) must sign what production refuses — killed.
 * 5. One full issuance through the real custody (fake venue, SQLite ledger):
 *    the signed transaction's hash is the one ADMIT_ATTEMPT committed.
 *
 * Keys are disposable, generated into a temporary directory and deleted.
 * Stages 3–5 authorize at the later of the test world's T and the real clock
 * (custody checks attempt validity against real time), so they run until the
 * test grants expire at T_END (2026-12-30).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { principalKey } from '@mandate/ledger';
import { GoKeyCustody, custodyJson, type AttemptClaim, type CustodyBinding, type CustodyTx } from '../src/index.ts';
import { admit, construct, hashTx, readPreExecution, resolveIntent } from '../src/issuance.ts';

const BIN = 'packages/perp-lighter/custody/bin/lighter-custody';
const dir = mkdtempSync(join(tmpdir(), 'mandate-custody-check-'));
/** Stages 1–2 never reach the ledger; custody opens it lazily. */
const NO_LEDGER = join(dir, 'no-ledger.db');
const NO_BINDING: CustodyBinding = {
  principal: '["ADDRESS","0x0000000000000000000000000000000000000001"]',
  module: { domainId: 'perp', moduleId: 'none', moduleVersion: 1, moduleDigest: `0x${'00'.repeat(32)}` },
  adapter: { adapterId: 'none', adapterVersion: 1, adapterDigest: `0x${'00'.repeat(32)}` },
};

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

function custodyFor(account: bigint, apiKey: number, name: string, ledger = NO_LEDGER, binding = NO_BINDING, keyFile = keygen(name)): GoKeyCustody {
  return new GoKeyCustody({ binary: BIN, keyFile, chainId: 300, accountIndex: account, apiKeyIndex: apiKey, journal: join(dir, `${name}.journal`), ledger, binding });
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
  const noAttempt = await c.sign(base, { attempt: '', reservation: `0x${'00'.repeat(32)}`, generation: 1n, action: `0x${'00'.repeat(32)}` });
  assert.ok(!noAttempt.ok && noAttempt.error === 'ATTEMPT_ID_MISSING');
  c.close();
  const generic = spawnSync(BIN, [], { input: '{"op":"signBytes","bytes":"00"}\n{"op":"sign","tx":null}\n', encoding: 'utf8', env: { LIGHTER_CUSTODY_KEY_FILE: keygen('generic'), LIGHTER_CUSTODY_CHAIN_ID: '300', LIGHTER_CUSTODY_ACCOUNT_INDEX: '1', LIGHTER_CUSTODY_API_KEY_INDEX: '5', LIGHTER_CUSTODY_JOURNAL: join(dir, 'g.journal'), LIGHTER_CUSTODY_LEDGER: NO_LEDGER, LIGHTER_CUSTODY_BINDING: JSON.stringify(NO_BINDING) } });
  assert.match(generic.stdout, /"error":"OP_FORBIDDEN"/);
  assert.match(generic.stdout, /"error":"ATTEMPT_ID_MISSING"/);
  process.stdout.write('2. custody refused forbidden types, a foreign account, a sign request with no attempt id and a generic sign\n');

  const { issuanceWorld, authorizeOrder } = await import('../test/support/signer-world.ts');
  const { T } = await import('../test/support/world.ts');
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  const at = nowS > T ? nowS : T;

  // 3. A admitted durably, not signed; the real custody decides from the file.
  const x = await issuanceWorld();
  const binding: CustodyBinding = { principal: principalKey(x.deps.config.principal), module: x.w.policy.ref, adapter: x.deps.config.adapter };
  const verifierKey = keygen('verifier');
  let v = custodyFor(x.deps.config.accountIndex, x.deps.config.apiKeyIndex, 'verifier', x.path, binding, verifierKey);
  const pk = await v.publicKey();
  assert.ok(pk.ok);
  x.venue.keys = [{ apiKeyIndex: x.deps.config.apiKeyIndex, publicKey: pk.value }];
  const deps = { ...x.deps, custody: v };
  const { rec, issue } = await authorizeOrder(x, {}, at);
  const intent = resolveIntent(deps, 'ORDER', rec, issue.payload);
  const ev = await readPreExecution(deps);
  assert.ok(intent.ok && ev.ok);
  const txA = construct(deps, intent.value, ev.value.nonce);
  assert.ok(txA.ok);
  const hA = await hashTx(deps, txA.value);
  assert.ok(hA.ok);
  const admitted = await admit(deps, intent.value, issue, txA.value, hA.value, ev.value.scope, ev.value.results);
  assert.equal(admitted.status, 'ADMITTED');
  if (admitted.status !== 'ADMITTED') return;
  const claim: AttemptClaim = { attempt: admitted.attempt.attempt, reservation: rec.reservation, generation: rec.generation, action: rec.actionId };
  const txB: CustodyTx = { ...txA.value, baseAmount: txA.value.baseAmount + 1n };
  const refused = async (tx: CustodyTx, cl: AttemptClaim, error: string) => {
    const r = await v.sign(tx, cl);
    assert.ok(!r.ok && r.error === error, `${error}: ${r.ok ? 'signed' : r.error}`);
  };
  await refused(txB, claim, 'ARTIFACT_NOT_ADMITTED');
  await refused(txA.value, { ...claim, attempt: `0x${'7'.repeat(64)}` }, 'ATTEMPT_NOT_ADMITTED');
  await refused(txA.value, { ...claim, reservation: `0x${'5'.repeat(64)}` }, 'RESERVATION_MISMATCH');
  await refused({ ...txA.value, nonce: txA.value.nonce + 1n }, claim, 'ARTIFACT_NOT_ADMITTED');
  x.lifecycle.setAdapter({ adapter: x.deps.config.adapter, status: 'DISABLED' });
  await refused(txA.value, claim, 'ADAPTER_DISABLED');
  x.lifecycle.setAdapter({ adapter: x.deps.config.adapter, status: 'ACTIVE' });

  // 4. The Go-level mutants, over this same ledger, before A is signed anywhere.
  const mutantFixture = join(dir, 'mutant-fixture.json');
  writeFileSync(mutantFixture, JSON.stringify({ ledger: x.path, binding, claim: { ...claim, generation: Number(claim.generation) }, txA: custodyJson(txA.value), txB: custodyJson(txB), nowMs: Number(x.clock.ms) }));
  const go = spawnSync('go', ['test', '-count=1', '-v', '-run', 'Production|Mutant|Slot', '.'], { cwd: 'packages/perp-lighter/custody', encoding: 'utf8', env: { ...process.env, LIGHTER_CUSTODY_TEST_FIXTURE: mutantFixture } });
  assert.equal(go.status, 0, go.stdout + go.stderr);
  for (const name of ['TestProductionRefusesBeforeKeyUse', 'TestMutantM12TrustCallerKilled', 'TestMutantM13NoAttemptRequiredKilled', 'TestSlotJournalSurvivesRestart']) assert.match(go.stdout, new RegExp(`--- PASS: ${name}`), name);
  assert.doesNotMatch(go.stdout, /--- SKIP/);

  const signedA = await v.sign(txA.value, claim);
  assert.ok(signedA.ok && signedA.value.hash === hA.value.hash, 'A is signable under its own attempt');
  v.close();
  // A restarted custody verifies from the durable file alone.
  v = custodyFor(x.deps.config.accountIndex, x.deps.config.apiKeyIndex, 'verifier', x.path, binding, verifierKey);
  const again = await v.sign(txA.value, claim);
  assert.ok(again.ok && again.value.hash === hA.value.hash);
  await refused(txB, claim, 'ARTIFACT_NOT_ADMITTED');
  v.close();
  x.close();
  process.stdout.write('3. real custody read the durable ADMIT_ATTEMPT itself: refused the wrong record, a missing attempt, another reservation, another slot and a DISABLED adapter before key use; signed A, also after restart\n');
  process.stdout.write('4. Go custody mutants over the same ledger: M12 (trust the caller\'s transaction) killed, M13 (no attempt required) killed; production refused both\n');

  // 5. One full issuance through the real custody.
  const y = await issuanceWorld();
  const real = custodyFor(y.deps.config.accountIndex, y.deps.config.apiKeyIndex, 'issuer', y.path, { principal: principalKey(y.deps.config.principal), module: y.w.policy.ref, adapter: y.deps.config.adapter });
  const rpk = await real.publicKey();
  assert.ok(rpk.ok);
  y.venue.keys = [{ apiKeyIndex: y.deps.config.apiKeyIndex, publicKey: rpk.value }];
  const { VenueSigner } = await import('../src/index.ts');
  const signer = new VenueSigner({ ...y.deps, custody: real });
  const o = await authorizeOrder(y, {}, at);
  const out = await signer.issueAuthorizedPerpOrder(o.rec, o.issue);
  assert.equal(out.status, 'ISSUED', JSON.stringify(out, (_k, val: unknown) => (typeof val === 'bigint' ? val.toString() : val)));
  const attempt = [...y.store.readCommitted(o.rec.principal).state.attempts.values()][0];
  const committed = attempt === undefined ? '' : [...attempt.artifact.id].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.ok(out.status === 'ISSUED' && out.txHash === committed, 'the signed hash is the committed one');
  const sent = JSON.parse(y.venue.sent[0]?.txInfo ?? '{}') as { Sig?: string; Nonce?: number };
  assert.ok(typeof sent.Sig === 'string' && sent.Sig.length > 0);
  real.close();
  y.close();
  process.stdout.write(`5. full issuance through the real custody: ADMIT_ATTEMPT committed ${committed.slice(0, 16)}…, custody verified it from the ledger, signed and submitted exactly that\n`);
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
