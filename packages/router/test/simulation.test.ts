import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runSimulation } from '../src/testing/index.ts';
import { COMMITTED_SIMULATION_CONFIG, simulationTemplate } from './support/simulation.ts';

describe('execution-world simulation', () => {
  it('reproduces a seeded run with zero unsafe handoffs', () => {
    const first = runSimulation(COMMITTED_SIMULATION_CONFIG, () => simulationTemplate());
    const second = runSimulation(COMMITTED_SIMULATION_CONFIG, () => simulationTemplate());
    assert.deepEqual(first, second);
    assert.equal(first.worldsEvaluated, 200);
    assert.ok(first.candidatesGenerated >= 200);
    assert.ok(first.maliciousCandidatesGenerated > 0);
    assert.equal(first.maliciousCandidatesSelected, 0);
    assert.equal(first.unsafeCandidatesReachingExecutionHandoff, 0);
    assert.equal(first.determinismFailures, 0);
    assert.equal(first.receiptReproductionFailures, 0);
  });

  it('matches the committed machine-readable report', () => {
    const generated = runSimulation(COMMITTED_SIMULATION_CONFIG, () => simulationTemplate());
    const committed = JSON.parse(readFileSync(new URL('../../../corpus/routing-simulation-v1/report.json', import.meta.url), 'utf8'));
    assert.deepEqual(committed, { reportVersion: 1, config: COMMITTED_SIMULATION_CONFIG, metrics: generated });
  });
});
