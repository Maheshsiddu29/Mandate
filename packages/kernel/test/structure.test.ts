/**
 * Structural checks on the kernel package itself.
 *
 * INV-3 and INV-4 are properties of the *dependency graph*, not of any test
 * output: the permitted-execution set is identical whether a model is present,
 * absent, failed or adversarial, and that is only credible if a model cannot be
 * reached from here at all. Design section 10.1 property 5 states it as
 * structural rather than conventional, and this file is the enforcement.
 *
 * The same applies to purity. A verifier that could read a clock or open a
 * socket would be reproducible only by convention.
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

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const SOURCES = sourceFiles(srcRoot).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

/** Strip comments so a rule named in prose is not mistaken for a violation of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the kernel has sources to check', () => {
  assert.ok(SOURCES.length >= 15, `expected the kernel's sources, found ${SOURCES.length}`);
});

test('the detectors in this file actually fire', () => {
  // A structural test that cannot fail is worthless. This pins the detectors
  // against samples that must trip them, and against comment text that must not.
  const violating = [
    `import { readFileSync } from 'node:fs';`,
    `const t = Date.now();`,
    `const r = Math.random();`,
    `import OpenAI from 'openai';`,
    `const x = parseFloat('1.5');`,
    `const y = 0.1 + 0.2;`,
    `await fetch('https://example.test');`,
  ];
  const detectors: readonly RegExp[] = [
    /from\s*['"]node:fs['"]/,
    /\bDate\s*\.\s*now\b/,
    /\bMath\s*\.\s*random\b/,
    /from\s*['"]openai['"]/,
    /\bparseFloat\b/,
    /(?<![\w.])\d+\.\d+(?![\w.])/,
    /\bfetch\s*\(/,
  ];
  violating.forEach((sample, i) => {
    assert.ok((detectors[i] as RegExp).test(code(sample)), `detector ${i} missed: ${sample}`);
  });

  // And comment stripping must remove prose that merely names these things,
  // which is why the kernel can document its own rules without tripping them.
  const prose = `// never call Date.now() here\n/* no Math.random, no fetch( */\nconst a = 1;`;
  for (const detector of detectors) {
    assert.equal(detector.test(code(prose)), false, `comment text tripped ${detector}`);
  }
});

test('no kernel source imports a network, filesystem or process module', () => {
  const forbidden = [
    'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls',
    'node:fs', 'node:fs/promises', 'node:child_process', 'node:worker_threads',
    'node:cluster', 'node:os', 'node:dns', 'node:v8', 'node:vm', 'node:inspector',
    'http', 'https', 'fs', 'net', 'child_process',
  ];
  const importRe = /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g;
  for (const { path, text } of SOURCES) {
    for (const match of code(text).matchAll(importRe)) {
      const specifier = match[1] ?? match[2] ?? '';
      assert.equal(
        forbidden.includes(specifier),
        false,
        `${path} imports ${specifier}`,
      );
    }
  }
});

test('no kernel source reads a clock, randomness or the environment', () => {
  // Time is a parameter and every input is a value. A single `Date.now()` here
  // would make a verdict irreproducible from its recorded inputs.
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
    for (const [pattern, label] of banned) {
      assert.equal(pattern.test(stripped), false, `${path} uses ${label}`);
    }
  }
});

test('no kernel source can reach an inference client', () => {
  // The verifier must not be able to tell whether a model was involved. This
  // scans specifiers rather than prose, so the design documents' discussion of
  // Jev does not trip it.
  const modelSpecifiers = [
    'openai', 'anthropic', '@anthropic-ai', '@google/generative-ai', 'cohere',
    'replicate', 'langchain', 'llamaindex', 'ollama', 'mistralai',
    'jev', '@jev', 'jev-sdk',
  ];
  const importRe = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;
  for (const { path, text } of SOURCES) {
    for (const match of code(text).matchAll(importRe)) {
      const specifier = (match[1] ?? match[2] ?? match[3] ?? '').toLowerCase();
      const root = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0] ?? '';
      assert.equal(modelSpecifiers.includes(root), false, `${path} imports ${specifier}`);
    }
  }
});

test('the kernel depends on exactly the two allowlisted runtime packages', () => {
  // ADR 0003. Anything else requires a new ADR, and this is where that is
  // enforced rather than remembered.
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ['@noble/curves', '@noble/hashes']);
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), [], 'the kernel needs no dev dependencies of its own');
});

test('the allowlisted packages are themselves free of outside dependencies', () => {
  // An allowlist of two is only meaningful if neither pulls in a third party.
  const allowed = new Set(['@noble/curves', '@noble/hashes']);
  const seen = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'node_modules', name, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      assert.ok(allowed.has(dep), `${name} depends on ${dep}, which is outside the allowlist`);
      walk(dep);
    }
  };
  for (const name of allowed) walk(name);
  assert.deepEqual([...seen].sort(), ['@noble/curves', '@noble/hashes']);
});

test('no kernel source imports from outside the kernel', () => {
  // Later phases add adapters, registries and chain clients as packages that
  // depend on the kernel. The reverse must never happen.
  const importRe = /\bfrom\s*['"]([^'"]+)['"]/g;
  for (const { path, text } of SOURCES) {
    for (const match of code(text).matchAll(importRe)) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('.')) {
        assert.equal(specifier.includes('../../'), false, `${path} reaches outside the package: ${specifier}`);
        continue;
      }
      assert.ok(specifier.startsWith('@noble/'), `${path} imports a non-allowlisted package: ${specifier}`);
    }
  }
});

test('the kernel never imports the registry, by name', () => {
  // The generic rule above already fails a registry import, because every
  // non-relative specifier must start with `@noble/`. This states the Phase 2
  // boundary explicitly so a violation says what it violated (ADR 0004), rather
  // than leaving the reader to infer it from an allowlist.
  const importRe = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g;
  for (const { path, text } of SOURCES) {
    for (const match of code(text).matchAll(importRe)) {
      const specifier = match[1] ?? match[2] ?? '';
      assert.equal(
        specifier.includes('@mandate/registry') || specifier.includes('/registry/'),
        false,
        `${path} imports ${specifier}: the dependency direction is registry -> kernel, never the reverse`,
      );
    }
  }
});

test('the verifier module graph never reaches the test tree', () => {
  const importRe = /\bfrom\s*['"](\.[^'"]+)['"]/g;
  for (const { path, text } of SOURCES) {
    for (const match of code(text).matchAll(importRe)) {
      const specifier = match[1] ?? '';
      assert.equal(specifier.includes('/test/'), false, `${path} imports from the test tree`);
    }
  }
});

test('safety-critical sources use no floating-point arithmetic', () => {
  // INV-16. `Number(...)` appears where a bounded byte or decimal count is
  // converted for indexing; a float literal or parseFloat would not be bounded.
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
