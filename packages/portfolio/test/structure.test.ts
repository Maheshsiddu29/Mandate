/**
 * Structural boundary of @mandate/portfolio (ADR 0027).
 *
 * - Its dependencies are exactly the ones the ADR names.
 * - Its source performs no I/O and reads no clock, randomness or environment:
 *   time is always a parameter.
 * - It declares no `any` and exports no signing operation: agents and the
 *   principal sign outside it; the package only verifies.
 * - Nothing below it — kernel, Core, registry, ledger, control, the execution
 *   gate, the domain packages — depends on it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pkg from '../src/index.ts';

const ROOT = new URL('../', import.meta.url);
const REPO = new URL('../../../', import.meta.url);
const SRC = fileURLToPath(new URL('src/', ROOT));
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sources(dir: string, base = ''): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) out.push(...sources(full, `${base}${f}/`));
    else if (f.endsWith('.ts')) out.push({ file: `${base}${f}`, text: strip(readFileSync(full, 'utf8')) });
  }
  return out;
}
const SOURCES = sources(SRC);

describe('portfolio structural boundary', () => {
  it('depends on exactly the packages ADR 0027 names', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { dependencies?: { [name: string]: string } };
    assert.deepEqual(manifest.dependencies, {
      '@mandate/control': '0.1.0',
      '@mandate/core': '0.1.0',
      '@mandate/evm-robinhood': '0.1.0',
      '@mandate/execution-gate': '0.1.0',
      '@mandate/kernel': '0.1.0',
      '@mandate/ledger': '0.1.0',
      '@mandate/perp-lighter': '0.1.0',
      '@mandate/registry': '0.1.0',
      '@noble/curves': '2.4.0',
      '@noble/hashes': '2.4.0',
    });
  });

  it('performs no I/O and reads no clock, randomness or environment', () => {
    for (const { file, text } of SOURCES) {
      assert.doesNotMatch(text, /from\s+['"]node:/, file);
      assert.doesNotMatch(text, /\b(?:fetch|Date\.now|Math\.random|setTimeout|setInterval|performance\.now|getRandomValues|randomUUID)\s*\(|new\s+Date\s*\(|process\.env|process\.hrtime|WebSocket/, file);
    }
  });

  it('declares no any and parses no float', () => {
    for (const { file, text } of SOURCES) assert.doesNotMatch(text, /:\s*any\b|<any>|\bas\s+any\b|\bparseFloat\b/, file);
  });

  it('exports no signing operation: the package verifies, it never signs', () => {
    for (const name of Object.keys(pkg)) assert.doesNotMatch(name, /^sign(?!ed)|signHash|privateKey|secretKey/i, name);
    for (const { file, text } of SOURCES.filter((s) => !s.file.startsWith('demo/'))) assert.doesNotMatch(text, /secp256k1\.sign|getPublicKey/, file);
  });

  it('nothing below it depends on it', () => {
    for (const p of ['kernel', 'core', 'registry', 'ledger', 'control', 'ledger-sqlite', 'execution-gate', 'evm-robinhood', 'perp-lighter']) {
      assert.doesNotMatch(readFileSync(new URL(`packages/${p}/package.json`, REPO), 'utf8'), /@mandate\/portfolio/, p);
      for (const f of readdirSync(fileURLToPath(new URL(`packages/${p}/src/`, REPO)))) {
        if (f.endsWith('.ts')) assert.doesNotMatch(readFileSync(new URL(`packages/${p}/src/${f}`, REPO), 'utf8'), /@mandate\/portfolio/, `${p}/${f}`);
      }
    }
  });
});
