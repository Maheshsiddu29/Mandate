import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export interface FixtureValidationReport {
  readonly captureId: string;
  readonly artifacts: number;
  readonly bytes: number;
}

function object(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${label} must be an object`);
  return raw as Record<string, unknown>;
}

export function validateFixtureManifest(fixtureRoot: string): FixtureValidationReport {
  const root = resolve(fixtureRoot);
  const manifest = object(JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as unknown, 'manifest');
  if (manifest['version'] !== 1 || typeof manifest['captureId'] !== 'string') throw new Error('unsupported fixture manifest');
  if (manifest['schemaVersion'] !== 'not published') throw new Error('fixture must state the external schema-version limitation');
  const artifacts = manifest['artifacts'];
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('fixture has no artifacts');
  let bytes = 0;
  const seen = new Set<string>();
  for (let index = 0; index < artifacts.length; index += 1) {
    const item = object(artifacts[index], `artifact ${index}`);
    const path = item['path'];
    const sha256 = item['sha256'];
    if (typeof path !== 'string' || path.startsWith('/') || path.includes('..') || seen.has(path)) {
      throw new Error(`artifact ${index} has an unsafe or duplicate path`);
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`artifact ${path} has invalid digest`);
    if (typeof item['source'] !== 'string' || typeof item['capturedAt'] !== 'string' || !('sourceObservedAt' in item)) {
      throw new Error(`artifact ${path} is missing provenance`);
    }
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}${sep}`)) throw new Error(`artifact ${path} escapes fixture root`);
    const content = readFileSync(absolute);
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== sha256) throw new Error(`artifact ${path} digest mismatch: ${actual}`);
    seen.add(path);
    bytes += content.length;
  }
  return { captureId: manifest['captureId'], artifacts: artifacts.length, bytes };
}
