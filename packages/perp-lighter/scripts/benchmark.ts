/**
 * `npm run lighter:benchmark` — local cost of the Phase 7E.1 issue path.
 * Offline; with the Go custody built, signing is measured through the real
 * custody process as well. Not optimized, and not a claim about any other
 * machine: numbers are for comparing changes on this one.
 *
 * 1. PerpPolicy decision and reservation (in-memory ledger)
 * 2. issue-time revalidation on fresh state
 * 3. ADMIT_ATTEMPT durable commit (SQLite reference store, synchronous FULL)
 * 4. signing excluding network (fake custody; real Go custody if built)
 * 5. the full local issue path (resolve → evidence → construct → hash → admit → sign → journal → submit to a fake venue)
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GoKeyCustody, VenueSigner, type KeyCustody } from '../src/index.ts';
import { ONCE, T, authorized, context, order, request, states } from '../test/support/world.ts';
import { issuanceWorld } from '../test/support/signer-world.ts';

const BIN = 'packages/perp-lighter/custody/bin/lighter-custody';
const N = Number(process.env['BENCH_N'] ?? '200');

function stats(label: string, samples: number[]): void {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => (s[Math.min(s.length - 1, Math.floor(p * s.length))] as number).toFixed(3);
  process.stdout.write(`${label.padEnd(58)} n=${String(s.length).padStart(4)}  p50 ${q(0.5)} ms  p95 ${q(0.95)} ms  max ${q(1)} ms\n`);
}

async function main(): Promise<void> {
  process.stdout.write(`node ${process.version}, ${process.platform}/${process.arch}\n`);
  const dir = mkdtempSync(join(tmpdir(), 'mandate-lighter-bench-'));
  let goCustody: GoKeyCustody | null = null;
  try {
    const x = await issuanceWorld({ path: join(dir, 'ledger.db') });
    const decide: number[] = [];
    const reval: number[] = [];
    const admit: number[] = [];
    const sign: number[] = [];
    const full: number[] = [];

    // 1–2: decisions and revalidations under one growing ledger.
    for (let i = 0; i < N; i += 1) {
      const at = T + BigInt(i) * 10n;
      const a = order(x.w, x.g, { nonce: BigInt(10_000 + i), validFrom: at });
      const t0 = performance.now();
      const rec = authorized(await x.w.engine.authorizeAndReserve(request(a, states(x.w, { at }), context(at)), ONCE));
      decide.push(performance.now() - t0);
      const t1 = performance.now();
      await x.w.engine.revalidate(rec, { payload: a.payload, states: states(x.w, { at: at + 1n }), context: context(at + 1n) });
      reval.push(performance.now() - t1);
    }

    // 3–5: full issuance, each on a fresh reservation, one serialized lane advancing.
    if (existsSync(BIN)) {
      const key = join(dir, 'bench.lighter-key');
      spawnSync(BIN, ['keygen', key]);
      goCustody = new GoKeyCustody({ binary: BIN, keyFile: key, chainId: 300, accountIndex: x.deps.config.accountIndex, apiKeyIndex: x.deps.config.apiKeyIndex, journal: join(dir, 'bench.journal') });
      const pk = await goCustody.publicKey();
      if (pk.ok) x.venue.keys = [{ apiKeyIndex: x.deps.config.apiKeyIndex, publicKey: pk.value }];
    }
    const custody: KeyCustody = goCustody ?? x.custody;
    const signer = new VenueSigner({ ...x.deps, custody });
    const base = T + BigInt(N) * 10n + 100n;
    for (let i = 0; i < N; i += 1) {
      const at = base + BigInt(i) * 10n;
      const a = order(x.w, x.g, { nonce: BigInt(50_000 + i), validFrom: at });
      const rec = authorized(await x.w.engine.authorizeAndReserve(request(a, states(x.w, { at }), context(at)), ONCE));
      x.venue.next = BigInt(i);
      x.clock.ms = (at + 1n) * 1_000n;
      const t0 = performance.now();
      const out = await signer.issueAuthorizedPerpOrder(rec, { payload: a.payload, states: states(x.w, { at: at + 1n }), context: context(at + 1n) });
      full.push(performance.now() - t0);
      if (out.status !== 'ISSUED') throw new Error(`issue ${i}: ${out.status} ${out.status === 'REFUSED' ? out.reason : ''}`);
    }
    // Isolated ADMIT_ATTEMPT commit and signing: re-run the two stages on a fresh reservation each.
    const { resolveIntent, readPreExecution, construct, hashTx, admit: admitStage, signAdmitted } = await import('../src/issuance.ts');
    const deps = { ...x.deps, custody };
    const base2 = base + BigInt(N) * 10n + 100n;
    for (let i = 0; i < N; i += 1) {
      const at = base2 + BigInt(i) * 10n;
      const a = order(x.w, x.g, { nonce: BigInt(90_000 + i), validFrom: at });
      const rec = authorized(await x.w.engine.authorizeAndReserve(request(a, states(x.w, { at }), context(at)), ONCE));
      x.venue.next = BigInt(N + i);
      x.clock.ms = (at + 1n) * 1_000n;
      const intent = resolveIntent(deps, 'ORDER', rec, a.payload);
      const ev = await readPreExecution(deps);
      if (!intent.ok || !ev.ok) throw new Error('prepare');
      const tx = construct(deps, intent.value, ev.value.nonce);
      if (!tx.ok) throw new Error('construct');
      const h = await hashTx(deps, tx.value);
      if (!h.ok) throw new Error('hash');
      const t0 = performance.now();
      const ad = await admitStage(deps, intent.value, { payload: a.payload, states: states(x.w, { at: at + 1n }), context: context(at + 1n) }, tx.value, h.value, ev.value.scope, ev.value.results);
      admit.push(performance.now() - t0);
      if (ad.status !== 'ADMITTED') throw new Error(`admit ${ad.status}`);
      const t1 = performance.now();
      const s = await signAdmitted(deps, tx.value, h.value.hash, ad.attempt);
      sign.push(performance.now() - t1);
      if (!s.ok) throw new Error(`sign ${s.reason}`);
    }
    stats('1. PerpPolicy decide + reserve (SQLite CAS)', decide);
    stats('2. issue-time revalidation (fresh state)', reval);
    stats('3. ADMIT_ATTEMPT incl. revalidation, durable SQLite commit', admit);
    stats(`4. signing excluding network (${goCustody === null ? 'fake custody' : 'Go custody process'})`, sign);
    stats(`5. full local issue path (${goCustody === null ? 'fake custody' : 'Go custody'}, fake venue)`, full);
    x.close();
  } finally {
    goCustody?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e: Error) => {
  process.stderr.write(`${e.stack ?? e.message}\n`);
  process.exit(1);
});
