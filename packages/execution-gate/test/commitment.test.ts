import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  MANDATE_AUTHORIZATION_TYPE,
  bytesToHex,
  domainSeparator,
  encodeCandidate,
  encodeMandate,
  parseCandidate,
  parseMandate,
  type Bytes32,
} from '@mandate/kernel';
import {
  EXECUTION_AUTHORIZATION_TYPE,
  caip2,
  ceilToScale,
  encodeGateCandidate,
  encodeGateMandate,
  executionCommitment,
  floorToScale,
  gateDomain,
  representationIdFor,
  toGateCandidate,
  toGateMandate,
  UINT256_MAX,
  type GateTerms,
} from '../src/index.ts';

const REPO_ROOT = new URL('../../../', import.meta.url);

function corpusInputs(file: string): { mandate: unknown; candidate: unknown }[] {
  const corpus = JSON.parse(readFileSync(new URL(file, REPO_ROOT), 'utf8')) as { vectors: { input: { mandate: unknown; candidate: unknown } }[] };
  return corpus.vectors.map((v) => v.input);
}

describe('gate wire encoding', () => {
  it('writes byte-identical MCE v2 and Candidate V3 for every parseable kernel corpus input, including recorded mainnet state', () => {
    let mandates = 0;
    let candidates = 0;
    for (const file of ['corpus/v2/vectors.json', 'corpus/mainnet-v1/vectors.json']) {
      for (const input of corpusInputs(file)) {
        const m = parseMandate(input.mandate);
        if (m.ok) {
          const g = toGateMandate(m.value);
          assert.ok(g !== undefined);
          assert.deepEqual(encodeGateMandate(g), encodeMandate(m.value));
          mandates += 1;
        }
        const c = parseCandidate(input.candidate);
        if (c.ok) {
          const g = toGateCandidate(c.value);
          assert.ok(g !== undefined);
          assert.deepEqual(encodeGateCandidate(g), encodeCandidate(c.value));
          candidates += 1;
        }
      }
    }
    assert.ok(mandates > 50 && candidates > 50, `${mandates} mandates, ${candidates} candidates`);
  });

  it('refuses to express a party that is not an EVM address rather than inventing one', () => {
    const [input] = corpusInputs('corpus/v2/vectors.json');
    const raw = input?.mandate as Record<string, unknown>;
    const parsed = parseMandate({ ...raw, principal: { kind: 'did', value: 'did.example.principal' } });
    assert.ok(parsed.ok);
    assert.equal(toGateMandate(parsed.value), undefined);
  });
});

describe('the execution commitment', () => {
  const base = {
    mandateDigest: `0x${'11'.repeat(32)}` as Bytes32,
    candidateDigest: `0x${'22'.repeat(32)}` as Bytes32,
    terms: { recipient: `0x${'33'.repeat(20)}`, fundingLimit: 2_010_000_000n, deadline: 1_800_000_300n, executionData: '0x' } satisfies GateTerms,
  };

  it('changes when any committed field changes', () => {
    const reference = executionCommitment(base);
    const mutations: [string, typeof base][] = [
      ['mandateDigest', { ...base, mandateDigest: `0x${'12'.repeat(32)}` as Bytes32 }],
      ['candidateDigest', { ...base, candidateDigest: `0x${'23'.repeat(32)}` as Bytes32 }],
      ['recipient', { ...base, terms: { ...base.terms, recipient: `0x${'34'.repeat(20)}` } }],
      ['fundingLimit', { ...base, terms: { ...base.terms, fundingLimit: base.terms.fundingLimit + 1n } }],
      ['deadline', { ...base, terms: { ...base.terms, deadline: base.terms.deadline + 1n } }],
      ['executionData', { ...base, terms: { ...base.terms, executionData: '0x00' } }],
    ];
    const seen = new Set([reference]);
    for (const [field, mutated] of mutations) {
      const c = executionCommitment(mutated);
      assert.notEqual(c, reference, field);
      seen.add(c);
    }
    assert.equal(seen.size, mutations.length + 1);
  });

  it('is typed distinctly from the principal\'s MandateAuthorization, so neither signature can stand in for the other', () => {
    assert.notEqual(EXECUTION_AUTHORIZATION_TYPE, MANDATE_AUTHORIZATION_TYPE);
    assert.match(EXECUTION_AUTHORIZATION_TYPE, /^ExecutionAuthorization\(/);
  });

  it('binds chain and contract through the ADR 0001 domain, not through restated fields', () => {
    const d = gateDomain(46630n, '0x000000000000000000000000000000000000a7e0');
    assert.deepEqual(d, { name: 'Mandate', version: '1', chainId: 46630n, verifyingContract: '0x000000000000000000000000000000000000a7e0' });
    const otherChain = bytesToHex(domainSeparator(gateDomain(4663n, d.verifyingContract)));
    const otherGate = bytesToHex(domainSeparator(gateDomain(46630n, '0x000000000000000000000000000000000000beef')));
    const here = bytesToHex(domainSeparator(d));
    assert.notEqual(here, otherChain);
    assert.notEqual(here, otherGate);
  });

  it('spells representation identifiers exactly as the recorded mainnet registry does', () => {
    assert.equal(caip2(4663n), 'eip155:4663');
    assert.equal(
      representationIdFor(4663n, '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9'),
      'eip155:4663/erc20:0xaf3d76f1834a1d425780943c99ea8a608f8a93f9',
    );
  });
});

describe('bound conversion', () => {
  it('rounds a maximum debit down and a minimum credit up, never in the agent\'s favour', () => {
    // 2010.0000009 USD at 18 decimals, into 6-decimal funding atoms.
    const atoms = 2_010n * 10n ** 18n + 900_000_000_000n;
    assert.equal(floorToScale(atoms, 18, 6), 2_010_000_000n);
    assert.equal(ceilToScale(atoms, 18, 6), 2_010_000_001n);
    assert.equal(floorToScale(201_000n, 2, 6), 2_010_000_000n);
    assert.equal(ceilToScale(201_000n, 2, 6), 2_010_000_000n);
  });

  it('brackets the exact value for every scale pair', () => {
    for (const atoms of [0n, 1n, 9n, 10n, 12_345_678_901_234_567_890n]) {
      for (let from = 0; from <= 38; from += 7) {
        for (let to = 0; to <= 38; to += 5) {
          const lo = floorToScale(atoms, from, to);
          const hi = ceilToScale(atoms, from, to);
          assert.ok(hi !== undefined);
          // lo/10^to <= atoms/10^from <= hi/10^to, compared exactly.
          assert.ok(lo * 10n ** BigInt(from) <= atoms * 10n ** BigInt(to));
          assert.ok(hi * 10n ** BigInt(from) >= atoms * 10n ** BigInt(to));
          assert.ok(hi - lo <= 1n);
        }
      }
    }
  });

  it('saturates an unreachable maximum and refuses an unreachable minimum', () => {
    assert.equal(floorToScale(UINT256_MAX, 0, 6), UINT256_MAX);
    assert.equal(ceilToScale(UINT256_MAX, 0, 6), undefined);
  });
});
