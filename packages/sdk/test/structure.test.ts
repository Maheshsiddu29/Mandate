/**
 * Structural boundary of `@mandate/sdk`.
 *
 * - Facade only: depends upward on live-agents / portfolio / control /
 *   ledger / live-settlement; nothing below imports it.
 * - No private keys, no process.env, no broadcast primitives in core.
 * - No demo fixture asset hard-coding in SDK core source.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pkg from '../src/index.ts';

const ROOT = new URL('../', import.meta.url);
const REPO = new URL('../../../', import.meta.url);
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sources(dir: string): readonly { readonly file: string; readonly text: string }[] {
  const base = fileURLToPath(new URL(dir, ROOT));
  return readdirSync(base, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f.split('\\').join('/'), text: strip(readFileSync(join(base, f), 'utf8')) }));
}

const SRC = sources('src/');
const DEPS = [
  '@mandate/control',
  '@mandate/core',
  '@mandate/kernel',
  '@mandate/ledger',
  '@mandate/live-agents',
  '@mandate/live-settlement',
  '@mandate/portfolio',
];

describe('sdk structural boundary', () => {
  it('depends only on the packages it facades', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as {
      dependencies?: { [name: string]: string };
    };
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [...DEPS].sort());
    for (const { file, text } of SRC) {
      for (const m of text.matchAll(/from\s+'(@[^/']+\/[^/']+)/g)) {
        assert.ok(DEPS.includes(m[1] as string), `${file}: ${m[1]}`);
      }
    }
  });

  it('nothing below the SDK imports it', () => {
    for (const p of [
      'kernel',
      'core',
      'registry',
      'ledger',
      'control',
      'ledger-sqlite',
      'execution-gate',
      'evm-robinhood',
      'perp-lighter',
      'portfolio',
      'judge-demo',
      'live-agents',
      'live-settlement',
      'router',
      'jev',
      'adapter-robinhood',
    ]) {
      assert.doesNotMatch(readFileSync(new URL(`packages/${p}/package.json`, REPO), 'utf8'), /@mandate\/sdk/, p);
      const dir = fileURLToPath(new URL(`packages/${p}/src/`, REPO));
      for (const f of readdirSync(dir, { recursive: true }).map(String)) {
        if (f.endsWith('.ts')) {
          assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /@mandate\/sdk|packages\/sdk/, `${p}/${f}`);
        }
      }
    }
  });

  it('core source has no private keys, env, or broadcast primitives', () => {
    const core = SRC.filter((s) => !s.file.startsWith('examples/'));
    for (const { file, text } of core) {
      assert.doesNotMatch(text, /privateKey|mnemonic|\bseed\b|process\.env|cast send|eth_sendTransaction|eth_sendRawTransaction/, file);
    }
  });

  it('exports no key, signer, demo key, or broadcast helper', () => {
    for (const name of Object.keys(pkg)) {
      assert.doesNotMatch(name, /key|secret|private|mnemonic|signer|broadcast|sendRaw/i, name);
    }
  });

  it('does not hard-code demo fixture assets into SDK core', () => {
    const core = SRC.filter((s) => !s.file.startsWith('examples/'));
    for (const { file, text } of core) {
      assert.doesNotMatch(text, /\bNVDA\b|nvda-note-a|\bMDUSD\b|\bMDEMO\b|\$800|'800'|"800"/, file);
      // Chain id may appear only as a documented config example in comments — not as a baked default constant assignment.
      assert.doesNotMatch(text, /=\s*46_?630\b|chainId:\s*46630/, file);
    }
  });

  it('declares no any and parses no float', () => {
    for (const { file, text } of SRC) {
      assert.doesNotMatch(text, /(?<!\?):\s*any\b|<any>|\bas\s+any\b|\bparseFloat\b/, file);
    }
  });
});
