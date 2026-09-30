/**
 * Structural boundary of @mandate/judge-demo.
 *
 * - It depends on the frozen packages, never the reverse: nothing in the
 *   protocol can import presentation.
 * - Its source reads no clock, randomness or environment and makes no
 *   network call; the only filesystem access is the read-only Phase 7E.3
 *   evidence loader.
 * - There is no model in it: agents are deterministic programs.
 * - Demonstration keys are touched in exactly one module, which never
 *   exports them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pkg from '../src/index.ts';

const ROOT = new URL('../', import.meta.url);
const REPO = new URL('../../../', import.meta.url);
const SRC = fileURLToPath(new URL('src/', ROOT));
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SOURCES = readdirSync(SRC).filter((f) => f.endsWith('.ts')).map((f) => ({ file: f, text: strip(readFileSync(join(SRC, f), 'utf8')) }));
/** The one module allowed to read files: recorded evidence, read-only. */
const IO_MODULES = ['evidence-files.ts'];
/** The one module allowed to hold a demonstration key. */
const KEY_MODULES = ['agents.ts'];

describe('judge-demo structural boundary', () => {
  it('depends only on the kernel, Core, the portfolio layer and the kernel’s pinned hash package', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { dependencies?: { [name: string]: string } };
    assert.deepEqual(manifest.dependencies, { '@mandate/core': '0.1.0', '@mandate/kernel': '0.1.0', '@mandate/portfolio': '0.1.0', '@noble/hashes': '2.4.0' });
  });

  it('reads no clock, randomness or environment, and makes no network call', () => {
    for (const { file, text } of SOURCES) {
      assert.doesNotMatch(text, /\b(?:fetch|Date\.now|Math\.random|setTimeout|setInterval|performance\.now|getRandomValues|randomUUID)\s*\(|new\s+Date\s*\(|process\.env|process\.hrtime|WebSocket|node:https?|node:net|node:child_process/, file);
      if (!IO_MODULES.includes(file)) assert.doesNotMatch(text, /from\s+['"]node:/, file);
    }
  });

  it('contains no model: no inference client, no advisory layer', () => {
    const manifest = readFileSync(new URL('package.json', ROOT), 'utf8');
    assert.doesNotMatch(manifest, /@mandate\/jev|anthropic|openai|typesafe/i);
    for (const { file, text } of SOURCES) assert.doesNotMatch(text, /@mandate\/jev|anthropic|openai|typesafe|TYPESAFE_API_KEY/i, file);
  });

  it('declares no any and parses no float', () => {
    for (const { file, text } of SOURCES) assert.doesNotMatch(text, /:\s*any\b|<any>|\bas\s+any\b|\bparseFloat\b/, file);
  });

  it('touches demonstration keys in one module and exports none', () => {
    for (const { file, text } of SOURCES) if (!KEY_MODULES.includes(file)) assert.doesNotMatch(text, /\bdemoKey\b|\bsignPrehash\b|secp256k1/, file);
    for (const name of Object.keys(pkg)) assert.doesNotMatch(name, /key|secret|private/i, name);
  });

  it('nothing in the protocol depends on it', () => {
    for (const p of ['kernel', 'core', 'registry', 'ledger', 'control', 'ledger-sqlite', 'execution-gate', 'evm-robinhood', 'perp-lighter', 'portfolio']) {
      assert.doesNotMatch(readFileSync(new URL(`packages/${p}/package.json`, REPO), 'utf8'), /@mandate\/judge-demo/, p);
      const dir = fileURLToPath(new URL(`packages/${p}/src/`, REPO));
      for (const f of readdirSync(dir, { recursive: true }).map(String)) {
        if (f.endsWith('.ts')) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /@mandate\/judge-demo/, `${p}/${f}`);
      }
    }
  });
});
