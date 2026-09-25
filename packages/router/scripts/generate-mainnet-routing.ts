import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildMainnetRoutingCorpus, buildMainnetRoutingReport } from '../test/support/mainnet-routing.ts';

const output = fileURLToPath(new URL('../../../corpus/mainnet-routing-v1/', import.meta.url));
mkdirSync(output, { recursive: true });
const corpus = buildMainnetRoutingCorpus();
const report = buildMainnetRoutingReport();
writeFileSync(`${output}vectors.json`, `${JSON.stringify(corpus, null, 2)}\n`);
writeFileSync(`${output}report.json`, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
