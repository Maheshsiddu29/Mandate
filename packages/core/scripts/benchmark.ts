/**
 * Encoding cost of the Core objects that appear on every agent action.
 *
 * Measures, for representative objects, the canonical encoded size, the time
 * to encode an already-validated object, and the time to keccak-256 the
 * encoding. The purpose is to catch a pathological encoding, not to optimize:
 * numbers are machine-dependent and are reported, never asserted.
 *
 * Run: `npm run core:benchmark`. Offline; no output is written to disk.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  actionId,
  encodeActionEnvelope,
  encodeAuthorityGrant,
  encodeExecutionAuthorization,
  encodePrincipalPolicy,
  encodeStateBinding,
  stateBindingInputOf,
  stateId,
  validateActionEnvelope,
  validateAuthorityGrant,
  validateExecutionAuthorization,
  validatePrincipalPolicy,
  validateStateBinding,
  validateStateEnvelope,
} from '../src/index.ts';
import {
  must,
  sampleActionInput,
  sampleAuthorizationInput,
  sampleBindingInput,
  sampleGrantInput,
  samplePolicyInput,
  sampleStateInput,
} from '../test/support/fixtures.ts';

const ROUNDS = 7;
const ITERATIONS = 2_000;

function medianMicros(run: () => void): number {
  for (let i = 0; i < ITERATIONS; i += 1) run(); // warm-up
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < ITERATIONS; i += 1) run();
    samples.push(Number(process.hrtime.bigint() - start) / 1_000 / ITERATIONS);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] as number;
}

const action = must(validateActionEnvelope(sampleActionInput()));
const state = must(validateStateEnvelope(sampleStateInput()));
const binding = must(validateStateBinding(sampleBindingInput(stateId(state))));
const grant = must(validateAuthorityGrant(sampleGrantInput()));
const policy = must(validatePrincipalPolicy(samplePolicyInput()));
const authorization = must(validateExecutionAuthorization(sampleAuthorizationInput(actionId(action), [stateBindingInputOf(binding)])));

const cases: [string, () => Uint8Array][] = [
  ['ActionEnvelope', () => encodeActionEnvelope(action)],
  ['StateBinding', () => encodeStateBinding(binding)],
  ['AuthorityGrant (11 terms)', () => encodeAuthorityGrant(grant)],
  ['PrincipalPolicy (3 terms)', () => encodePrincipalPolicy(policy)],
  ['ExecutionAuthorization (1 binding)', () => encodeExecutionAuthorization(authorization)],
];

const rows = cases.map(([name, encode]) => {
  const bytes = encode();
  return {
    name,
    bytes: bytes.length,
    encode: medianMicros(() => void encode()),
    hash: medianMicros(() => void keccak_256(bytes)),
  };
});

process.stdout.write(`Core encoding benchmark: median of ${ROUNDS} rounds × ${ITERATIONS} iterations, Node ${process.version}\n\n`);
process.stdout.write('| Object | Encoded bytes | Encode (µs) | keccak-256 (µs) |\n| --- | ---: | ---: | ---: |\n');
for (const r of rows) process.stdout.write(`| ${r.name} | ${r.bytes} | ${r.encode.toFixed(1)} | ${r.hash.toFixed(1)} |\n`);
