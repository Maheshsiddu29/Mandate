/**
 * Live characterization of the TypeSafe Jev API.
 *
 * Run with a key in the environment and nothing else:
 *
 *     TYPESAFE_API_KEY=… npm run jev:characterize
 *
 * This is the **only** command in the repository that talks to Jev. Normal
 * tests, `npm run check` and CI are entirely offline.
 *
 * It makes a deliberately modest number of ordinary requests. It does not
 * stress, flood, fuzz or vulnerability-test the service: error behaviour is
 * observed from ordinary mistakes made once each, not from repetition.
 *
 * The key is read from the environment by the client and is never printed,
 * written to a fixture, or included in any output of this script.
 */

import { writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { performance } from 'node:perf_hooks';
import { openRegistry } from '@mandate/registry';
import { evaluateRoutes } from '@mandate/router';
import {
  API_KEY_ENVIRONMENT_VARIABLE,
  DEFAULT_MODEL,
  JEV_QUESTION_NAME,
  TypeSafeJevClient,
  buildClosedChoiceSet,
  buildRequestPayload,
  hasUsableApiKey,
  parseJevChoiceResponse,
  resolveChoice,
  type JevRequestPayload,
} from '../src/index.ts';
import {
  ROUTER_AUTHORIZATION, ROUTER_CLOCK, ROUTER_DOMAIN, ROUTER_MANDATE, ROUTER_REGISTRY_INPUT,
  ROUTER_REQUESTED_QUANTITY, ROUTER_STATE, routeQuote, trustedCost, zeroFee,
} from '../../router/test/support/fixture.ts';
import { fixtureDigest, FIXTURE_ROOT, type JevFixture } from '../test/support/fixtures.ts';

/** Successful probes. Small on purpose: this is characterization, not load. */
const SUCCESS_PROBES = 6;
const TIMEOUT_MS = 10_000;

if (!hasUsableApiKey()) {
  process.stderr.write(`${API_KEY_ENVIRONMENT_VARIABLE} is not set or is not header-safe.\nLive characterization is BLOCKED. Nothing was sent.\n`);
  process.exit(2);
}

const writeFixtures = process.argv.includes('--write-fixtures');

function buildWorld(candidateCount: number): { readonly payload: JevRequestPayload; readonly set: ReturnType<typeof buildClosedChoiceSet> } {
  const opened = openRegistry(ROUTER_REGISTRY_INPUT);
  if (!opened.ok) throw new Error('characterization registry did not open');
  const routes = Array.from({ length: candidateCount }, (_, index) => {
    const fee = { ...zeroFee(), atoms: BigInt(100 + index * 37) };
    return routeQuote({
      routeId: `characterize.route.${String(index).padStart(3, '0')}`,
      costs: { venueFee: fee, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() },
    });
  });
  const evaluated = evaluateRoutes({
    mandate: ROUTER_MANDATE, authorization: ROUTER_AUTHORIZATION, registry: opened.value,
    trustedMarketState: ROUTER_STATE, requestedQuantity: ROUTER_REQUESTED_QUANTITY,
    routes, trustedCosts: routes.map((quote) => trustedCost(quote)),
    clock: { nowUnixSeconds: ROUTER_CLOCK }, expectedDomain: ROUTER_DOMAIN,
  });
  if (evaluated.status !== 'EVALUATED') throw new Error('characterization world did not evaluate');
  const advisory: Record<string, { venueReliability: string; quoteFirmness: string }> = {};
  evaluated.evaluation.admissible.forEach((item, index) => {
    advisory[item.candidate.routeId] = {
      venueReliability: index % 3 === 0 ? 'ESTABLISHED' : index % 3 === 1 ? 'PROVISIONAL' : 'DEGRADED',
      quoteFirmness: index % 2 === 0 ? 'FIRM' : 'INDICATIVE',
    };
  });
  const set = buildClosedChoiceSet(evaluated.evaluation.admissible, advisory);
  return { payload: buildRequestPayload(ROUTER_MANDATE, set, DEFAULT_MODEL), set };
}

const client = new TypeSafeJevClient();
const { payload, set: closedSet } = buildWorld(4);

interface Probe {
  readonly probe: string;
  readonly ok: boolean;
  readonly reason: string | null;
  readonly latencyMs: number | null;
  readonly modelReturned: string | null;
  readonly choice: string | null;
  readonly confidence: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

const probes: Probe[] = [];
const latencies: number[] = [];
const fixtures: JevFixture[] = [];

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(1));
}

// --- Probe 1: which models this account may actually send ------------------
const listed = await client.listModels(TIMEOUT_MS);
const availableModels = listed.ok ? listed.value.map((item) => item.name) : [];
probes.push({
  probe: 'models', ok: listed.ok, reason: listed.ok ? null : listed.reason,
  latencyMs: null, modelReturned: null, choice: null, confidence: null, inputTokens: null, outputTokens: null,
});

