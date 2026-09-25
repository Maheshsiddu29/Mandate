import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const PACKAGE_ROOT = new URL('../', import.meta.url);
const SRC_ROOT = new URL('../src/', import.meta.url);

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

describe('router structural boundary', () => {
  it('has only stable Mandate packages as runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE_ROOT), 'utf8')) as { dependencies?: Record<string, string> };
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ['@mandate/kernel', '@mandate/registry']);
  });

  it('contains no network, filesystem, implicit clock, randomness, model or Jev client imports', () => {
    const forbiddenImports = /from\s+['"](?:node:)?(?:fs|http|https|net|tls|dgram|child_process|worker_threads)|from\s+['"][^'"]*(?:openai|anthropic|jev|langchain)/i;
    const forbiddenCalls = /\b(?:fetch|Date\.now|Math\.random|setTimeout|setInterval)\s*\(/;
    for (const file of sourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, forbiddenImports, file);
      assert.doesNotMatch(source, forbiddenCalls, file);
    }
  });
});
