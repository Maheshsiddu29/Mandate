/**
 * Structural boundary of @mandate/perp-lighter.
 *
 * - The domain module and its codecs, claims, identities, descriptor,
 *   evidence rules and transaction construction are pure: no I/O, clock,
 *   randomness or environment.
 * - Network access exists only in venue.ts, and only to Lighter's testnet;
 *   process spawning only in custody.ts. No source reads a key: the key path
 *   is handed to the custody process, which alone opens it.
 * - The package exports no generic signing operation and none of the internal
 *   issuance stages.
 * - Core, the ledger, the control engine and the SQLite store do not depend on
 *   it: they stay venue-independent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pkg from '../src/index.ts';
import { HttpVenueClient, TESTNET_HOSTS, VenueHostRefused } from '../src/index.ts';

const ROOT = new URL('../', import.meta.url);
const REPO = new URL('../../../', import.meta.url);
const SRC = fileURLToPath(new URL('src/', ROOT));
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SOURCES = readdirSync(SRC).filter((f) => f.endsWith('.ts')).map((f) => ({ file: f, text: strip(readFileSync(join(SRC, f), 'utf8')) }));
const PURE = ['vocabulary.ts', 'market.ts', 'identity.ts', 'adapter.ts', 'policy.ts', 'evidence.ts', 'tx.ts'];

describe('perp-lighter structural boundary', () => {
  it('depends only on Core, the kernel, the ledger, the control engine and the SQLite reference store', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { dependencies?: { [name: string]: string } };
    assert.deepEqual(manifest.dependencies, { '@mandate/control': '0.1.0', '@mandate/core': '0.1.0', '@mandate/kernel': '0.1.0', '@mandate/ledger': '0.1.0', '@mandate/ledger-sqlite': '0.1.0' });
  });

  it('keeps the domain module and everything it relies on pure', () => {
    for (const { file, text } of SOURCES.filter((s) => PURE.includes(s.file))) {
      assert.doesNotMatch(text, /from\s+['"]node:/, file);
      assert.doesNotMatch(text, /\b(?:fetch|Date\.now|Math\.random|setTimeout|setInterval|performance\.now|getRandomValues|randomUUID)\s*\(|new\s+Date\s*\(|process\.env|process\.hrtime/, file);
    }
    const policy = SOURCES.find((s) => s.file === 'policy.ts')?.text ?? '';
    assert.doesNotMatch(policy, /:\s*any\b|<any>|\bas\s+any\b|\bunknown\b|\bparseFloat\b|\bNumber\s*\(|\bMath\./);
  });

  it('confines network access to venue.ts and process spawning to custody.ts; nothing reads a key', () => {
    for (const { file, text } of SOURCES) {
      if (file !== 'venue.ts') assert.doesNotMatch(text, /\bfetch\s*\(|WebSocket|node:https?|node:net/, file);
      if (file !== 'custody.ts') assert.doesNotMatch(text, /node:child_process|\bspawn\s*\(/, file);
      assert.doesNotMatch(text, /readFile|node:fs|createReadStream|process\.env/, file);
    }
  });

  it('exports no generic signing operation and none of the internal issuance stages', () => {
    for (const name of Object.keys(pkg)) assert.doesNotMatch(name, /^sign|signBytes|signTransaction|privateKey|rawKey|^issue$|^construct$|^guard$|resolveIntent|^admit$|^submit$|hashTx|readPreExecution|signAdmitted/i, name);
    const custody = SOURCES.find((s) => s.file === 'custody.ts')?.text ?? '';
    // Custody's interface has exactly three operations (plus close).
    assert.match(custody, /interface KeyCustody \{\s*publicKey\([^)]*\)[^;]*;\s*hash\([^)]*\)[^;]*;\s*sign\([^)]*\)[^;]*;\s*close\(\): void;\s*\}/);
  });

  it('contacts Lighter testnet only', () => {
    assert.deepEqual(TESTNET_HOSTS, ['testnet.zklighter.elliot.ai']);
    for (const url of ['https://mainnet.zklighter.elliot.ai', 'https://api.rh.lighter.xyz', 'http://testnet.zklighter.elliot.ai', 'https://evil.example/testnet.zklighter.elliot.ai']) {
      assert.throws(() => new HttpVenueClient(url), VenueHostRefused, url);
    }
    assert.doesNotThrow(() => new HttpVenueClient('https://testnet.zklighter.elliot.ai'));
  });

  it('nothing below it depends on it: Core, the ledger, control and the store stay venue-independent', () => {
    for (const p of ['kernel', 'core', 'ledger', 'control', 'ledger-sqlite']) {
      assert.doesNotMatch(readFileSync(new URL(`packages/${p}/package.json`, REPO), 'utf8'), /@mandate\/perp-lighter/, p);
      for (const f of readdirSync(fileURLToPath(new URL(`packages/${p}/src/`, REPO)))) {
        if (f.endsWith('.ts')) assert.doesNotMatch(readFileSync(new URL(`packages/${p}/src/${f}`, REPO), 'utf8'), /perp-lighter|lighter/i, `${p}/${f}`);
      }
    }
  });
});
