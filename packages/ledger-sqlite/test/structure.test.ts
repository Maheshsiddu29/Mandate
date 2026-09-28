/**
 * Structural boundary of the SQLite reference store: it depends only on the
 * ledger and Core; its only I/O is `node:sqlite`; it reads no clock,
 * randomness, network or environment; it names no venue; and nothing in the
 * pure packages below it depends on it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const REPO = new URL('../../../', import.meta.url);
const SRC = fileURLToPath(new URL('src/', ROOT));
const SOURCES = readdirSync(SRC).filter((f) => f.endsWith('.ts')).map((f) => ({ path: join(SRC, f), text: readFileSync(join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1') }));

describe('ledger-sqlite structural boundary', () => {
  it('depends only on the ledger and Core', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { dependencies?: { [name: string]: string } };
    assert.deepEqual(manifest.dependencies, { '@mandate/core': '0.1.0', '@mandate/ledger': '0.1.0' });
  });

  it('imports only node:sqlite, the ledger, Core and its own modules', () => {
    for (const { path, text } of SOURCES) {
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] as string;
        assert.ok(spec.startsWith('./') || spec === 'node:sqlite' || spec === '@mandate/ledger' || spec === '@mandate/core', `${path} imports ${spec}`);
      }
    }
  });

  it('reads no clock, randomness, network or environment, and names no venue', () => {
    for (const { path, text } of SOURCES) {
      assert.doesNotMatch(text, /\b(?:fetch|Date\.now|Math\.random|setTimeout|setInterval|performance\.now|getRandomValues|randomUUID)\s*\(|new\s+Date\s*\(|process\.env/, path);
      assert.doesNotMatch(text, /lighter|robinhood|hyperliquid|uniswap/i, path);
    }
  });

  it('is labelled a reference, single-node store', () => {
    const manifest = readFileSync(new URL('package.json', ROOT), 'utf8');
    assert.match(manifest, /REFERENCE \/ SINGLE-NODE TESTNET STORE/);
    assert.match(readFileSync(new URL('src/index.ts', ROOT), 'utf8'), /REFERENCE \/ SINGLE-NODE TESTNET STORE/);
  });

  it('nothing below it depends on it', () => {
    for (const pkg of ['kernel', 'core', 'ledger', 'control']) {
      assert.doesNotMatch(readFileSync(new URL(`packages/${pkg}/package.json`, REPO), 'utf8'), /@mandate\/ledger-sqlite/, pkg);
    }
  });
});
