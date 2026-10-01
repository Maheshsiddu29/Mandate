/**
 * Session-bound Robinhood Chain TESTNET settlement for a Mandate authority
 * V2 session (docs/demo/authority-spine-v2.md). EXPLICIT ONLY: never run by
 * `npm test` or `npm run check`.
 *
 *   npm run agents:settle:v2 -- --session lab-<id> [--json]
 *   npm run agents:settle:v2 -- --session lab-<id> --send
 *
 * Restores the durable session, re-verifies the wallet's EIP-712
 * PortfolioMandateV2 signature, then dry-runs the reserved Stock child.
 * `--send` continues that same journal and broadcasts one transaction only
 * after the operator types the existing phrase. A demonstration-key session
 * is refused. A wallet that is not the manifest principal is refused before
 * any key is used.
 *
 * Keys: the gitignored 7E.3 disposable testnet keys. They must already be
 * the manifest parties. No key is printed. RPC: ROBINHOOD_TESTNET_RPC_URL or
 * the public testnet RPC; the URL is never printed.
 *
 * Exit codes: 0 READY, reconciled only, or a confirmed send; 1 usage or
 * configuration; 3 no such session, or corrupt records; 4 not eligible;
 * 5 dry run did not reach READY; 6 the send phrase was refused; 7 a
 * transaction was submitted but is not a confirmed settlement.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { LiveSession, readConfig, renderEvent, sessionDir, type LiveEvent } from '@mandate/live-agents';
import { loadKeys, MANIFEST_PATH } from '../../evm-robinhood/scripts/lib.ts';
import { RobinhoodTestnetRpc, SEND_AUTHORIZATION_PHRASE, SendGate, SettlementJournal, parseDeployment } from '../src/index.ts';
import { settleSpine } from '../src/spine-settlement.ts';
import { readAuthorizationLine } from './authorization-input.ts';
import { readRpcConfig } from './rpc-config.ts';

const { values } = parseArgs({
  options: {
    session: { type: 'string' },
    send: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'authorization-timeout': { type: 'string', default: '300' },
  },
  strict: true,
});
const out = (line: string) => process.stdout.write(`${line}\n`);
const say = (line: string) => {
  if (!values.json) out(line);
};
const fail = (code: number, message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const show = (v: object) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x), 2);

const timeoutSeconds = Number(values['authorization-timeout']);
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 540) fail(1, '--authorization-timeout must be 1–540 seconds');
const id = values.session;
if (id === undefined || !/^[A-Za-z0-9-]{1,64}$/.test(id)) fail(1, 'Usage: npm run agents:settle:v2 -- --session <sessionId> [--send]');
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
  session = await LiveSession.restore(config.stateDir, id as string, { agentTimeoutMs: config.agentTimeoutMs, roomRoundTimeoutMs: config.roomRoundTimeoutMs, by: 'spine-settlement-command' });
} catch (e) {
  session = fail(3, `Session ${id} could not be restored (${e instanceof Error ? `${e.name}: ${e.message}` : 'error'}). Nothing was done.`);
}
const print = (e: LiveEvent) => (values.json ? out(JSON.stringify(e)) : out(renderEvent(e)));
session.events.subscribe(print);
for (const n of rpcConfig.ok ? rpcConfig.notes : []) say(`note: ${n}`);
say(`Mandate — V2 authority spine → Robinhood Chain testnet${values.send ? '' : ' [re-verify, then dry run]'} · session ${session.id} · RPC ${rpcConfig.ok ? rpcConfig.label : ''}`);
say(`Durable session: ${session.versions.records.length} version(s), ${session.reservedExecutions.length} reserved execution(s) · ${session.events.events.length} events\n`);

const journal = SettlementJournal.open(join(sessionDir(config.stateDir, session.id), 'settlement.db'));
const rpc = new RobinhoodTestnetRpc(keys.deployer.privateKey, d.gate.address, endpoints);
const domainKeys = { principal: keys.principal.privateKey, agent: keys.agent.privateKey };
const scratch = mkdtempSync(join(tmpdir(), 'mandate-spine-dry-'));
let code = 0;
try {
  const dry = await settleSpine({ session, journal, deployment: d, rpc, keys: domainKeys, mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: join(scratch, 'domain-ledger.db') });
  for (const rep of dry.reports) say(`reconciled ${rep.reservation.slice(0, 12)}… ${rep.from} → ${rep.to} · ${rep.outcome}${rep.detail === '' ? '' : ` · ${rep.detail}`}`);
  if (dry.status === 'RECONCILED_ONLY') {
    say(`\nThe reservation's attempt is ${dry.attempt.state}${dry.attempt.quarantine === null ? '' : ` (${dry.attempt.quarantine})`}: reconciliation only; nothing is resent.`);
  } else if (dry.status === 'INELIGIBLE') {
    say(`\nNot eligible (${dry.stage}: ${dry.reason}). Nothing was signed for broadcast or sent.`);
    code = 4;
  } else if (dry.status === 'NOT_READY') {
    say(`\nThe dry run did not reach READY: ${show(dry.outcome)}\nNothing was broadcast.`);
    code = 5;
  } else if (dry.status !== 'READY') {
    say('\nThe dry run did not reach READY. Nothing was broadcast.');
    code = 5;
  } else if (!values.send) {
    say(`\n=== RE-VERIFIED — dry run READY; nothing was broadcast ===\n${show({ wouldSend: dry.outcome.wouldSend, principals: dry.principals, preflight: dry.outcome.preflight })}`);
    say(`\nTo broadcast one transaction: npm run agents:settle:v2 -- --session ${session.id} --send`);
    say(`That command asks for exactly "${SEND_AUTHORIZATION_PHRASE}".`);
  } else {
    say(`\nRE-VERIFIED and READY. Type exactly "${SEND_AUTHORIZATION_PHRASE}" within ${timeoutSeconds} s to broadcast ONE transaction; anything else sends nothing.`);
    const input = await readAuthorizationLine(process.stdin, timeoutSeconds * 1_000);
    const gate = new SendGate();
    if (input.kind !== 'LINE' || !gate.authorize(input.line)) {
      session.events.emit('TESTNET_SEND_AUTHORIZATION_REFUSED', { agent: 'stock', data: { required: SEND_AUTHORIZATION_PHRASE, received: input.kind === 'LINE' ? 'another text' : input.kind, transactions: 0 } });
      say('Not authorized. Nothing was broadcast.');
      code = 6;
    } else {
      const sent = await settleSpine({ session, journal, deployment: d, rpc, keys: domainKeys, mode: 'SEND', gate, ledgerPath: join(sessionDir(config.stateDir, session.id), 'domain-ledger.db') });
      if (sent.status === 'SENT' && sent.outcome.status === 'CONFIRMED') {
        say(`\n=== SETTLEMENT ===\n${show(sent.outcome)}`);
        code = sent.outcome.evidence === 'LIVE_TESTNET' ? 0 : 7;
      } else if (sent.status === 'RECONCILED_ONLY') {
        say(`\nThe reservation's attempt is ${sent.attempt.state}: reconciliation only; nothing is resent.`);
      } else if (sent.status === 'INELIGIBLE') {
        say(`\nNot eligible (${sent.stage}: ${sent.reason}). Nothing further was sent.`);
        code = 4;
      } else {
        say(`\n=== SETTLEMENT ===\n${show(sent.status === 'SENT' || sent.status === 'NOT_READY' ? sent.outcome : sent)}`);
        code = 7;
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
  journal.close();
  session.close();
}
process.exit(code);
