/**
 * `npm run lighter:testnet:evidence` — LIVE, Lighter TESTNET only, never in CI.
 *
 * Read-only captures of the facts Phase 7E.1 can establish without a funded
 * account (testnet-evidence.md): market metadata, a window of recent
 * transactions with their statuses, nonces and finality timestamps, block
 * records, the height's progress, and a short WebSocket sample. With
 * `--probe-send`, one additional write: a correctly signed create-order for a
 * disposable key and an account index that does not exist, to observe how the
 * API refuses it (no account, no funds, nothing can execute).
 *
 * Output goes to the directory given by `LIGHTER_EVIDENCE_OUT` (default
 * `.lighter-testnet/evidence`, ignored by git). Nothing secret is written: the
 * disposable key stays in its key file; the probe's transaction info carries
 * only a signature for a key registered nowhere.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoKeyCustody, HttpVenueClient, TESTNET_HOSTS, type CustodyTx } from '../src/index.ts';

const BASE = `https://${TESTNET_HOSTS[0] as string}`;
const API = `${BASE}/api/v1`;
const OUT = process.env['LIGHTER_EVIDENCE_OUT'] ?? '.lighter-testnet/evidence';
const probeSend = process.argv.includes('--probe-send');

async function get(path: string): Promise<{ at: string; status: number; body: string }> {
  const at = new Date().toISOString();
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20_000) });
  return { at, status: res.status, body: await res.text() };
}

function save(name: string, data: object): void {
  writeFileSync(join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
}

async function wsSample(seconds: number): Promise<{ at: string; messages: string[] }> {
  const at = new Date().toISOString();
  const messages: string[] = [];
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`wss://${TESTNET_HOSTS[0] as string}/stream?readonly=true`);
    const timer = setTimeout(() => {
      ws.close();
      resolve();
    }, seconds * 1_000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'height' }));
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'order_book/4096' }));
    });
    ws.addEventListener('message', (m) => {
      if (messages.length < 400) messages.push(String(m.data));
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return { at, messages };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const summary: { [k: string]: string | number | boolean } = { base: BASE, startedAt: new Date().toISOString() };

  const obd = await get('/orderBookDetails');
  save('order-book-details.json', obd);
  const h1 = await get('/currentHeight');

  // A window of transactions: statuses, nonces, finality timestamps.
  const pages: { at: string; status: number; body: string }[] = [];
  for (let index = 0; index < 1_000; index += 100) {
    const p = await get(`/txs?index=${index}&limit=100`);
    pages.push(p);
    if (!p.body.includes('"hash"')) break;
  }
  save('txs.json', { pages });
  const firstHash = /"hash":"([0-9a-f]{80})"/.exec(pages[0]?.body ?? '')?.[1];
  if (firstHash !== undefined) save('tx.json', await get(`/tx?by=hash&value=${firstHash}`));
  save('blocks.json', await get('/blocks?limit=5&sort=desc'));
  save('nonexistent-account.json', await get('/nextNonce?account_index=281474976700001&api_key_index=5'));

  save('ws-sample.json', await wsSample(8));
  const h2 = await get('/currentHeight');
  save('heights.json', { first: h1, second: h2 });

  if (probeSend) {
    // A disposable key registered nowhere, and an account index that does not exist.
    const venue = new HttpVenueClient(BASE);
    const custody = new GoKeyCustody({ binary: 'packages/perp-lighter/custody/bin/lighter-custody', keyFile: '.lighter-testnet/probe.lighter-key', chainId: 300, accountIndex: 281_474_976_700_001n, apiKeyIndex: 5, journal: join(OUT, 'probe.journal') });
    const now = BigInt(Date.now());
    const tx: CustodyTx = {
      type: 'CREATE_ORDER', chainId: 300, accountIndex: 281_474_976_700_001n, apiKeyIndex: 5, marketIndex: 4096, clientOrderIndex: 1n, baseAmount: 20n, price: 1n,
      isAsk: 0, orderType: 0, timeInForce: 0, reduceOnly: 0, orderExpiry: 0n, cancelIndex: 0n, expiredAt: now + 300_000n, nonce: 0n, selfTradeBehavior: 1, selfTradeEquality: 0,
    };
    const hashed = await custody.hash(tx);
    const signed = hashed.ok ? await custody.sign(tx, hashed.value.hash, 'probe') : null;
    const sent = signed !== null && signed.ok ? await venue.sendTx(signed.value.txType, signed.value.txInfo) : null;
    save('probe-send.json', { at: new Date().toISOString(), note: 'disposable key, nonexistent account; price 0.1 USD for 0.0002 BTC — cannot execute', hash: hashed.ok ? hashed.value.hash : hashed.error, sent });
    custody.close();
    summary['probeSend'] = true;
  }
  summary['finishedAt'] = new Date().toISOString();
  save('summary.json', summary);
  process.stdout.write(`testnet evidence written to ${OUT}\n`);
}

main().catch((e: Error) => {
  process.stderr.write(`${e.stack ?? e.message}\n`);
  process.exit(1);
});
