import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildMainnetReplayCorpus, buildMainnetReplayReport } from '../test/support/mainnet-replay.ts';

export const MAINNET_CORPUS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../corpus/mainnet-v1');
export const MAINNET_CORPUS_PATH = resolve(MAINNET_CORPUS_DIRECTORY, 'vectors.json');
export const MAINNET_REPORT_PATH = resolve(MAINNET_CORPUS_DIRECTORY, 'report.json');

export function serializeMainnetCorpus(): string {
  return `${JSON.stringify(buildMainnetReplayCorpus(), null, 2)}\n`;
}

export function serializeMainnetReport(): string {
  return `${JSON.stringify(buildMainnetReplayReport(), null, 2)}\n`;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  mkdirSync(MAINNET_CORPUS_DIRECTORY, { recursive: true });
  writeFileSync(MAINNET_CORPUS_PATH, serializeMainnetCorpus(), 'utf8');
  writeFileSync(MAINNET_REPORT_PATH, serializeMainnetReport(), 'utf8');
  process.stdout.write(`wrote ${MAINNET_CORPUS_PATH}\nwrote ${MAINNET_REPORT_PATH}\n`);
}
