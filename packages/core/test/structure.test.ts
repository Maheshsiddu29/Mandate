/**
 * Structural boundary of the Core package (ADR 0020).
 *
 * Core is pure and domain-independent by construction, and these tests are
 * what makes that a checked property rather than a convention: its dependency
 * list, the imports and calls its sources contain, and the absence of the
 * untyped escape hatches Phase 7B forbids in production types.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = new URL('../', import.meta.url);
const REPO_ROOT = new URL('../../../', import.meta.url);

function sourceFiles(path: URL): string[] {
  const out: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (extname(target) === '.ts') out.push(target);
    }
  };
  visit(fileURLToPath(path));
  return out;
}

/** Strip comments so a rule named in prose is not mistaken for a violation of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SOURCES = sourceFiles(new URL('src/', PACKAGE_ROOT)).map((path) => ({ path, text: code(readFileSync(path, 'utf8')) }));

describe('core structural boundary', () => {
  it('depends only on the kernel and the kernel\'s pinned hash library (ADR 0020)', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE_ROOT), 'utf8')) as { dependencies?: { [name: string]: string } };
    assert.deepEqual(manifest.dependencies, { '@mandate/kernel': '0.1.0', '@noble/hashes': '2.4.0' });
    const kernel = JSON.parse(readFileSync(new URL('packages/kernel/package.json', REPO_ROOT), 'utf8')) as { dependencies: { [name: string]: string } };
    assert.equal(kernel.dependencies['@noble/hashes'], '2.4.0');
  });

  it('imports nothing but the kernel, the hash library and its own modules', () => {
    for (const { path, text } of SOURCES) {
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] as string;
        const allowed = spec.startsWith('./') || spec === '@mandate/kernel' || spec === '@noble/hashes/sha3.js';
        assert.ok(allowed, `${path} imports ${spec}`);
      }
    }
  });

  it('performs no I/O, reads no clock or randomness, and holds no model, chain or HTTP client', () => {
    const forbiddenImports = /from\s+['"](?:node:)?(?:fs|http|https|net|tls|dgram|child_process|worker_threads)['"]|from\s+['"][^'"]*(?:openai|anthropic|jev|langchain|viem|ethers|web3|axios|undici)/i;
    const forbiddenCalls = /\b(?:fetch|Date\.now|Math\.random|setTimeout|setInterval|performance\.now)\s*\(|new\s+Date\s*\(|process\.env/;
    for (const { path, text } of SOURCES) {
      assert.doesNotMatch(text, forbiddenImports, path);
      assert.doesNotMatch(text, forbiddenCalls, path);
    }
  });

  it('declares no untyped escape hatch: no any, no unknown, no Record<string, …> maps', () => {
    const escapeHatches = /:\s*any\b|<any>|\bas\s+any\b|\bany\[\]|\bunknown\b|\bRecord\s*</;
    for (const { path, text } of SOURCES) assert.doesNotMatch(text, escapeHatches, path);
  });

  it('uses no floating-point parsing or Math in its value paths', () => {
    for (const { path, text } of SOURCES) assert.doesNotMatch(text, /\bparseFloat\b|\bMath\.(?:round|floor|ceil|pow)\b|\btoFixed\b/, path);
  });

  it('names no venue, exchange or product: domain facts reach Core only through modules', () => {
    for (const { path, text } of SOURCES) assert.doesNotMatch(text, /lighter|robinhood|uniswap|hyperliquid|binance/i, path);
  });

  it('touches no Phase 6 package, and nothing depends on Core yet', () => {
    for (const { path, text } of SOURCES) assert.doesNotMatch(text, /@mandate\/(?:execution-gate|registry|router|jev|adapter-robinhood)/, path);
    for (const pkg of ['kernel', 'registry', 'router', 'jev', 'adapter-robinhood', 'execution-gate']) {
      const manifest = readFileSync(new URL(`packages/${pkg}/package.json`, REPO_ROOT), 'utf8');
      assert.doesNotMatch(manifest, /@mandate\/core/, pkg);
      for (const file of sourceFiles(new URL(`packages/${pkg}/src/`, REPO_ROOT))) {
        assert.doesNotMatch(readFileSync(file, 'utf8'), /@mandate\/core/, file);
      }
    }
  });
});
