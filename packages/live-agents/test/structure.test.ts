/**
 * Structural boundary of @mandate/live-agents (docs/demo/live-ai-lab.md).
 *
 * - It depends on the frozen packages, never the reverse, and not on the
 *   judge demo or the Jev client; the browser app does not import it.
 * - Each capability lives in one module: the environment in config.ts,
 *   the model provider's network call in openai-provider.ts, clocks in
 *   clock.ts, randomness in entropy.ts, sockets in server/http.ts,
 *   demonstration keys in mandate/signer.ts, signature *recovery* (never
 *   signing) in wallet/eip712.ts, files and SQLite in
 *   persistence/session-store.ts (the durable session and its portfolio
 *   ledger). No source starts a process.
 * - Every model answer schema is closed and has no field that could carry
 *   an address, a venue, a tool, calldata or a signature.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as pkg from '../src/index.ts';
import { createAgentSigners, LocalPrincipalSigner } from '../src/mandate/signer.ts';
import { caseViews } from '../src/policy-stress/cases.ts';
import { decisionSchema, negotiationSchema, opportunitySchema, policyStressSchema } from '../src/runtime/schemas.ts';
import { DOMAIN_AGENTS } from '../src/agents/index.ts';
import { viewOf } from '../src/agents/spec.ts';
import { containsKey } from './support/world.ts';

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
const SCRIPTS = sources('scripts/');
const FORBIDDEN_WEB_DEPENDENCIES = ['@mandate/live-agents'] as const;

function moduleSpecifiers(file: string, source: string): readonly string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const specifiers: string[] = [];
  const add = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function forbiddenWebDependency(file: string, source: string): string | undefined {
  return moduleSpecifiers(file, source).find((specifier) =>
    FORBIDDEN_WEB_DEPENDENCIES.some((dependency) => specifier === dependency || specifier.startsWith(`${dependency}/`)),
  );
}

type DependencyManifest = {
  readonly dependencies?: { readonly [name: string]: string };
  readonly devDependencies?: { readonly [name: string]: string };
  readonly optionalDependencies?: { readonly [name: string]: string };
  readonly peerDependencies?: { readonly [name: string]: string };
};

function forbiddenManifestDependency(manifest: DependencyManifest): string | undefined {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    for (const dependency of FORBIDDEN_WEB_DEPENDENCIES) if (manifest[field]?.[dependency]) return `${field}: ${dependency}`;
  }
  return undefined;
}

const only = (pattern: RegExp, allowed: readonly string[], set = SRC) => {
  for (const { file, text } of set) if (!allowed.includes(file)) assert.doesNotMatch(text, pattern, file);
};

describe('live-agents structural boundary', () => {
  it('depends only on the frozen protocol packages it uses', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { dependencies?: { [name: string]: string } };
    // B.5.3: the kernel's pinned noble packages, for EIP-712 hashing and signer recovery of the principal's wallet approval.
    // B.5.3: the reference SQLite store, so the session's portfolio ledger survives a restart.
    // Room V2: the Jev client, for the composition root only (scripts/jev.ts): no source file imports it.
    assert.deepEqual(manifest.dependencies, { '@mandate/control': '0.1.0', '@mandate/core': '0.1.0', '@mandate/jev': '0.1.0', '@mandate/kernel': '0.1.0', '@mandate/ledger': '0.1.0', '@mandate/ledger-sqlite': '0.1.0', '@mandate/portfolio': '0.1.0', '@noble/curves': '2.4.0', '@noble/hashes': '2.4.0' });
    for (const { file, text } of SCRIPTS) if (file !== 'jev.ts') assert.doesNotMatch(text, /@mandate\/jev/, file);
    for (const { file, text } of SRC) {
      for (const m of text.matchAll(/from\s+'(@[^/']+\/[^/']+)/g)) assert.ok(['@mandate/control', '@mandate/core', '@mandate/kernel', '@mandate/ledger', '@mandate/ledger-sqlite', '@mandate/portfolio', '@noble/curves', '@noble/hashes'].includes(m[1] as string), `${file}: ${m[1]}`);
      assert.doesNotMatch(text, /@mandate\/judge-demo|judge-demo\/|@mandate\/jev|anthropic|typesafe/i, file);
    }
  });

  it('has no path to a chain: no settlement package, RPC client or transaction signer, and it never emits a settlement event', () => {
    // B.5.2: Robinhood Chain testnet settlement lives in @mandate/live-settlement, which depends on this package — never the reverse.
    for (const { file, text } of [...SRC, ...SCRIPTS]) assert.doesNotMatch(text, /@mandate\/(live-settlement|evm-robinhood|execution-gate)|ChainClient|JsonRpcClient|TxSender|eth_sendRawTransaction|IssuanceJournal|LocalGateCustody/, file);
    only(/@mandate\/ledger-sqlite/, ['persistence/session-store.ts']);
    only(/'(TESTNET_[A-Z_]+|DOMAIN_EXECUTION_[A-Z_]+)'/, ['telemetry/events.ts', 'telemetry/render.ts']);
  });

  it('nothing in the protocol, the judge demo or the browser app depends on it', () => {
    // @mandate/sdk sits above this package and may depend on it; lower packages may not.
    for (const p of ['kernel', 'core', 'registry', 'ledger', 'control', 'ledger-sqlite', 'execution-gate', 'evm-robinhood', 'perp-lighter', 'portfolio', 'judge-demo', 'router', 'jev', 'adapter-robinhood']) {
      assert.doesNotMatch(readFileSync(new URL(`packages/${p}/package.json`, REPO), 'utf8'), /@mandate\/live-agents/, p);
      const dir = fileURLToPath(new URL(`packages/${p}/src/`, REPO));
      for (const f of readdirSync(dir, { recursive: true }).map(String)) if (f.endsWith('.ts')) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /@mandate\/live-agents|live-agents\//, `${p}/${f}`);
    }
    const web = fileURLToPath(new URL('apps/web/', REPO));
    const manifest = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')) as DependencyManifest;
    assert.equal(forbiddenManifestDependency(manifest), undefined, 'web/package.json dependency boundary');
    for (const d of ['app', 'components', 'lib']) {
      for (const f of readdirSync(join(web, d), { recursive: true }).map(String)) {
        if (!/\.(ts|tsx|mjs)$/.test(f)) continue;
        const dependency = forbiddenWebDependency(f, readFileSync(join(web, d, f), 'utf8'));
        assert.equal(dependency, undefined, `web/${d}/${f}: ${dependency}`);
      }
    }
  });

  it('allows web documentation prose that names the package', () => {
    const source = 'export const description = "Architecture: web does not depend on @mandate/live-agents";';
    assert.equal(forbiddenWebDependency('architecture.tsx', source), undefined);
  });

  it('rejects an actual web import from the forbidden package', () => {
    const source = 'import { LiveSession } from "@mandate/live-agents";';
    assert.equal(forbiddenWebDependency('page.tsx', source), '@mandate/live-agents');
  });

  it('rejects the forbidden package when declared by the web manifest', () => {
    const manifest = { dependencies: { '@mandate/live-agents': '0.1.0' } };
    assert.equal(forbiddenManifestDependency(manifest), 'dependencies: @mandate/live-agents');
  });

  it('reads the environment in one module, files in one module, and no process or shell anywhere', () => {
    only(/process\.env/, ['config.ts']);
    only(/process\.env/, [], SCRIPTS);
    only(/node:fs|node:sqlite|SqliteLedgerStore/, ['persistence/session-store.ts']);
    only(/node:child_process|node:worker_threads|node:vm|\beval\s*\(|new Function\s*\(/, []);
    only(/node:child_process|\bexec(Sync)?\s*\(|spawn(Sync)?\s*\(/, [], SCRIPTS);
  });

  it('has one network client (the model provider) and one listening socket (the local server)', () => {
    only(/\bfetch\s*\(|api\.openai\.com/, ['runtime/openai-provider.ts']);
    only(/node:http|node:net|node:https|node:dgram|node:tls|WebSocket|createServer/, ['server/http.ts']);
    const http = SRC.find((s) => s.file === 'server/http.ts')?.text ?? '';
    assert.match(http, /listen\(port, '127\.0\.0\.1'/);
    assert.doesNotMatch(http, /0\.0\.0\.0|'::'/);
  });

  it('reads clocks in one module, schedules timers only there and in the server, and reads randomness in one module', () => {
    only(/performance\.now|Date\.now|new Date\s*\(/, ['runtime/clock.ts']);
    only(/setTimeout|setInterval/, ['runtime/clock.ts', 'server/http.ts']);
    only(/Math\.random|getRandomValues|randomUUID|randomBytes|node:crypto/, ['runtime/entropy.ts']);
    const entropy = SRC.find((s) => s.file === 'runtime/entropy.ts')?.text ?? '';
    assert.doesNotMatch(entropy, /Math\.random/);
  });

  it('touches demonstration keys in one module, recovers wallet signers in one module that cannot sign, never serializes a key, and exports none', () => {
    only(/\bdemoKey\b|\bsignPrehash\b/, ['mandate/signer.ts']);
    only(/secp256k1|@noble\//, ['mandate/signer.ts', 'wallet/eip712.ts']);
    const recovery = SRC.find((s) => s.file === 'wallet/eip712.ts')?.text ?? '';
    assert.doesNotMatch(recovery, /\.sign\(|getPublicKey|privateKey|utils\.randomSecretKey|demoKey/);
    for (const name of Object.keys(pkg)) assert.doesNotMatch(name, /key|secret|private|signer/i, name);
    const serialized = JSON.stringify([...createAgentSigners().values(), new LocalPrincipalSigner()]);
    assert.equal(containsKey(serialized), false);
  });

  it('declares no any and parses no float', () => {
    for (const { file, text } of [...SRC, ...SCRIPTS]) assert.doesNotMatch(text, /(?<!\?):\s*any\b|<any>|\bas\s+any\b|\bparseFloat\b/, file); // `(?:any` is a regular expression group, not a type
  });

  it('every model answer schema is closed and has no field that could carry an address, venue, tool or signature', () => {
    const agent = DOMAIN_AGENTS.swap;
    const authority = { role: 'swap' as const, mandateVersion: 1, domain: 'swap', maxAllocationAtoms: '1', exposure: null, maxLeverage: null, maxSlippageBps: null, maxQuoteAgeSeconds: null };
    const schemas = [
      decisionSchema({ kind: 'DECISION', role: 'swap', objective: '', principalIntent: null, authority, portfolio: { deployableAtoms: '0', availableAtoms: '0', enabledAgents: [] }, candidates: agent.candidates.map((c) => viewOf(c)) }),
      negotiationSchema({ kind: 'NEGOTIATION', role: 'swap', objective: '', roomId: 'r', generation: 1, portfolioAuthorityAtoms: '0', admissibleDemandAtoms: '0', requiredReductionAtoms: '0', constraints: [], candidateTitle: '', yourCurrentAtoms: '1', yourMinimumAtoms: '1', yourOwnLimitAtoms: '1', permittedActions: ['KEEP', 'REDUCE', 'RELEASE', 'ABSTAIN'], participants: [] }),
      policyStressSchema({ kind: 'POLICY_STRESS', role: 'swap', task: '', authority, cases: caseViews(['COMPLIANT_CONTROL', 'ABSTAIN']), history: [], attempt: 1, maxAttempts: 5 }),
      opportunitySchema({ kind: 'OPPORTUNITY', role: 'swap', objective: '', principalIntent: null, purpose: 'INITIAL_ALLOCATION', authority, pool: { poolAtoms: '0', participants: [] }, candidates: agent.candidates.map((c) => viewOf(c)), research: [] }),
    ];
    for (const s of schemas) {
      const o = s as { additionalProperties?: unknown; required?: unknown; properties?: { [k: string]: unknown } };
      assert.equal(o.additionalProperties, false);
      assert.deepEqual(o.required, Object.keys(o.properties ?? {}));
      for (const k of Object.keys(o.properties ?? {})) assert.doesNotMatch(k, /address|recipient|router|venue|pool|token|contract|tool|calldata|chain|signature|key|url/i, k);
    }
    assert.deepEqual(Object.keys((schemas[2] as { properties: object }).properties), ['caseId', 'rationale']);
  });
});
