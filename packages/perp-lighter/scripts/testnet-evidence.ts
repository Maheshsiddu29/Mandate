/**
 * `npm run lighter:testnet:evidence` — LIVE, Lighter TESTNET only, never in CI.
 *
 * Read-only captures of the facts Phase 7E.1 can establish without a funded
 * account (testnet-evidence.md): market metadata, a window of recent
 * transactions with their statuses, nonces and finality timestamps, block
 * records, the height's progress, and a short WebSocket sample.
 *
 * The 7E.1 `--probe-send` write (E-P2, testnet-evidence.md) is retired: since
 * Phase 7E.2 custody signs nothing without a durable ADMIT_ATTEMPT it verifies
 * itself, so an unadmitted probe signature is no longer producible. E-P2's
 * captured result stands as recorded.
 *
 * Output goes to the directory given by `LIGHTER_EVIDENCE_OUT` (default
 * `.lighter-testnet/evidence`, ignored by git). Nothing secret is written.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TESTNET_HOSTS } from '../src/index.ts';

const BASE = `https://${TESTNET_HOSTS[0] as string}`;
const API = `${BASE}/api/v1`;
const OUT = process.env['LIGHTER_EVIDENCE_OUT'] ?? '.lighter-testnet/evidence';

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

  summary['finishedAt'] = new Date().toISOString();
  save('summary.json', summary);
  process.stdout.write(`testnet evidence written to ${OUT}\n`);
}

main().catch((e: Error) => {
  process.stderr.write(`${e.stack ?? e.message}\n`);
  process.exit(1);
});
