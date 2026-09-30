/**
 * Validate a generated `MANDATE_JUDGE_DEMO.V1` transcript and recompute its
 * presentation digest. The digest detects drift. It is not a protocol commitment.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import type { AmountView, JudgeDemoEvent, JudgeTranscript } from './types.ts';

export const JUDGE_DEMO_SCHEMA = 'MANDATE_JUDGE_DEMO.V1';
export const JUDGE_DEMO_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as { readonly [key: string]: unknown };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`)
    .join(',')}}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '0x';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Same construction as the judge-demo contract: keccak-256 over canonical JSON. */
export function presentationDigestOf(events: readonly JudgeDemoEvent[]): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(canonicalJson(events))));
}

function asAmount(value: unknown): AmountView | null {
  if (!isRecord(value)) return null;
  if (
    typeof value['resource'] !== 'string' ||
    typeof value['unit'] !== 'string' ||
    typeof value['decimals'] !== 'number' ||
    typeof value['atoms'] !== 'string' ||
    typeof value['amount'] !== 'string'
  ) {
    return null;
  }
  return {
    resource: value['resource'],
    unit: value['unit'],
    decimals: value['decimals'],
    atoms: value['atoms'],
    amount: value['amount'],
  };
}

function asAmounts(value: unknown): AmountView[] | null {
  if (!Array.isArray(value)) return null;
  const amounts: AmountView[] = [];
  for (const item of value) {
    const amount = asAmount(item);
    if (amount === null) return null;
    amounts.push(amount);
  }
  return amounts;
}

function fail(message: string): never {
  throw new Error(`invalid judge demo transcript: ${message}`);
}

export function validateTranscript(input: unknown): JudgeTranscript {
  if (!isRecord(input)) fail('not an object');
  if (input['schema'] !== JUDGE_DEMO_SCHEMA) fail('schema');
  if (input['version'] !== JUDGE_DEMO_SCHEMA_VERSION) fail('version');
  if (input['presentationOnly'] !== true) fail('presentationOnly');
  if (typeof input['presentationDigest'] !== 'string' || !/^0x[0-9a-f]{64}$/.test(input['presentationDigest'])) {
    fail('presentationDigest');
  }
  if (!Array.isArray(input['events']) || input['events'].length === 0) fail('events');
  const events: JudgeDemoEvent[] = [];
  for (let index = 0; index < input['events'].length; index += 1) {
    const event = input['events'][index];
    if (!isRecord(event)) fail(`event ${index}`);
    if (event['schema'] !== JUDGE_DEMO_SCHEMA || event['sequence'] !== index) fail(`event ${index} identity`);
    if (typeof event['scene'] !== 'number' || typeof event['kind'] !== 'string' || typeof event['status'] !== 'string') {
      fail(`event ${index} kind`);
    }
    if (typeof event['message'] !== 'string' || !isRecord(event['data'])) fail(`event ${index} body`);
    const requested = asAmounts(event['requested']);
    const approved = asAmounts(event['approved']);
    if (requested === null || approved === null) fail(`event ${index} amounts`);
    const reasons = Array.isArray(event['reasons']) ? event['reasons'] : null;
    const artifacts = Array.isArray(event['artifacts']) ? event['artifacts'] : null;
    if (reasons === null || artifacts === null) fail(`event ${index} lists`);
    events.push(event as unknown as JudgeDemoEvent);
  }
  const digest = presentationDigestOf(events);
  if (digest !== input['presentationDigest']) fail('presentation digest mismatch');
  return {
    schema: JUDGE_DEMO_SCHEMA,
    version: JUDGE_DEMO_SCHEMA_VERSION,
    presentationOnly: true,
    events,
    presentationDigest: digest,
  };
}
