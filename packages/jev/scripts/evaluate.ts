import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEvaluationReport } from '../test/support/corpus.ts';

const output = fileURLToPath(new URL('../../../corpus/jev-evaluation-v1/', import.meta.url));
mkdirSync(output, { recursive: true });
const report = await buildEvaluationReport();
writeFileSync(`${output}report.json`, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report['metrics'], null, 2)}\n`);
