import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '../..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

const importPattern = /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
function imports(text: string): string[] {
  return [...text.matchAll(importPattern)].map((match) => match[1] ?? '');
}

test('adapter dependency direction is adapter -> registry -> kernel only', () => {
  for (const packageName of ['kernel', 'registry']) {
    for (const path of sources(resolve(repoRoot, `packages/${packageName}/src`))) {
      for (const specifier of imports(readFileSync(path, 'utf8'))) {
        assert.equal(specifier.includes('adapter-robinhood'), false, `${path} imports the external adapter`);
      }
    }
  }
  for (const path of sources(resolve(packageRoot, 'src'))) {
    for (const specifier of imports(readFileSync(path, 'utf8'))) {
      if (specifier.startsWith('.')) continue;
      assert.ok(
        specifier === '@mandate/kernel' || specifier === '@mandate/registry',
        `${path} imports unexpected runtime package ${specifier}`,
      );
    }
  }
});

test('adapter declares only registry and kernel runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ['@mandate/kernel', '@mandate/registry']);
});
