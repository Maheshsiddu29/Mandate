/**
 * Live AI Lab with V2 and optional V3 settlement spines on the same loopback
 * port (docs/demo/authority-spine-v2.md, docs/demo/c2-3-delegated-execution.md).
 * EXPLICIT ONLY: never run by `npm test` or `npm run check`.
 *
 *   npm run agents:lab
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenAIProvider, readConfig, realClock, sessionDir } from '@mandate/live-agents';
import { delegatedDomainSeparator } from '@mandate/execution-gate';
import type { ApiRequest, ApiResponse } from '../../live-agents/src/server/app.ts';
import { LiveLab } from '../../live-agents/src/server/app.ts';
import { createLabServer, listen } from '../../live-agents/src/server/http.ts';
import { configuredScorer } from '../../live-agents/scripts/jev.ts';
import { loadKeys, MANIFEST_PATH } from '../../evm-robinhood/scripts/lib.ts';
import {
  LiveV3ChallengeHost,
  RobinhoodTestnetRpc,
  SettlementJournal,
  V3_GATE_PLACEHOLDER,
  parseDeployment,
  reconcileAttempts,
  settleSpine,
  settleSpineV3,
  type TestnetDeployment,
} from '../src/index.ts';
import { SpineUi, type LabRouteResponse, type V3UiHost } from '../src/ui-settle.ts';
import { readRpcConfig } from './rpc-config.ts';

const { values } = parseArgs({ options: { 'dev-chaos': { type: 'boolean', default: false } }, strict: true });
const config = readConfig();
const SIGNATURE_WAIT_MS = 180_000;
const V3_VALIDITY_SECONDS = 3_600n;

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

function buildV3(d: TestnetDeployment, agentAddress: string): { readonly host: LiveV3ChallengeHost; readonly ui: V3UiHost } | null {
  const gate = V3_GATE_PLACEHOLDER;
  const host = new LiveV3ChallengeHost({
    chainId: d.chainId,
    gate,
    agent: agentAddress,
    fundingToken: d.mdusd.address,
    market: d.market,
    validitySeconds: V3_VALIDITY_SECONDS,
  });
  const nonces = new Map<string, bigint>();
  const debits = new Map<string, bigint>();
  return {
    host,
    ui: {
      host,
      settle: (input) => settleSpineV3(input),
      gate: {
        address: gate,
        domainSeparator: delegatedDomainSeparator(d.chainId, gate as never),
        runtimeCodeHash: `0x${'cd'.repeat(32)}`,
      },
      nextNonce: (sessionId) => nonces.get(sessionId) ?? 1n,
      markNonceUsed: (sessionId, nonce) => {
        nonces.set(sessionId, nonce + 1n);
      },
      usedDebit: (sessionId) => debits.get(sessionId) ?? 0n,
      addDebit: (sessionId, debit) => {
        debits.set(sessionId, (debits.get(sessionId) ?? 0n) + debit);
      },
    },
  };
}

function settlement(lab: LiveLab, v3: { readonly host: LiveV3ChallengeHost; readonly ui: V3UiHost } | null): { readonly before: (r: ApiRequest) => Promise<ApiResponse | null>; readonly note: string } {
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
    reconcile: (deps) => reconcileAttempts(deps),
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
    ...(v3 === null ? {} : { v3: v3.ui }),
  });
  return {
    before: async (r) => {
      const handled = await ui.handle(r.method, r.path, r.body, () => lab.handle(r));
      return handled === null ? null : asApi(handled);
    },
    note: `V2${v3 === null ? '' : '+V3'} settlement on this port · RPC ${rpcConfig.label}${rpcConfig.notes.length === 0 ? '' : ` · ${rpcConfig.notes.join(' · ')}`}`,
  };
}

const live = config.openaiApiKey === null ? null : new OpenAIProvider({ apiKey: config.openaiApiKey, model: config.openaiModel });
const scorer = configuredScorer();

let v3Bundle: { readonly host: LiveV3ChallengeHost; readonly ui: V3UiHost } | null = null;
try {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const deployment = parseDeployment(manifest);
  if (deployment.ok) {
    const keys = loadKeys();
    v3Bundle = buildV3(deployment.value, keys.agent.address);
  }
} catch {
  v3Bundle = null;
}

const lab = new LiveLab({
  live,
  clock: realClock,
  agentTimeoutMs: config.agentTimeoutMs,
  roomRoundTimeoutMs: config.roomRoundTimeoutMs,
  allowChaos: values['dev-chaos'],
  stateDir: config.stateDir,
  ...(scorer === undefined ? {} : { scorer }),
  ...(v3Bundle === null ? {} : { v3Host: v3Bundle.host }),
});
const attached = settlement(lab, v3Bundle);
const server = createLabServer(lab, { port: config.port, allowedOrigins: config.allowedOrigins, before: attached.before });
await listen(server, config.port);
process.stdout.write(`Live AI Lab API on http://127.0.0.1:${config.port} · ${attached.note}${values['dev-chaos'] ? ' · DEV latency chaos allowed' : ''}\n`);
if (live === null) process.stdout.write('OPENAI_API_KEY is absent: only the deterministic stub provider is available. A testnet send still requires a live model.\n');
process.stdout.write(scorer === undefined ? 'Jev scoring is not configured: Planning Rooms allocate on model ratings alone.\n' : `Jev scoring: ${scorer.name} (advisory only).\n`);
process.stdout.write(v3Bundle === null ? 'V3 delegated authorization is not available (manifest/keys missing).\n' : 'V3 delegated authorization is available (request spine: "V3").\n');