// --- Probe 2..N: ordinary successful choice requests ------------------------
for (let index = 0; index < SUCCESS_PROBES; index += 1) {
  const started = performance.now();
  const outcome = await client.send(payload, TIMEOUT_MS);
  const latency = Number((performance.now() - started).toFixed(1));
  if (!outcome.ok) {
    probes.push({ probe: `choice-${index}`, ok: false, reason: outcome.reason, latencyMs: latency, modelReturned: null, choice: null, confidence: null, inputTokens: null, outputTokens: null });
    continue;
  }
  const parsed = parseJevChoiceResponse(outcome.body, JEV_QUESTION_NAME);
  if (!parsed.ok) {
    probes.push({ probe: `choice-${index}`, ok: false, reason: parsed.reason, latencyMs: latency, modelReturned: null, choice: null, confidence: null, inputTokens: null, outputTokens: null });
    continue;
  }
  latencies.push(latency);
  probes.push({
    probe: `choice-${index}`, ok: true, reason: null, latencyMs: latency,
    modelReturned: parsed.value.model, choice: parsed.value.choice, confidence: parsed.value.confidence,
    inputTokens: parsed.value.inputTokens, outputTokens: parsed.value.outputTokens,
  });
  if (index === 0) {
    const unsigned = {
      fixtureVersion: 1 as const,
      id: 'live-choice-001',
      captureClass: 'LIVE' as const,
      capturedAt: new Date().toISOString().slice(0, 10),
      note: 'Live TypeSafe exchange. Request and response are the real bodies; no credential is present in either.',
      endpoint: 'POST /v1/systemone',
      modelRequested: DEFAULT_MODEL,
      modelReturned: parsed.value.model,
      request: JSON.parse(JSON.stringify(payload)) as unknown,
      response: outcome.body,
      observedLatencyMs: latency,
    };
    fixtures.push({ ...unsigned, digest: fixtureDigest(unsigned) });
  }
}

// --- Probe: malformed request ----------------------------------------------
const malformed = await client.send({ ...payload, questions: {} as JevRequestPayload['questions'] }, TIMEOUT_MS);
probes.push({ probe: 'malformed', ok: malformed.ok, reason: malformed.ok ? null : malformed.reason, latencyMs: malformed.latencyMs, modelReturned: null, choice: null, confidence: null, inputTokens: null, outputTokens: null });

// --- Probe: a model the account cannot use ---------------------------------
const unknownModel = await client.send({ ...payload, model: 'jev-does-not-exist' }, TIMEOUT_MS);
probes.push({ probe: 'unknown-model', ok: unknownModel.ok, reason: unknownModel.ok ? null : unknownModel.reason, latencyMs: unknownModel.latencyMs, modelReturned: null, choice: null, confidence: null, inputTokens: null, outputTokens: null });

// --- Probe: a wrong credential ---------------------------------------------
const wrongKey = new TypeSafeJevClient({ env: { [API_KEY_ENVIRONMENT_VARIABLE]: 'not-a-valid-key-0000000000000000' } });
const unauthorized = await wrongKey.send(payload, TIMEOUT_MS);
probes.push({ probe: 'unauthorized', ok: unauthorized.ok, reason: unauthorized.ok ? null : unauthorized.reason, latencyMs: unauthorized.latencyMs, modelReturned: null, choice: null, confidence: null, inputTokens: null, outputTokens: null });

// --- Probe: a deadline shorter than the response ---------------------------
const impatient = await client.send(payload, 1);
probes.push({ probe: 'timeout', ok: impatient.ok, reason: impatient.ok ? null : impatient.reason, latencyMs: impatient.latencyMs, modelReturned: null, choice: null, confidence: null, inputTokens: null, outputTokens: null });

const sorted = [...latencies].sort((left, right) => left - right);
const successes = probes.filter((item) => item.probe.startsWith('choice-'));
const inputTokens = successes.map((item) => item.inputTokens).filter((value): value is number => value !== null);
const outputTokens = successes.map((item) => item.outputTokens).filter((value): value is number => value !== null);
const confidences = successes.map((item) => item.confidence).filter((value): value is number => value !== null);
const mean = (values: readonly number[]): number | null => values.length === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));

const report = {
  characterizationVersion: 1,
  runAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), architecture: arch(), cpu: cpus()[0]?.model ?? 'unknown' },
  methodology: `One models listing, ${SUCCESS_PROBES} ordinary choice requests with ${payload.state.candidateCount} candidates plus ABSTAIN, and one each of malformed, unknown-model, unauthorized and short-deadline. No repetition and no load.`,
  sampleSize: { successfulChoiceRequests: sorted.length, attemptedChoiceRequests: SUCCESS_PROBES },
  caveat: 'A handful of requests from one machine on one network is not a production SLA.',
  availableModels,
  modelRequested: DEFAULT_MODEL,
  modelsReturned: [...new Set(successes.map((item) => item.modelReturned).filter((value): value is string => value !== null))],
  successRate: Number((sorted.length / SUCCESS_PROBES).toFixed(3)),
  latencyMs: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), maximum: sorted.length === 0 ? null : sorted[sorted.length - 1] },
  usage: { meanInputTokens: mean(inputTokens), meanOutputTokens: mean(outputTokens) },
  confidence: { observed: confidences, minimum: confidences.length === 0 ? null : Math.min(...confidences), maximum: confidences.length === 0 ? null : Math.max(...confidences) },
  // Whether the service ever returned a name that was not in the set we sent.
  everyChoiceWasInTheClosedSet: successes.every((item) => item.choice === null || resolveChoice(closedSet, item.choice).kind !== 'OUT_OF_SET'),
  probes,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (writeFixtures && fixtures.length > 0) {
  for (const fixture of fixtures) {
    writeFileSync(`${FIXTURE_ROOT}${fixture.id}.json`, `${JSON.stringify(fixture, null, 2)}\n`);
    process.stdout.write(`wrote fixture ${fixture.id}\n`);
  }
}
