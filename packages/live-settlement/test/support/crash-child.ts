/**
 * A settlement process that dies by SIGKILL at a chosen instant, for the
 * real crash tests (crash.test.ts). Everything it touches is durable: the
 * Live AI session and its portfolio ledger (.live-style state directory),
 * the settlement journal, the domain ledger, and the reference-model chain
 * (durable-chain.ts).
 *
 *   crash-child.ts setup     <dir>             a durable session, authorized, run: the Stock child reserved
 *   crash-child.ts setup-die <dir>             the same, killed right after the reservation (crash point 1)
 *   crash-child.ts run       <dir> <FAULT>     restore it and send; SIGKILL at the fault point
 *   crash-child.ts reconcile <dir> [seconds]   restore it, move chain time on, reconcile; print the outcome as JSON
 *   crash-child.ts again     <dir>             restore it and try to send again; print the outcome as JSON
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LiveSession, sessionDir } from '@mandate/live-agents';
import { ManualClock } from '../../../live-agents/src/runtime/clock.ts';
import { presetDraft } from '../../../live-agents/src/authoring/draft-types.ts';
import { ScriptedProvider, json } from '../../../live-agents/test/support/providers.ts';
import { SettlementJournal } from '../../src/journal.ts';
import { reservationStatus } from '../../src/portfolio-ledger.ts';
import { reconcileAttempts } from '../../src/reconcile.ts';
import { SendGate } from '../../src/send-gate.ts';
import { LiveSettlement, type FaultPoint } from '../../src/settlement.ts';
import { DurableModelRpc } from './durable-chain.ts';
import { KEYS, testDeployment } from './world.ts';

const [mode, dir, arg] = process.argv.slice(2) as [string, string, string | undefined];
const TIMEOUTS = { agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000 } as const;
const state = join(dir, 'state');
const die = (): never => {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('unreachable');
};
const show = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

async function setup(kill: boolean): Promise<void> {
  const propose = json({ action: 'PROPOSE', candidateId: 'nvda-note-a', requestedAtoms: '400000000', rationale: 'pick' });
  const abstain = json({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, rationale: 'none' });
  const s = new LiveSession({ provider: new ScriptedProvider({ decide: (r) => ({ text: r.role === 'stock' ? propose : abstain }), negotiate: () => ({ text: abstain }) }), clock: new ManualClock(), sessionId: 'lab-crash', stateDir: state, ...TIMEOUTS });
  const auth = await s.authorize(presetDraft('balanced'), 'AUTHORIZE MANDATE V1');
  if (!auth.ok) throw new Error(auth.code);
  const run = await s.run();
  if (run.status !== 'AUTHORIZED') throw new Error(run.status);
  writeFileSync(join(dir, 'session.txt'), s.id);
  if (kill) die();
  s.close();
}

async function restored() {
  const id = readFileSync(join(dir, 'session.txt'), 'utf8');
  const session = await LiveSession.restore(state, id, { ...TIMEOUTS, by: 'crash-test', clock: new ManualClock() });
  const journal = SettlementJournal.open(join(sessionDir(state, id), 'settlement.db'));
  const rpc = new DurableModelRpc(join(dir, 'chain.json'));
  return { session, journal, rpc };
}

async function ledger(session: LiveSession): Promise<string> {
  const x = session.reservedExecutions.find((r) => r.role === 'stock');
  const core = x === undefined ? undefined : session.versions.coreOf(x.version)?.core;
  if (x === undefined || core === undefined) return 'NONE';
  return reservationStatus((await core.engine.read(core.compiled.mandate.principal)).state, x.record.reservation);
}

async function send(fault: FaultPoint | null): Promise<unknown> {
  const { session, journal, rpc } = await restored();
  const settlement = new LiveSettlement({ session, deployment: testDeployment(), rpc, keys: KEYS });
  const p = await settlement.prepare();
  if ('ineligible' in p) return { status: 'INELIGIBLE', reason: p.ineligible, mined: rpc.minedCount, ledger: await ledger(session) };
  const gate = new SendGate();
  gate.authorize('AUTHORIZE ROBINHOOD TESTNET SEND');
  const r = await settlement.run(p, { mode: 'SEND', gate, ledgerPath: join(dir, 'domain.db'), journal, fault: (f) => (f === fault ? die() : undefined) });
  return { status: r.status, reason: 'reason' in r ? r.reason : null, mined: rpc.minedCount, ledger: await ledger(session), journal: journal.get(p.execution.reservation)?.state ?? null };
}

async function main(): Promise<void> {
  if (mode === 'setup' || mode === 'setup-die') return setup(mode === 'setup-die');
  if (mode === 'run') {
    await send(arg as FaultPoint);
    process.exit(3); // the kill point was never reached
  }
  if (mode === 'again') {
    process.stdout.write(show(await send(null)));
    return;
  }
  if (mode === 'reconcile') {
    const { session, journal, rpc } = await restored();
    if (arg !== undefined) rpc.advance(BigInt(arg));
    const reports = await reconcileAttempts({ journal, reader: rpc, session, deployment: testDeployment() });
    const x = session.reservedExecutions.find((r) => r.role === 'stock');
    const attempt = x === undefined ? null : journal.get(x.record.reservation);
    process.stdout.write(show({
      reservations: session.reservedExecutions.length,
      orphans: session.orphans,
      reports,
      state: attempt?.state ?? null,
      quarantine: attempt?.quarantine ?? null,
      ledger: await ledger(session),
      mined: rpc.minedCount,
      kinds: session.events.events.map((e) => e.kind),
    }));
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch((e: Error) => {
  process.stderr.write(`${e.stack ?? e.message}\n`);
  process.exit(2);
});
