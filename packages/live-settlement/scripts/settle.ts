/**
 * Session-bound Robinhood Chain TESTNET settlement — DRY RUN ONLY in B.5.3
 * (docs/demo/wallet-settlement-boundaries.md §7). EXPLICIT ONLY: never run
 * by `npm test` or `npm run check`.
 *
 *   npm run agents:settle:testnet -- --session lab-<id> [--json]
 *
 * Restores the exact durable Live AI session the browser created (no new
 * model run, no rebuilt proposal), reconciles every journaled attempt
 * first, verifies the version's principal authorization, then dry-runs the
 * reserved Stock child — preflight, the portfolio attempt, the domain leg,
 * eth_call and estimateGas — and stops at READY_FOR_TESTNET_SEND. Every
 * event goes into the session's own event log, so the browser sees it.
 *
 * There is no send. B.5.3 proves durability and linkage without spending a
 * transaction; this command cannot broadcast.
 *
 * Keys: the gitignored 7E.3 disposable testnet keys (custody signs the gate
 * artifact the simulation needs). RPC: ROBINHOOD_TESTNET_RPC_URL (QuickNode)
 * or the public testnet RPC (scripts/rpc-config.ts); the URL is never printed.
 *
 * Exit codes: 0 READY_FOR_TESTNET_SEND or reconciled only; 1 usage or
 * configuration; 3 no such session, or corrupt records; 4 not eligible
 * (nothing signed for broadcast); 5 dry run did not reach READY.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { LiveSession, readConfig, renderEvent, sessionDir, type LiveEvent } from '@mandate/live-agents';
import { loadKeys, MANIFEST_PATH } from '../../evm-robinhood/scripts/lib.ts';
import { RobinhoodTestnetRpc, SettlementJournal, parseDeployment } from '../src/index.ts';
import { settleSessionDryRun } from '../src/session-settlement.ts';
import { readRpcConfig } from './rpc-config.ts';

const { values } = parseArgs({ options: { session: { type: 'string' }, json: { type: 'boolean', default: false } }, strict: true });
const out = (line: string) => process.stdout.write(`${line}\n`);
const say = (line: string) => {
  if (!values.json) out(line);
};
const fail = (code: number, message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const show = (v: object) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x), 2);

const id = values.session;
if (id === undefined || !/^[A-Za-z0-9-]{1,64}$/.test(id)) fail(1, 'Usage: npm run agents:settle:testnet -- --session <sessionId>');
const config = readConfig();
const rpcConfig = readRpcConfig();
if (!rpcConfig.ok) fail(1, rpcConfig.ok ? '' : rpcConfig.error);
const endpoints = rpcConfig.ok ? rpcConfig.endpoints : (null as never);

const deployment = parseDeployment(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
if (!deployment.ok) fail(1, `deployment manifest refused: ${deployment.ok ? '' : deployment.error}`);
const d = deployment.ok ? deployment.value : (null as never);
const keys = loadKeys();
if (keys.principal.address !== d.principal || keys.agent.address !== d.agent || keys.deployer.address !== d.submitter) fail(1, 'the disposable keys are not the manifest parties; refusing');

let session: LiveSession;
try {
  session = await LiveSession.restore(config.stateDir, id as string, { agentTimeoutMs: config.agentTimeoutMs, roomRoundTimeoutMs: config.roomRoundTimeoutMs, by: 'settlement-command' });
} catch (e) {
  session = fail(3, `Session ${id} could not be restored (${e instanceof Error ? `${e.name}: ${e.message}` : 'error'}). Nothing was done.`);
}
const print = (e: LiveEvent) => (values.json ? out(JSON.stringify(e)) : out(renderEvent(e)));
session.events.subscribe(print);
for (const n of rpcConfig.ok ? rpcConfig.notes : []) say(`note: ${n}`);
say(`Mandate — session-bound testnet settlement [DRY RUN; B.5.3 never broadcasts] · session ${session.id} · RPC ${rpcConfig.ok ? rpcConfig.label : ''}`);
say(`Durable session: ${session.versions.records.length} version(s), ${session.reservedExecutions.length} reserved execution(s), ${session.orphans.length} orphaned reservation(s) · ${session.events.events.length} events\n`);

const journal = SettlementJournal.open(join(sessionDir(config.stateDir, session.id), 'settlement.db'));
const rpc = new RobinhoodTestnetRpc(keys.deployer.privateKey, d.gate.address, endpoints);
const scratch = mkdtempSync(join(tmpdir(), 'mandate-session-settle-dry-'));
let code = 0;
try {
  const r = await settleSessionDryRun({ session, journal, deployment: d, rpc, keys: { principal: keys.principal.privateKey, agent: keys.agent.privateKey }, scratchLedgerPath: join(scratch, 'domain-ledger.db') });
  for (const rep of r.reports) say(`reconciled ${rep.reservation.slice(0, 12)}… ${rep.from} → ${rep.to} · ${rep.outcome}${rep.detail === '' ? '' : ` · ${rep.detail}`}`);
  switch (r.status) {
    case 'READY_FOR_TESTNET_SEND':
      say(`\n=== READY_FOR_TESTNET_SEND — B.5.3 broadcast disabled: nothing was sent ===\n${show({ wouldSend: r.outcome.wouldSend, principals: r.principals, preflight: r.outcome.preflight })}`);
      break;
    case 'RECONCILED_ONLY':
      say(`\nThe reservation's attempt is ${r.attempt.state}${r.attempt.quarantine === null ? '' : ` (${r.attempt.quarantine})`}: reconciliation only; nothing is resent.`);
      break;
    case 'INELIGIBLE':
      say(`\nNot eligible (${r.stage}: ${r.reason}). Nothing was signed for broadcast or sent.`);
      code = 4;
      break;
    case 'NOT_READY':
      say(`\nThe dry run did not reach READY: ${show(r.outcome)}\nNothing was broadcast.`);
      code = 5;
      break;
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
  journal.close();
  session.close();
}
process.exit(code);
