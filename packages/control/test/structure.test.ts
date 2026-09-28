/**
 * Structural boundary of the control package (ADR 0025): it depends only on
 * the ledger, Core and the kernel; performs no I/O and reads no clock,
 * randomness or environment; names no venue; contains no production domain
 * module; and exposes no raw accounting — an agent-facing caller cannot
 * consume, release or restore an amount through it (brief §31).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as control from '../src/index.ts';

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
const MODULE_SOURCES = [new URL('test/support/synthetic.ts', PACKAGE_ROOT)].map((u) => ({ path: fileURLToPath(u), text: code(readFileSync(u, 'utf8')) }));
const FORBIDDEN_IMPORTS = /from\s+['"](?:node:)?(?:fs|http|https|net|tls|dgram|child_process|worker_threads|crypto)['"]|from\s+['"][^'"]*(?:openai|anthropic|jev|viem|ethers|web3|axios|undici|ws)['"]/i;
const FORBIDDEN_CALLS = /\b(?:fetch|Date\.now|Math\.random|setTimeout|setInterval|setImmediate|performance\.now|WebSocket|getRandomValues|randomUUID)\s*\(|new\s+(?:Date|WebSocket)\s*\(|process\.env|process\.hrtime/;

describe('control structural boundary', () => {
  it('depends only on the ledger, Core and the kernel', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE_ROOT), 'utf8')) as { dependencies?: { [name: string]: string } };
    assert.deepEqual(manifest.dependencies, { '@mandate/core': '0.1.0', '@mandate/kernel': '0.1.0', '@mandate/ledger': '0.1.0' });
  });

  it('imports nothing else, and only result and byte plumbing from the kernel', () => {
    const allowed = new Set(['ok', 'err', 'Result', 'ByteWriter', 'Identifier']);
    for (const { path, text } of SOURCES) {
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] as string;
        assert.ok(spec.startsWith('./') || spec === '@mandate/core' || spec === '@mandate/kernel' || spec === '@mandate/ledger', `${path} imports ${spec}`);
      }
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@mandate\/kernel['"]/g)) {
        for (const raw of (m[1] as string).split(',')) {
          const name = raw.trim().replace(/^type\s+/, '');
          if (name !== '') assert.ok(allowed.has(name), `${path} imports kernel symbol ${name}`);
        }
      }
    }
  });

  it('performs no I/O and reads no clock, randomness, network or environment — nor does the reference module', () => {
    for (const { path, text } of [...SOURCES, ...MODULE_SOURCES]) {
      assert.doesNotMatch(text, FORBIDDEN_IMPORTS, path);
      assert.doesNotMatch(text, FORBIDDEN_CALLS, path);
    }
  });

  it('declares no untyped escape hatch and parses no floating point', () => {
    for (const { path, text } of SOURCES) {
      assert.doesNotMatch(text, /:\s*any\b|<any>|\bas\s+any\b|\bany\[\]|\bunknown\b|\bRecord\s*</, path);
      assert.doesNotMatch(text, /\bparseFloat\b|\bNumber\s*\(|\bMath\.(?:round|floor|ceil|pow|trunc)\b|\btoFixed\b/, path);
    }
  });

  it('names no venue and implements no production domain module', () => {
    for (const { path, text } of SOURCES) {
      assert.doesNotMatch(text, /lighter|robinhood|uniswap|hyperliquid|binance|coinbase/i, path);
      assert.doesNotMatch(text, /\b(?:perp|spot|lending|option|margin)(?:Policy|Module)\b|healthFactor|reduceOnly/i, path);
      // The only DomainModule implementation in the repository is the test-only synthetic one.
      assert.doesNotMatch(text, /implements\s+DomainModule|:\s*DomainModule\s*=\s*\{/, path);
    }
  });

  it('exposes no raw accounting and no stage-replacement hook to its callers', () => {
    for (const name of Object.keys(control)) {
      assert.doesNotMatch(name, /settle|consume|release|restore|adjust|unsafe|force|override|decideWith|revalidateWith|Pipeline|PIPELINE/i, name);
    }
    const methods = Object.getOwnPropertyNames(control.ControlEngine.prototype);
    assert.deepEqual(methods.sort(), ['authorizeAndReserve', 'closeNeverIssued', 'constructor', 'decide', 'read', 'registerDelegation', 'revalidate']);
    for (const { path, text } of SOURCES) {
      assert.doesNotMatch(text, /\.settle\s*\(|AuthorityLedger/, path);
      // The only accounting event the engine ever writes is the NEVER_ISSUED CLOSE, in engine.ts.
      if (!path.endsWith('engine.ts')) assert.doesNotMatch(text, /kind:\s*'(?:CONSUME|CLOSE|RESTORE)'/, path);
      assert.doesNotMatch(text, /kind:\s*'(?:CONSUME|RESTORE)'/, path);
    }
  });

  it('nothing below it depends on it, and no Phase 6 package is touched', () => {
    for (const { path, text } of SOURCES) assert.doesNotMatch(text, /@mandate\/(?:execution-gate|registry|router|jev|adapter-robinhood)/, path);
    for (const pkg of ['kernel', 'core', 'ledger', 'registry', 'router', 'jev', 'adapter-robinhood', 'execution-gate']) {
      assert.doesNotMatch(readFileSync(new URL(`packages/${pkg}/package.json`, REPO_ROOT), 'utf8'), /@mandate\/control/, pkg);
      for (const file of sourceFiles(new URL(`packages/${pkg}/src/`, REPO_ROOT))) assert.doesNotMatch(readFileSync(file, 'utf8'), /@mandate\/control/, file);
    }
  });
});
