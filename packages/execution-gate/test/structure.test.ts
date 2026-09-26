import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { GATE_ERRORS, errorSignature } from '../src/index.ts';

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

describe('execution-gate structural boundary', () => {
  it('depends only on the kernel and the two @noble packages the kernel pins (ADR 0019)', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE_ROOT), 'utf8')) as { dependencies?: Record<string, string> };
    assert.deepEqual(manifest.dependencies, { '@mandate/kernel': '0.1.0', '@noble/curves': '2.4.0', '@noble/hashes': '2.4.0' });
    const kernel = JSON.parse(readFileSync(new URL('packages/kernel/package.json', REPO_ROOT), 'utf8')) as { dependencies: Record<string, string> };
    assert.equal(kernel.dependencies['@noble/curves'], '2.4.0');
    assert.equal(kernel.dependencies['@noble/hashes'], '2.4.0');
  });

  it('performs no I/O, reads no clock or randomness, and holds no model or chain client', () => {
    const forbiddenImports = /from\s+['"](?:node:)?(?:fs|http|https|net|tls|dgram|child_process|worker_threads)['"]|from\s+['"][^'"]*(?:openai|anthropic|jev|langchain|viem|ethers|web3)/i;
    const forbiddenCalls = /\b(?:fetch|Date\.now|Math\.random|setTimeout|setInterval)\s*\(|process\.env/;
    for (const file of sourceFiles(new URL('src/', PACKAGE_ROOT))) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, forbiddenImports, file);
      assert.doesNotMatch(source, forbiddenCalls, file);
    }
  });

  it('is not imported by the kernel, registry, router or Jev: the dependency points one way', () => {
    for (const pkg of ['kernel', 'registry', 'router', 'jev', 'adapter-robinhood']) {
      const manifest = readFileSync(new URL(`packages/${pkg}/package.json`, REPO_ROOT), 'utf8');
      assert.doesNotMatch(manifest, /@mandate\/execution-gate/, pkg);
      for (const file of sourceFiles(new URL(`packages/${pkg}/src/`, REPO_ROOT))) {
        assert.doesNotMatch(readFileSync(file, 'utf8'), /@mandate\/execution-gate|execution-gate\//, file);
      }
    }
  });

  it('declares exactly the custom errors MandateExecutionGate.sol declares, with the same signatures', () => {
    const solidity = readFileSync(new URL('contracts/src/MandateExecutionGate.sol', REPO_ROOT), 'utf8');
    const declared = [...solidity.matchAll(/^\s*error\s+(\w+)\(([^)]*)\);/gm)].map((m) => {
      const types = (m[2] as string).split(',').map((p) => p.trim().split(/\s+/)[0]).filter((t) => t !== undefined && t !== '');
      return errorSignature(m[1] as string, types as string[]);
    });
    const modelled = Object.entries(GATE_ERRORS).map(([name, types]) => errorSignature(name, types));
    assert.deepEqual([...declared].sort(), [...modelled].sort());
  });

  it('uses the same EIP-712 type strings as the Solidity gate', () => {
    const solidity = readFileSync(new URL('contracts/src/MandateExecutionGate.sol', REPO_ROOT), 'utf8').replace(/"\s*\n\s*"/g, '');
    assert.match(solidity, /"MandateAuthorization\(bytes32 mandateDigest\)"/);
    assert.match(
      solidity,
      /"ExecutionAuthorization\(bytes32 mandateDigest,bytes32 candidateDigest,address recipient,uint256 fundingLimit,uint64 deadline,bytes executionData\)"/,
    );
  });
});
