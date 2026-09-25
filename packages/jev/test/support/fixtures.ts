/**
 * Recorded Jev exchange fixtures.
 *
 * A fixture pins the *contract*: that a body of this shape parses to this
 * answer. It is deliberately not a claim about what the model should choose.
 * The model behind an alias changes, and a fixture asserting a particular
 * selection would be asserting that an external service never improves.
 *
 * Two capture classes, and the difference matters enough to be machine-checked:
 *
 * - `LIVE` — a real exchange with the service, sanitized. Carries a capture
 *   date, the requested and returned model, usage and an observed latency.
 * - `SCHEMA_DERIVED` — constructed from the published schema. It exercises the
 *   parser and nothing else, and it is **not** evidence that the service
 *   behaves this way.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));

export const CaptureClass = {
  LIVE: 'LIVE',
  SCHEMA_DERIVED: 'SCHEMA_DERIVED',
} as const;
export type CaptureClass = (typeof CaptureClass)[keyof typeof CaptureClass];

export interface JevFixture {
  readonly fixtureVersion: 1;
  readonly id: string;
  readonly captureClass: CaptureClass;
  readonly capturedAt: string;
  readonly note: string;
  readonly endpoint: string;
  readonly modelRequested: string;
  readonly modelReturned: string | null;
  readonly request: unknown;
  readonly response: unknown;
  readonly observedLatencyMs: number | null;
  readonly digest: string;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+\S+/i,
  /TYPESAFE_API_KEY\s*[:=]/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /"authorization"\s*:/i,
];

function object(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${label} must be an object`);
  return raw as Record<string, unknown>;
}

/** Digest over the fixture with `digest` removed, key-sorted. */
export function fixtureDigest(fixture: Omit<JevFixture, 'digest'>): string {
  const canonical = JSON.stringify(fixture, Object.keys(fixture).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

export function listFixturePaths(root = FIXTURE_ROOT): readonly string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === '.json')
    .map((entry) => join(root, entry.name))
    .sort();
}

export interface FixtureValidationReport {
  readonly fixtures: number;
  readonly live: number;
  readonly schemaDerived: number;
}

/**
 * Validate every fixture: structure, digest integrity, capture-class rules and
 * the absence of anything credential-shaped.
 */
export function validateFixtures(root = FIXTURE_ROOT): FixtureValidationReport {
  const paths = listFixturePaths(root);
  if (paths.length === 0) throw new Error('no Jev fixtures found');
  let live = 0;
  let schemaDerived = 0;
  const ids = new Set<string>();

  for (const path of paths) {
    const text = readFileSync(resolve(path), 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) throw new Error(`${path}: fixture contains credential-shaped content`);
    }
    const fixture = object(JSON.parse(text) as unknown, path);
    if (fixture['fixtureVersion'] !== 1) throw new Error(`${path}: unsupported fixture version`);
    const id = fixture['id'];
    if (typeof id !== 'string' || id.length === 0 || ids.has(id)) throw new Error(`${path}: missing or duplicate id`);
    ids.add(id);

    const captureClass = fixture['captureClass'];
    if (captureClass !== CaptureClass.LIVE && captureClass !== CaptureClass.SCHEMA_DERIVED) {
      throw new Error(`${path}: captureClass must be LIVE or SCHEMA_DERIVED`);
    }
    for (const field of ['capturedAt', 'note', 'endpoint', 'modelRequested']) {
      if (typeof fixture[field] !== 'string' || (fixture[field] as string).length === 0) throw new Error(`${path}: ${field} is missing`);
    }
    if (!('modelReturned' in fixture) || !('request' in fixture) || !('response' in fixture) || !('observedLatencyMs' in fixture)) {
      throw new Error(`${path}: fixture is missing a required field`);
    }

    if (captureClass === CaptureClass.SCHEMA_DERIVED) {
      // A constructed fixture must not claim a measurement it does not have,
      // and must say what it is in its own note.
      if (fixture['observedLatencyMs'] !== null) throw new Error(`${path}: a schema-derived fixture cannot report an observed latency`);
      if (!/not a recording|constructed from/i.test(fixture['note'] as string)) throw new Error(`${path}: a schema-derived fixture must say so in its note`);
      schemaDerived += 1;
    } else {
      if (typeof fixture['observedLatencyMs'] !== 'number') throw new Error(`${path}: a live fixture must report its observed latency`);
      if (typeof fixture['modelReturned'] !== 'string') throw new Error(`${path}: a live fixture must record the returned model`);
      live += 1;
    }

    const digest = fixture['digest'];
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${path}: invalid digest`);
    const { digest: _ignored, ...rest } = fixture as unknown as JevFixture;
    if (fixtureDigest(rest) !== digest) throw new Error(`${path}: digest mismatch`);
  }

  return { fixtures: paths.length, live, schemaDerived };
}

export function loadFixtures(root = FIXTURE_ROOT): readonly JevFixture[] {
  return listFixturePaths(root).map((path) => JSON.parse(readFileSync(path, 'utf8')) as JevFixture);
}
