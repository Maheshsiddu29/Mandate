/**
 * A separate process that writes to a store file, used to test what a real
 * crash — `SIGKILL`, no unwinding, no `finally` — leaves on disk, and what
 * genuinely concurrent writers from other processes do.
 *
 *   child.ts setup <db>                      policy + grant (version 1)
 *   child.ts crash <db> <point> <what>        from version 1, commit <what> (reserve | admit) and SIGKILL at <point>
 *   child.ts writer <db> <id> <count>         register <count> grants, retrying on conflict
 */

import { AuthorityLedger, ReferenceModuleRegistry } from '@mandate/ledger';
import { SqliteLedgerStore, type SqliteFaultPoint } from '../../src/index.ts';
import { ALL_MODULES, PRINCIPAL, SETUP, T0, admitEvent, dim, must, reserveEvent, root, units } from './world.ts';

const [mode, path, a, b] = process.argv.slice(2) as [string, string, string | undefined, string | undefined];

async function main(): Promise<void> {
  if (mode === 'setup') {
    const store = SqliteLedgerStore.open({ path });
    const s = await store.read(PRINCIPAL);
    const out = await store.compareAndAppend(PRINCIPAL, s.version, s.head, SETUP);
    if (out.status !== 'COMMITTED') throw new Error(`setup ${out.status}`);
    store.close();
    return;
  }
  if (mode === 'crash') {
    const point = a as SqliteFaultPoint;
    let armed = false;
    const store = SqliteLedgerStore.open({ path, fault: (p) => { if (armed && p === point) process.kill(process.pid, 'SIGKILL'); } });
    let s = await store.read(PRINCIPAL);
    if (b === 'admit') {
      const r = await store.compareAndAppend(PRINCIPAL, s.version, s.head, [reserveEvent(s.state)]);
      if (r.status !== 'COMMITTED') throw new Error('reserve');
      s = r.snapshot;
    }
    armed = true;
    await store.compareAndAppend(PRINCIPAL, s.version, s.head, [b === 'admit' ? admitEvent() : reserveEvent(s.state)]);
    // Reached only if the fault point was never hit.
    process.exit(3);
  }
  if (mode === 'writer') {
    const id = Number(a);
    const count = Number(b);
    const store = SqliteLedgerStore.open({ path, busyTimeoutMs: 30_000 });
    const ledger = new AuthorityLedger(store, must(ReferenceModuleRegistry.create([])));
    for (let i = 0; i < count; i += 1) {
      const grant = root({ nonce: BigInt(id * 1_000 + i + 1), terms: [ALL_MODULES, dim('capital', units(1))] });
      const out = await ledger.registerGrant(grant, T0, { maxAttempts: 32 });
      if (out.status !== 'COMMITTED') throw new Error(`writer ${id} grant ${i}: ${out.status}`);
    }
    store.close();
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch((e: Error) => {
  process.stderr.write(`${e.stack ?? e.message}\n`);
  process.exit(2);
});
