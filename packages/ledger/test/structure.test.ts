/**
 * Structural boundary of the ledger package (ADR 0021).
 *
 * The ledger is pure and domain-independent by construction: it depends only
 * on Core and the kernel, performs no I/O, reads no clock, names no venue and
 * contains no domain module. These tests make each of those a checked
 * property.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ledger from '../src/index.ts';

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

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SOURCES = sourceFiles(new URL('src/', PACKAGE_ROOT)).map((path) => ({ path, text: code(readFileSync(path, 'utf8')) }));

describe('ledger structural boundary', () => {
  it('depends only on Core and the kernel', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE_ROOT), 'utf8')) as { dependencies?: { [name: string]: string } };
    assert.deepEqual(manifest.dependencies, { '@mandate/core': '0.1.0', '@mandate/kernel': '0.1.0' });
  });

  it('imports nothing but Core, the kernel and its own modules', () => {
    for (const { path, text } of SOURCES) {
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] as string;
        assert.ok(spec.startsWith('./') || spec === '@mandate/core' || spec === '@mandate/kernel', `${path} imports ${spec}`);
      }
    }
  });

  it('takes only byte and result plumbing from the kernel', () => {
    const allowed = new Set(['ok', 'err', 'Result', 'ByteWriter']);
    for (const { path, text } of SOURCES) {
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@mandate\/kernel['"]/g)) {
        for (const raw of (m[1] as string).split(',')) {
          const name = raw.trim().replace(/^type\s+/, '');
          if (name !== '') assert.ok(allowed.has(name), `${path} imports kernel symbol ${name}`);
        }
      }
    }
  });

  it('performs no I/O, reads no clock or randomness, and holds no network, chain or model client', () => {
    const forbiddenImports = /from\s+['"](?:node:)?(?:fs|http|https|net|tls|dgram|child_process|worker_threads)['"]|from\s+['"][^'"]*(?:openai|anthropic|jev|viem|ethers|web3|axios|undici|ws)['"]/i;
    const forbiddenCalls = /\b(?:fetch|Date\.now|Math\.random|setTimeout|setInterval|setImmediate|performance\.now|WebSocket)\s*\(|new\s+(?:Date|WebSocket)\s*\(|process\.env/;
    for (const { path, text } of SOURCES) {
      assert.doesNotMatch(text, forbiddenImports, path);
      assert.doesNotMatch(text, forbiddenCalls, path);
    }
  });

  it('declares no untyped escape hatch and parses no floating point', () => {
    for (const { path, text } of SOURCES) {
      assert.doesNotMatch(text, /:\s*any\b|<any>|\bas\s+any\b|\bany\[\]|\bunknown\b|\bRecord\s*</, path);
      assert.doesNotMatch(text, /\bparseFloat\b|\bNumber\s*\(|\bMath\.(?:round|floor|ceil|pow|trunc)\b|\btoFixed\b/, path);
    }
  });

  it('names no venue and implements no domain module: the ledger sees typed quantities only', () => {
    for (const { path, text } of SOURCES) {
      assert.doesNotMatch(text, /lighter|robinhood|uniswap|hyperliquid|binance|coinbase/i, path);
      // The 7D DomainModule interface is not built here.
      assert.doesNotMatch(text, /\binterface\s+DomainModule\b|\b(?:project|stateRequirements|reconciliationSemantics|settle\w*Fills)\s*\(/, path);
      assert.doesNotMatch(text, /\b(?:side|strike|leverage|healthFactor|outcome|route)\s*:/, path);
    }
  });

  it('touches no Phase 6 package, and nothing else depends on the ledger', () => {
    for (const { path, text } of SOURCES) assert.doesNotMatch(text, /@mandate\/(?:execution-gate|registry|router|jev|adapter-robinhood)/, path);
    for (const pkg of ['kernel', 'core', 'registry', 'router', 'jev', 'adapter-robinhood', 'execution-gate']) {
      assert.doesNotMatch(readFileSync(new URL(`packages/${pkg}/package.json`, REPO_ROOT), 'utf8'), /@mandate\/ledger/, pkg);
      for (const file of sourceFiles(new URL(`packages/${pkg}/src/`, REPO_ROOT))) {
        assert.doesNotMatch(readFileSync(file, 'utf8'), /@mandate\/ledger/, file);
      }
    }
  });

  it('exports no way to write ledger state except through the reducer', () => {
    const names = Object.keys(ledger);
    for (const n of names) assert.doesNotMatch(n, /unsafe|unchecked|force|override|setBalance|adjust/i, n);
  });
});
