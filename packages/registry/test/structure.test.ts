/**
 * Structural checks on the registry package itself.
 *
 * The dependency direction is the property this file exists to protect:
 *
 * ```
 * registry  ->  kernel        permitted, and the only permitted direction
 * kernel    ->  registry      forbidden
 * ```
 *
 * ADR 0004 records why. A kernel that could reach the registry would be a kernel
 * aware of data-provider infrastructure, and the kernel is the component that has
 * to stay portable enough to be reimplemented in Solidity for the execution gate.
 * Both directions are asserted here, and again from the kernel's own structure
 * test, so the check survives someone reading only one package.
 *
 * Purity is the second property. The registry performs no I/O, so a registry
 * decision is a function of its inputs alone — which is what makes it replayable
 * from a recorded snapshot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '../..');
const srcRoot = join(packageRoot, 'src');
const kernelSrcRoot = resolve(repoRoot, 'packages/kernel/src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip comments so a rule named in prose is not mistaken for a violation of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SOURCES = sourceFiles(srcRoot).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
const KERNEL_SOURCES = sourceFiles(kernelSrcRoot).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

const IMPORT_RE = /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g;

function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const match of code(text).matchAll(IMPORT_RE)) {
    out.push(match[1] ?? match[2] ?? '');
  }
  return out;
}

test('the registry has sources to check', () => {
  assert.ok(SOURCES.length >= 4, `expected the registry's sources, found ${SOURCES.length}`);
  assert.ok(KERNEL_SOURCES.length >= 15, `expected the kernel's sources, found ${KERNEL_SOURCES.length}`);
});

test('the detectors in this file actually fire', () => {
  // A structural test that cannot fail is worthless. This pins each detector
  // against a sample that must trip it, and against comment text that must not.
  const samples: readonly [RegExp, string][] = [
    [/from\s*['"]node:fs['"]/, `import { readFileSync } from 'node:fs';`],
    [/\bDate\s*\.\s*now\b/, `const t = Date.now();`],
    [/\bMath\s*\.\s*random\b/, `const r = Math.random();`],
    [/\bfetch\s*\(/, `await fetch('https://example.test');`],
    [/\bparseFloat\b/, `const x = parseFloat('1.5');`],
    [/(?<![\w.])\d+\.\d+(?![\w.])/, `const y = 0.1 + 0.2;`],
    [/\bequivalentTo\b/, `const equivalentTo = true;`],
    [/\bsameAsOtherRepresentation\b/, `r.sameAsOtherRepresentation = true;`],
    [/\bisRealStock\b/, `const isRealStock = true;`],
  ];
  for (const [detector, sample] of samples) {
    assert.ok(detector.test(code(sample)), `detector missed: ${sample}`);
  }

  const prose = `// never call Date.now() or set equivalentTo here\n/* no Math.random, no fetch(, no isRealStock */\nconst a = 1;`;
  for (const [detector] of samples) {
    assert.equal(detector.test(code(prose)), false, `comment text tripped ${detector}`);
  }
});

test('the registry imports nothing outside itself and the kernel', () => {
  for (const { path, text } of SOURCES) {
    for (const specifier of specifiers(text)) {
      if (specifier.startsWith('.')) {
        assert.equal(specifier.includes('../../'), false, `${path} reaches outside the package: ${specifier}`);
        continue;
      }
      assert.equal(
        specifier,
        '@mandate/kernel',
        `${path} imports ${specifier}; the registry's only permitted package dependency is @mandate/kernel (ADR 0004)`,
      );
    }
  }
});

test('the kernel never imports the registry', () => {
  // The reverse direction, asserted from this side too. The kernel's own
  // structure test asserts it as well; stating it in both places is deliberate.
  for (const { path, text } of KERNEL_SOURCES) {
    for (const specifier of specifiers(text)) {
      assert.equal(
        specifier.includes('@mandate/registry') || specifier.includes('/registry/'),
        false,
        `${path} imports ${specifier}: the kernel must never depend on the registry (ADR 0004)`,
      );
    }
  }
});

test('the registry declares exactly one runtime dependency', () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@mandate/kernel']);
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), [], 'the registry needs no dev dependencies of its own');
});

