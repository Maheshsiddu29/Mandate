/**
 * Build-time bridge from the canonical judge-demo runner to the static
 * frontend asset.
 *
 * The browser never runs this. `npm run web:demo:generate` invokes
 * `npm run demo:judge:json` (the Milestone A runner), checks the transcript,
 * and writes its bytes. `npm run web:demo:check` repeats that and fails if
 * the committed asset differs.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JUDGE_DEMO_SCHEMA,
  JUDGE_DEMO_SCHEMA_VERSION,
  presentationDigest,
  type JudgeEvent,
} from '../packages/judge-demo/src/events.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const JUDGE_DEMO_ASSET = resolve(root, 'apps/web/generated/judge-demo.v1.json');

export interface ValidatedTranscript {
  readonly text: string;
  readonly eventCount: number;
  readonly presentationDigest: string;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`judge demo asset: ${message}`);
}

/** Parse runner stdout and refuse a transcript whose digest does not reproduce. */
export function validateRunnerStdout(text: string): ValidatedTranscript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('runner stdout is not JSON');
  }
  if (!isRecord(parsed)) fail('transcript is not an object');
  if (parsed['schema'] !== JUDGE_DEMO_SCHEMA) fail(`schema is ${String(parsed['schema'])}`);
  if (parsed['version'] !== JUDGE_DEMO_SCHEMA_VERSION) fail(`version is ${String(parsed['version'])}`);
  if (parsed['presentationOnly'] !== true) fail('presentationOnly is not true');
  const events = parsed['events'];
  if (!Array.isArray(events) || events.length === 0) fail('events are missing');
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!isRecord(event)) fail(`event ${i} is not an object`);
    if (event['schema'] !== JUDGE_DEMO_SCHEMA) fail(`event ${i} has the wrong schema`);
    if (event['sequence'] !== i) fail(`event ${i} sequence is ${String(event['sequence'])}`);
    if (typeof event['scene'] !== 'number' || typeof event['kind'] !== 'string' || typeof event['message'] !== 'string') {
      fail(`event ${i} is missing scene, kind, or message`);
    }
  }
  const digest = presentationDigest(events as readonly JudgeEvent[]);
  if (parsed['presentationDigest'] !== digest) fail('presentationDigest does not match the events');
  const normalized = text.endsWith('\n') ? text : `${text}\n`;
  return { text: normalized, eventCount: events.length, presentationDigest: digest };
}

/** The canonical `demo:judge:json` runner, captured exactly. */
export function runCanonicalTranscript(): ValidatedTranscript {
  const text = execFileSync(process.execPath, ['packages/judge-demo/scripts/judge-demo.ts', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return validateRunnerStdout(text);
}

export function writeJudgeDemoAsset(): ValidatedTranscript {
  const transcript = runCanonicalTranscript();
  mkdirSync(dirname(JUDGE_DEMO_ASSET), { recursive: true });
  writeFileSync(JUDGE_DEMO_ASSET, transcript.text);
  return transcript;
}

export function committedJudgeDemoAsset(): string {
  return readFileSync(JUDGE_DEMO_ASSET, 'utf8');
}
