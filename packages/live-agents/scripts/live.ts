/**
 * The Live AI Lab from the command line (docs/demo/live-ai-lab.md §11).
 *
 *   npm run agents:stub        deterministic stub provider, text
 *   npm run agents:live        OpenAI Responses API, text
 *   npm run agents:live:json   OpenAI, MANDATE_LIVE_AI.V1 events as JSON lines
 *
 * Options: --provider=openai|stub  --seed=N (stub)  --preset=balanced|conservative|aggressive
 *          --prompt="…" [--fill=<preset>]  --chaos=<spec> (development only)
 *          --intent="…" (the principal's ranking preference; no authority)
 *          --policy-attempts=N  --no-policy-stress  --json
 *
 * The principal's confirmation "AUTHORIZE MANDATE V1" is supplied by this
 * run on the principal's behalf and printed as such. A draft with blocking
 * issues is never authorized: the run prints them and exits 3. Without
 * OPENAI_API_KEY the OpenAI modes refuse to run and exit 2, so a blocked
 * run is never mistaken for a passing one. No transaction is sent.
 */

import { parseArgs } from 'node:util';
import {
  DEFAULT_POLICY_STRESS_ATTEMPTS,
  LatencyChaosProvider,
  LiveSession,
  OpenAIProvider,
  PRESETS,
  StubProvider,
  describeConfig,
  readConfig,
  realClock,
  type AgentModelProvider,
  type LiveEvent,
  type MandateDraft,
  type Preset,
} from '../src/index.ts';
import { parseChaosSpec } from '../src/runtime/latency-chaos.ts';
import { renderEvent } from '../src/telemetry/render.ts';
import { summarizePolicyStress, summarizeRun } from '../src/telemetry/summary.ts';

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'openai' },
    seed: { type: 'string', default: '0' },
    preset: { type: 'string', default: 'balanced' },
    prompt: { type: 'string' },
    intent: { type: 'string' },
    fill: { type: 'string' },
    chaos: { type: 'string' },
    'policy-attempts': { type: 'string', default: String(DEFAULT_POLICY_STRESS_ATTEMPTS) },
    'no-policy-stress': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
  strict: true,
});