test('the registry performs no I/O and reads no clock, randomness or environment', () => {
  // ADR 0004. A registry that could read a provider would not be replayable, and
  // "no live API calls in the registry" would be a promise rather than a property.
  const forbiddenModules = [
    'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls',
    'node:fs', 'node:fs/promises', 'node:child_process', 'node:worker_threads',
    'node:cluster', 'node:os', 'node:dns', 'node:v8', 'node:vm', 'node:inspector',
    'http', 'https', 'fs', 'net', 'child_process',
  ];
  const banned: readonly [RegExp, string][] = [
    [/\bDate\s*\.\s*now\b/, 'Date.now'],
    [/\bnew\s+Date\b/, 'new Date'],
    [/\bperformance\s*\.\s*now\b/, 'performance.now'],
    [/\bMath\s*\.\s*random\b/, 'Math.random'],
    [/\bcrypto\s*\.\s*getRandomValues\b/, 'crypto.getRandomValues'],
    [/\brandomBytes\b/, 'randomBytes'],
    [/\bprocess\s*\.\s*env\b/, 'process.env'],
    [/\bfetch\s*\(/, 'fetch('],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bWebSocket\b/, 'WebSocket'],
    [/\bsetTimeout\b|\bsetInterval\b/, 'timers'],
  ];
  for (const { path, text } of SOURCES) {
    const stripped = code(text);
    for (const specifier of specifiers(text)) {
      assert.equal(forbiddenModules.includes(specifier), false, `${path} imports ${specifier}`);
    }
    for (const [pattern, label] of banned) {
      assert.equal(pattern.test(stripped), false, `${path} uses ${label}`);
    }
  }
});

test('the registry can reach no inference client', () => {
  // Resolution is deterministic. A model has no place in deciding what financial
  // asset a reference names, and this is where that is structural rather than
  // asserted (ADR 0005).
  const modelSpecifiers = [
    'openai', 'anthropic', '@anthropic-ai', '@google/generative-ai', 'cohere',
    'replicate', 'langchain', 'llamaindex', 'ollama', 'mistralai',
    'jev', '@jev', 'jev-sdk',
  ];
  for (const { path, text } of SOURCES) {
    for (const specifier of specifiers(text)) {
      const lower = specifier.toLowerCase();
      const root = lower.startsWith('@') ? lower.split('/').slice(0, 2).join('/') : lower.split('/')[0] ?? '';
      assert.equal(modelSpecifiers.includes(root), false, `${path} imports ${specifier}`);
    }
  }
});

test('registry sources use no floating-point arithmetic', () => {
  const banned: readonly [RegExp, string][] = [
    [/\bparseFloat\b/, 'parseFloat'],
    [/\bNumber\s*\.\s*parseFloat\b/, 'Number.parseFloat'],
    [/\bMath\s*\.\s*(round|floor|ceil|abs|pow|max|min)\b/, 'Math arithmetic'],
    [/(?<![\w.])\d+\.\d+(?![\w.])/, 'a float literal'],
  ];
  for (const { path, text } of SOURCES) {
    const stripped = code(text);
    for (const [pattern, label] of banned) {
      assert.equal(pattern.test(stripped), false, `${path} uses ${label}`);
    }
  }
});

test('no registry type stores equivalence, substitutability or admissibility', () => {
  // Economic equivalence is a function of the current mandate, so storing it
  // would be storing a conclusion that depends on an input the registry does not
  // have. This is the structural half of the membership-is-not-equivalence rule;
  // the other half is that no function has the shape (record) -> Admissibility.
  const banned = [
    'equivalentTo',
    'equivalentToCanonical',
    'sameAsOtherRepresentation',
    'sameAs',
    'isRealStock',
    'interchangeableWith',
    'isEquivalent',
    'isAdmissible',
    'isSubstitutable',
  ];
  for (const { path, text } of SOURCES) {
    const stripped = code(text);
    for (const name of banned) {
      assert.equal(
        new RegExp(`\\b${name}\\b`).test(stripped),
        false,
        `${path} declares ${name}: registry membership is not equivalence (design section 5.4)`,
      );
    }
  }
});
