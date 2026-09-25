/**
 * The Jev package is the second network-aware package in the repository, and
 * the only one whose dependency is a non-deterministic external model. Its
 * boundary is therefore asserted structurally rather than trusted.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const PACKAGE_ROOT = new URL('../', import.meta.url);
const SRC_ROOT = new URL('../src/', import.meta.url);
const REPOSITORY_ROOT = new URL('../../../', import.meta.url);

function sourceFiles(path: URL): string[] {
  const root = fileURLToPath(path);
  const out: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (extname(target) === '.ts') out.push(target);
    }
  };
  visit(root);
  return out;
}

describe('jev structural boundary', () => {
  it('has only stable Mandate packages as runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE_ROOT), 'utf8')) as { dependencies?: Record<string, string> };
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ['@mandate/kernel', '@mandate/registry', '@mandate/router']);
  });

  it('confines network access to the client module', () => {
    const network = /\bfetch\s*\(|from\s+['"](?:node:)?(?:http|https|net|tls|dgram)['"]/;
    for (const file of sourceFiles(SRC_ROOT)) {
      if (file.endsWith('client.ts')) continue;
      assert.doesNotMatch(readFileSync(file, 'utf8'), network, file);
    }
  });

  it('reads the credential from one environment variable and nowhere else', () => {
    const environmentReads = /process\.env|\.env\b/;
    for (const file of sourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (file.endsWith('client.ts')) continue;
      assert.doesNotMatch(source, environmentReads, file);
    }
    const client = readFileSync(new URL('src/client.ts', PACKAGE_ROOT), 'utf8');
    const referenced = [...client.matchAll(/env\[([^\]]+)\]/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(referenced)], ['API_KEY_ENVIRONMENT_VARIABLE']);
  });

  it('never writes to standard output or error from library code', () => {
    // Secrets leak through logs. Scripts print; the library does not.
    for (const file of sourceFiles(SRC_ROOT)) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /console\.|process\.stdout|process\.stderr/, file);
    }
  });

  it('keeps the kernel, registry and router free of any dependency on it', () => {
    for (const name of ['kernel', 'registry', 'router']) {
      const manifest = JSON.parse(readFileSync(new URL(`packages/${name}/package.json`, REPOSITORY_ROOT), 'utf8')) as { dependencies?: Record<string, string> };
      assert.equal(Object.keys(manifest.dependencies ?? {}).includes('@mandate/jev'), false, name);
      for (const file of sourceFiles(new URL(`packages/${name}/src/`, REPOSITORY_ROOT))) {
        assert.doesNotMatch(readFileSync(file, 'utf8'), /@mandate\/jev/, file);
      }
    }
  });
});