const json = values.json;
// A reader that stops early (| head) is not an error.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});
const out = (line: string) => process.stdout.write(`${line}\n`);
const say = (line: string) => {
  if (!json) out(line);
};
const fail = (code: number, message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const isPreset = (p: string | undefined): p is Preset => p !== undefined && (PRESETS as readonly string[]).includes(p);
if (!isPreset(values.preset)) fail(1, `--preset must be one of ${PRESETS.join(', ')}`);
if (values.fill !== undefined && !isPreset(values.fill)) fail(1, `--fill must be one of ${PRESETS.join(', ')}`);
const attempts = Number(values['policy-attempts']);
if (!Number.isSafeInteger(attempts) || attempts < 1) fail(1, '--policy-attempts must be a positive integer');

const config = readConfig();
let provider: AgentModelProvider;
if (values.provider === 'stub') {
  provider = new StubProvider(Number(values.seed) || 0);
} else if (values.provider === 'openai') {
  if (config.openaiApiKey === null) fail(2, 'OPENAI_API_KEY is not set (environment or a gitignored .env at the repository root). Refusing to run the live mode; use npm run agents:stub for the offline run.');
  provider = new OpenAIProvider({ apiKey: config.openaiApiKey as string, model: config.openaiModel });
} else {
  provider = fail(1, '--provider must be openai or stub');
}
if (values.chaos !== undefined) {
  const plan = parseChaosSpec(values.chaos);
  if ('error' in plan) fail(1, `--chaos: ${plan.error}`);
  else provider = new LatencyChaosProvider(provider, plan, realClock);
}

const session = new LiveSession({ provider, agentTimeoutMs: config.agentTimeoutMs, roomRoundTimeoutMs: config.roomRoundTimeoutMs, chaos: values.chaos ?? null, ...(values.intent === undefined ? {} : { intent: values.intent }) });
const print = (e: LiveEvent) => (json ? out(JSON.stringify(e)) : out(renderEvent(e)));
// SESSION_STARTED is emitted by the constructor, before anyone can subscribe.
for (const e of session.events.events) print(e);
session.events.subscribe(print);
say(`Mandate — Live AI Lab · ${describeConfig(config)}`);
say('Humans define authority. Agents operate autonomously. Mandate decides what may settle.\n');

let draft: MandateDraft;
if (values.prompt !== undefined) {
  const r = await session.interpret(values.prompt);
  if (r.draft === null) fail(3, `The prompt could not be interpreted: ${r.error ?? 'no draft'}. Nothing was authorized.`);
  draft = r.draft as MandateDraft;
  if (values.fill !== undefined) {
    const filled = session.fillUnset(draft, values.fill as Preset);
    draft = filled.draft;
    say(`Filled ${filled.filled.length} unset field(s) from the ${values.fill} preset, as asked: ${filled.filled.join(', ') || 'none'}`);
  }
} else {
  draft = session.presetDraft(values.preset as Preset);
  say(`Draft: the ${values.preset} preset (a starting point, not a recommendation).`);
}

const validation = session.validate(draft);
if (!validation.ok) {
  say('The draft has blocking issues; nothing is authorized:');
  for (const i of validation.issues.filter((x) => x.severity === 'BLOCKING')) say(`  ${i.code} ${i.field ?? ''} — ${i.message}`);
  await session.complete({ status: 'DRAFT_BLOCKED' });
  process.exit(3);
}
const confirmation = session.versions.expectedConfirmation;
say(`Principal confirmation (supplied by this command-line run): ${confirmation}`);
const auth = await session.authorize(draft, confirmation);
if (!auth.ok) {
  await session.complete({ status: 'AUTHORIZATION_REFUSED', code: auth.code });
  fail(3, `Authorization refused: ${auth.code} — ${auth.message}`);
}

const run = await session.run();
const runSummary = summarizeRun(run);
const stress = values['no-policy-stress'] ? null : summarizePolicyStress(await session.runPolicyStress({ maxAttempts: attempts }));
await session.complete({ run: runSummary, policyStress: stress });

if (!json) {
  say('\n=== Run summary (safe telemetry) ===');
  say(`status ${runSummary.status} · mandate V${runSummary.mandateVersion ?? '—'} · reserved ${runSummary.reserved} USDC · transactions ${runSummary.transactions}`);
  for (const a of runSummary.agents) {
    say(`  ${a.role.padEnd(6)} ${a.state.padEnd(16)} ${(a.candidateId ?? '—').padEnd(16)} ${(a.requested === null ? '—' : `${a.requested} USDC`).padEnd(10)} provider ${a.providerLatencyMs ?? '—'} ms · validate ${a.validationLatencyMs ?? '—'} ms · sign ${a.signingLatencyMs ?? '—'} ms · mandate ${a.mandateLatencyMs ?? '—'} ms${a.injectedLatencyMs > 0 ? ` · injected ${a.injectedLatencyMs} ms` : ''}`);
    if (a.rationale !== null) say(`         declared rationale: “${a.rationale}”`);
    if (a.reasons.length > 0) say(`         Mandate: ${a.reasons.join(', ')}`);
    if (a.error !== null) say(`         runtime: ${a.error}`);
  }
  if (runSummary.room !== null) say(`  room ${runSummary.room.status} · ${runSummary.room.generations} generation(s) · ${runSummary.room.durationMs} ms · agreed ${runSummary.room.agreed.map((x) => `${x.role} ${x.amount}`).join(', ')}`);
  for (const f of runSummary.final) say(`  final ${f.role.padEnd(6)} ${f.outcome.padEnd(9)} ${f.requested} USDC${f.reasons.length > 0 ? ` · ${f.reasons.join(', ')}` : ''}`);
  if (stress !== null) {
    say('\n=== POLICY STRESS TEST — VALID AGENT ≠ VALID ACTION ===');
    for (const a of stress.attempts) say(`  attempt ${a.attempt} ${a.caseId.padEnd(24)} ${a.outcome.padEnd(13)} ${a.reasons.join(', ')}${a.rationale === '' ? '' : `  “${a.rationale}”`}`);
    say(`  ended: ${stress.endedBy}`);
  }
}
