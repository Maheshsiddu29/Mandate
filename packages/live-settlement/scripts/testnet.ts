/**
 * The Live AI Lab's one Robinhood Chain TESTNET settlement path
 * (docs/demo/live-testnet-settlement.md). EXPLICIT ONLY: never run by
 * `npm run check`, `npm test` or `npm run agents:live`.
 *
 *   npm run agents:live:testnet:dry-run   the full path to eth_call + estimateGas; nothing is broadcast
 *   npm run agents:live:testnet           the same, then waits for the operator's exact phrase
 *                                         "AUTHORIZE ROBINHOOD TESTNET SEND" on stdin before ONE broadcast
 *
 * Options: --provider=openai|stub (stub: dry run only)  --seed=N  --preset=…  --json
 *          --authorization-timeout=SECONDS (default 300)
 *
 * A Live AI session runs as `agents:live` does (the principal's
 * confirmation supplied by this run, no policy-stress pass). Its one
 * reserved Stock child — and nothing else — is checked, mapped by the
 * declared testnet settlement fixture onto a valueless MDEMO BUY on the
 * deployed Phase 7E.3 gate, and handed to the existing robinhood-gate-signer.
 *
 * Keys are the gitignored 7E.3 disposable testnet keys in
 * `.robinhood-testnet/keys.json` (loaded by the 7E.3 operator library);
 * addresses and code hashes come from `docs/phase-7e/deployment-manifest.json`.
 * No key is printed. A send writes its public record, write-ahead, to
 * `.robinhood-testnet/runs/live-ai-<time>/settlement.json`; a later send
 * refuses while any earlier record is unresolved.
 *
 * Exit codes: 0 done (dry run READY, or LIVE_TESTNET confirmed); 1 usage;
 * 2 no OPENAI_API_KEY; 3 mandate draft refused; 4 no eligible Stock action
 * (nothing sent); 5 preflight or simulation failed (nothing sent); 6 not
 * authorized (nothing sent); 7 sent but not LIVE_TESTNET (see output).
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { LiveSession, OpenAIProvider, PRESETS, StubProvider, describeConfig, readConfig, renderEvent, summarizeRun, type AgentModelProvider, type LiveEvent, type Preset } from '@mandate/live-agents';
import { loadKeys, MANIFEST_PATH, REPO } from '../../evm-robinhood/scripts/lib.ts';
import { LiveSettlement, RobinhoodTestnetRpc, SEND_AUTHORIZATION_PHRASE, SendGate, parseDeployment, type SettlementOutcome, type SettlementRecord } from '../src/index.ts';

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'openai' },
    seed: { type: 'string', default: '0' },
    preset: { type: 'string', default: 'balanced' },
    json: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'authorization-timeout': { type: 'string', default: '300' },
  },
  strict: true,
});

const dryRun = values['dry-run'];
const json = values.json;
const out = (line: string) => process.stdout.write(`${line}\n`);
const say = (line: string) => {
  if (!json) out(line);
};
const fail = (code: number, message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const show = (v: object) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x), 2);

const isPreset = (p: string | undefined): p is Preset => p !== undefined && (PRESETS as readonly string[]).includes(p);
if (!isPreset(values.preset)) fail(1, `--preset must be one of ${PRESETS.join(', ')}`);
const timeoutSeconds = Number(values['authorization-timeout']);
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 540) fail(1, '--authorization-timeout must be 1–540 seconds (a signed proposal lives 600 protocol seconds)');

const config = readConfig();
let provider: AgentModelProvider;
if (values.provider === 'stub') {
  if (!dryRun) fail(1, 'A stub decision is never settled on Robinhood Chain testnet: use --dry-run with --provider=stub, or --provider=openai to send.');
  provider = new StubProvider(Number(values.seed) || 0);
} else if (values.provider === 'openai') {
  if (config.openaiApiKey === null) fail(2, 'OPENAI_API_KEY is not set (environment or a gitignored .env at the repository root). Refusing to run the live mode; use --provider=stub --dry-run for an offline decision.');
  provider = new OpenAIProvider({ apiKey: config.openaiApiKey as string, model: config.openaiModel });
} else {
  provider = fail(1, '--provider must be openai or stub');
}

// --- The deployment and the disposable keys ---------------------------------------------------------
const deployment = parseDeployment(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
if (!deployment.ok) fail(1, `deployment manifest refused: ${deployment.error}`);
const d = deployment.ok ? deployment.value : (null as never);
const keys = loadKeys();
if (keys.principal.address !== d.principal || keys.agent.address !== d.agent || keys.deployer.address !== d.submitter) fail(1, 'the disposable keys are not the manifest parties; refusing');

// --- A send refuses while an earlier one is unresolved -------------------------------------------------
const RUNS = join(REPO, '.robinhood-testnet', 'runs');
function unresolved(): readonly SettlementRecord[] {
  if (!existsSync(RUNS)) return [];
  const open: SettlementRecord[] = [];
  for (const dir of readdirSync(RUNS).filter((n) => n.startsWith('live-ai-'))) {
    const f = join(RUNS, dir, 'settlement.json');
    if (!existsSync(f)) continue;
    const log = JSON.parse(readFileSync(f, 'utf8')) as { records: SettlementRecord[] };
    const last = log.records.at(-1);
    if (last !== undefined && (last.state === 'SUBMISSION_STARTED' || last.state === 'SUBMITTED' || last.state === 'UNKNOWN')) open.push(last);
  }
  return open;
}
if (!dryRun) {
  const open = unresolved();
  if (open.length > 0) fail(1, `An earlier testnet submission is unresolved; check it before any new attempt (nothing is resent):\n${open.map((r) => `  ${r.state} ${r.txHash}`).join('\n')}`);
}

// --- The Live AI session --------------------------------------------------------------------------------
const session = new LiveSession({ provider, agentTimeoutMs: config.agentTimeoutMs, roomRoundTimeoutMs: config.roomRoundTimeoutMs });
const print = (e: LiveEvent) => (json ? out(JSON.stringify(e)) : out(renderEvent(e)));
for (const e of session.events.events) print(e);
session.events.subscribe(print);
say(`Mandate — Live AI Lab → Robinhood Chain TESTNET settlement${dryRun ? ' [DRY RUN: nothing is broadcast]' : ''} · ${describeConfig(config)}`);
say(`Network ${d.networkName} (${d.chainId}) · gate ${d.gate.address} (from ${MANIFEST_PATH.replace(REPO, '')})\n`);

const draft = session.presetDraft(values.preset as Preset);
const confirmation = session.versions.expectedConfirmation;
say(`Principal confirmation (supplied by this command-line run): ${confirmation}`);
const auth = await session.authorize(draft, confirmation);
if (!auth.ok) {
  await session.complete({ status: 'AUTHORIZATION_REFUSED', code: auth.code });
  fail(3, `Authorization refused: ${auth.code} — ${auth.message}`);
}
const run = await session.run();
const summary = summarizeRun(run);
say(`\nLive AI run: ${summary.status} · reserved ${summary.reserved} USDC · Live AI transactions ${summary.transactions}`);

// --- Settlement -----------------------------------------------------------------------------------------
const rpc = new RobinhoodTestnetRpc(keys.deployer.privateKey, d.gate.address);
const settlement = new LiveSettlement({ session, deployment: d, rpc, keys: { principal: keys.principal.privateKey, agent: keys.agent.privateKey } });
const prepared = await settlement.prepare();
const finish = async (code: number, result: object): Promise<never> => {
  await session.complete({ run: summary, settlement: result });
  process.exit(code);
};
if ('ineligible' in prepared) {
  say(`\nNo eligible Stock action this run (${prepared.stage}: ${prepared.ineligible}). Nothing was signed or sent.`);
  await finish(4, { status: 'NO_ELIGIBLE_STOCK_ACTION', reason: prepared.ineligible });
}
const p = 'ineligible' in prepared ? (null as never) : prepared;

const scratch = mkdtempSync(join(tmpdir(), 'mandate-live-settlement-dry-'));
let dry: SettlementOutcome;
try {
  dry = await settlement.run(p, { mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: join(scratch, 'ledger.db') });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (dry.status !== 'READY') {
  say(`\nDry run did not reach READY: ${show(dry)}\nNothing was broadcast.`);
  await finish(dry.status === 'INELIGIBLE' ? 4 : 5, { status: dry.status });
}
const ready = dry.status === 'READY' ? dry : (null as never);
say('\n=== DRY RUN — the transaction that WOULD be sent (nothing broadcast) ===');
say(show({ preflight: ready.preflight, wouldSend: ready.wouldSend, liveAi: { proposal: p.execution.proposal, reservation: p.execution.reservation, candidateId: p.execution.candidateId, bindingDigest: p.settlement.bindingDigest } }));

if (dryRun) await finish(0, { status: 'DRY_RUN_READY', broadcasts: 0 });

// --- The explicit send gate -----------------------------------------------------------------------------
session.events.emit('TESTNET_SEND_AUTHORIZATION_REQUIRED', { agent: 'stock', data: { required: SEND_AUTHORIZATION_PHRASE, wouldSend: ready.wouldSend, timeoutSeconds } });
say(`\nREADY FOR ROBINHOOD TESTNET SEND. Type exactly "${SEND_AUTHORIZATION_PHRASE}" within ${timeoutSeconds} s to broadcast ONE transaction; anything else sends nothing.`);
const line = await new Promise<string | null>((resolve) => {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const timer = setTimeout(() => {
    rl.close();
    resolve(null);
  }, timeoutSeconds * 1_000);
  rl.once('line', (l) => {
    clearTimeout(timer);
    rl.close();
    resolve(l);
  });
  rl.once('close', () => {
    clearTimeout(timer);
    resolve(null);
  });
});
const gate = new SendGate();
if (line === null || !gate.authorize(line)) {
  session.events.emit('TESTNET_SEND_AUTHORIZATION_REFUSED', { agent: 'stock', data: { required: SEND_AUTHORIZATION_PHRASE, received: line === null ? 'nothing' : 'another text', transactions: 0 } });
  say('Not authorized. Nothing was broadcast.');
  await finish(6, { status: 'NOT_AUTHORIZED', broadcasts: 0 });
}

const runDir = join(RUNS, `live-ai-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(runDir, { recursive: true, mode: 0o700 });
const records: SettlementRecord[] = [];
const recordPath = join(runDir, 'settlement.json');
const writeRecord = (r: SettlementRecord) => {
  records.push(r);
  writeFileSync(recordPath, `${show({ label: 'Live AI testnet settlement record (public identifiers only; gitignored)', records })}\n`, { mode: 0o600 });
};
const sent = await settlement.run(p, { mode: 'SEND', gate, ledgerPath: join(runDir, 'ledger.db'), record: writeRecord });
say(`\n=== SETTLEMENT ===\n${show(sent)}`);
await finish(sent.status === 'CONFIRMED' && sent.evidence === 'LIVE_TESTNET' ? 0 : 7, { status: sent.status, evidence: 'evidence' in sent ? sent.evidence : null, txHash: 'txHash' in sent ? sent.txHash : null });
