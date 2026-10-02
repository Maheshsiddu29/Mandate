/**
 * Live AI Lab with the V2 settlement spine on the same loopback port
 * (docs/demo/authority-spine-v2.md). EXPLICIT ONLY: never run by `npm test`
 * or `npm run check`. `npm run agents:serve` does not start this.
 *
 *   npm run agents:lab
 *   npm run agents:lab -- --dev-chaos
 *
 * The browser then dry-runs and sends through POST /api/live/sessions/:id/settle.
 * That calls `settleSpine` — the same re-verify as `npm run agents:settle:v2`.
 * The wallet signs typed data. The deployer key pays gas and broadcasts.
 * A missing manifest or key file does not stop the lab: settlement routes
 * answer 503 and the rest of the API still serves.
 *
 * Keys: the gitignored 7E.3 disposable testnet keys. No key is printed.
 * RPC: ROBINHOOD_TESTNET_RPC_URL or the public testnet RPC; the URL is never printed.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenAIProvider, readConfig, realClock, sessionDir } from '@mandate/live-agents';
import type { ApiRequest, ApiResponse } from '../../live-agents/src/server/app.ts';
import { LiveLab } from '../../live-agents/src/server/app.ts';
import { createLabServer, listen } from '../../live-agents/src/server/http.ts';
import { loadKeys, MANIFEST_PATH } from '../../evm-robinhood/scripts/lib.ts';
import { RobinhoodTestnetRpc, SettlementJournal, parseDeployment, settleSpine } from '../src/index.ts';
import { SpineUi, type LabRouteResponse } from '../src/ui-settle.ts';
import { readRpcConfig } from './rpc-config.ts';

const { values } = parseArgs({ options: { 'dev-chaos': { type: 'boolean', default: false } }, strict: true });
const config = readConfig();
const SIGNATURE_WAIT_MS = 180_000;

function unavailable(message: string): (r: ApiRequest) => Promise<ApiResponse | null> {
  return (r) => {
    if (r.path === '/api/live/settlement' || /^\/api\/live\/sessions\/[A-Za-z0-9-]{1,64}\/settle$/.test(r.path)) {
      return Promise.resolve({ status: 503, body: { error: 'SETTLEMENT_UNAVAILABLE', message } });
    }
    return Promise.resolve(null);
  };
}

function asApi(r: LabRouteResponse): ApiResponse {
  return { status: r.status, body: r.body };
}

/** The settlement routes, or a 503 handler when the testnet files are not usable. */
function settlement(lab: LiveLab): { readonly before: (r: ApiRequest) => Promise<ApiResponse | null>; readonly note: string } {
  const rpcConfig = readRpcConfig();
  if (!rpcConfig.ok) return { before: unavailable(rpcConfig.error), note: `settlement unavailable: ${rpcConfig.error}` };
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return { before: unavailable('The testnet deployment manifest is not readable. Settlement routes are off; the lab still serves.'), note: 'settlement unavailable: deployment manifest' };
  }
  const deployment = parseDeployment(manifest);
  if (!deployment.ok) return { before: unavailable(`deployment manifest refused: ${deployment.error}`), note: 'settlement unavailable: deployment manifest refused' };
  const d = deployment.value;
  let keys: ReturnType<typeof loadKeys>;
  try {
    keys = loadKeys();
  } catch {
    return { before: unavailable('The disposable testnet keys are not readable. Settlement routes are off; the lab still serves.'), note: 'settlement unavailable: testnet keys' };
  }
  if (keys.principal.address !== d.principal || keys.agent.address !== d.agent || keys.deployer.address !== d.submitter) {
    return { before: unavailable('The disposable keys are not the manifest parties. Settlement routes are off.'), note: 'settlement unavailable: keys are not the manifest parties' };
  }
  const rpc = new RobinhoodTestnetRpc(keys.deployer.privateKey, d.gate.address, rpcConfig.endpoints);
  const domainKeys = { principal: keys.principal.privateKey, agent: keys.agent.privateKey };
  const ui = new SpineUi({
    openSession: (id) => lab.openSession(id),
    taskOf: (id) => lab.taskOf(id),
    settle: (input) => settleSpine(input),
    deployment: d,
    rpc,
    keys: domainKeys,
    journalFor: (session) => SettlementJournal.open(join(sessionDir(config.stateDir, session.id), 'settlement.db')),
    scratch: () => {
      const dir = mkdtempSync(join(tmpdir(), 'mandate-spine-dry-'));
      return { path: join(dir, 'domain-ledger.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    },
    ledgerPath: (session) => join(sessionDir(config.stateDir, session.id), 'domain-ledger.db'),
    schedule: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    signatureWaitMs: SIGNATURE_WAIT_MS,
  });
  return {
    before: async (r) => {
      const handled = await ui.handle(r.method, r.path, r.body);
      return handled === null ? null : asApi(handled);
    },
    note: `V2 settlement on this port · RPC ${rpcConfig.label}${rpcConfig.notes.length === 0 ? '' : ` · ${rpcConfig.notes.join(' · ')}`}`,
  };
}

const live = config.openaiApiKey === null ? null : new OpenAIProvider({ apiKey: config.openaiApiKey, model: config.openaiModel });
const lab = new LiveLab({ live, clock: realClock, agentTimeoutMs: config.agentTimeoutMs, roomRoundTimeoutMs: config.roomRoundTimeoutMs, allowChaos: values['dev-chaos'], stateDir: config.stateDir });
const attached = settlement(lab);
const server = createLabServer(lab, { port: config.port, allowedOrigins: config.allowedOrigins, before: attached.before });
await listen(server, config.port);
process.stdout.write(`Live AI Lab API on http://127.0.0.1:${config.port} · ${attached.note}${values['dev-chaos'] ? ' · DEV latency chaos allowed' : ''}\n`);
if (live === null) process.stdout.write('OPENAI_API_KEY is absent: only the deterministic stub provider is available. A testnet send still requires a live model.\n');
