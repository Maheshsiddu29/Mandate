import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runSimulation } from '../src/testing/index.ts';
import { COMMITTED_SIMULATION_CONFIG, simulationTemplate } from '../test/support/simulation.ts';

const output = fileURLToPath(new URL('../../../corpus/routing-simulation-v1/', import.meta.url));
mkdirSync(output, { recursive: true });
const report = {
  reportVersion: 1,
  config: COMMITTED_SIMULATION_CONFIG,
  metrics: runSimulation(COMMITTED_SIMULATION_CONFIG, () => simulationTemplate()),
};
writeFileSync(`${output}report.json`, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report.metrics, null, 2)}\n`);
