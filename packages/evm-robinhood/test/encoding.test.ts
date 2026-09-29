/**
 * The adapter's own encoders against independent references: `execute`
 * calldata against the differential corpus's ABI encoder (which the Solidity
 * harness decodes), EIP-1559 signatures by public-key recovery, CREATE
 * addresses against the gate test world's derivation, and the gate artifact
 * against the reference model's decoder.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { decodeGateCandidate, decodeGateMandate, validateExecutionProfile } from '@mandate/execution-gate';
import { abiEncodeArguments, bytes, tuple, CANDIDATE, MANDATE, TERMS } from '../../execution-gate/test/support/abi.ts';
import { createAddress as referenceCreateAddress } from '../../execution-gate/test/support/world.ts';
import { EXECUTE_SELECTOR, EXECUTE_SIGNATURE, TxSender, buildGateArtifact, calldata, createAddress, encodeArguments, executeCalldata, gateAdapterRef } from '../src/index.ts';
import { signingHash, rlpEncode, quantityBytes } from '../src/transaction.ts';
import { hexBytes, toHex, tuple as myTuple, uint, int, address } from '../src/abi.ts';
import { ADAPTER_CONFIG, AGENT, CHAIN, MARKET, PRINCIPAL, REVIEWED, SUBMITTER_KEY, T, mdemo } from './support/world.ts';

const source = { executionId: `0x${'01'.repeat(32)}` as never, authorizationId: `0x${'02'.repeat(32)}` as never, reservation: `0x${'03'.repeat(32)}` as never, generation: 1n as never, adapter: gateAdapterRef(ADAPTER_CONFIG), evaluatedAt: T, validUntil: T + 3_600n };
const terms = { gate: REVIEWED, market: MARKET, principal: PRINCIPAL, agent: AGENT, quantity: mdemo(30n), nonce: 1n, deadline: T + 120n };

describe('execute calldata', () => {
  it('equals the differential corpus encoder’s bytes after the verified selector', () => {
    const a = buildGateArtifact(source, terms);
    const sig = `0x${'11'.repeat(64)}1b`;
    const mine = executeCalldata(a.mandate, sig, a.candidate, a.terms, sig);
    const ref = abiEncodeArguments(tuple(['m', MANDATE], ['ps', bytes], ['c', CANDIDATE], ['t', TERMS], ['as', bytes]), { m: a.mandate, ps: sig, c: a.candidate, t: a.terms, as: sig });
    assert.equal(mine, `${EXECUTE_SELECTOR}${ref.slice(2)}`);
    assert.equal(toHex(keccak_256(new TextEncoder().encode(EXECUTE_SIGNATURE)).subarray(0, 4)), EXECUTE_SELECTOR);
  });

  it('lays static tuples out inline, as Solidity does', () => {
    const t = myTuple(['a', uint(8)], ['b', address]);
    const enc = toHex(encodeArguments([t, uint(256)], [{ a: 7n, b: '0x00000000000000000000000000000000000000ff' }, 9n]));
    assert.equal(enc, `0x${'7'.padStart(64, '0')}${'ff'.padStart(64, '0')}${'9'.padStart(64, '0')}`);
    assert.equal(calldata('f(int64)', [int(64)], [-1n]).slice(10), 'f'.repeat(64));
    assert.throws(() => encodeArguments([uint(8)], [256n]));
    assert.throws(() => encodeArguments([address], ['0x00000000000000000000000000000000000000FF']));
  });
});

describe('the gate artifact', () => {
  it('decodes under the kernel’s own MCE v2 and Candidate V3 decoders and fits the executable profile', () => {
    const a = buildGateArtifact(source, terms);
    const m = decodeGateMandate(a.mandate);
    const c = decodeGateCandidate(a.candidate);
    assert.ok(m.ok && m.value.digest === a.mandateDigest);
    assert.ok(c.ok && c.value.digest === a.candidateDigest);
    assert.ok(validateExecutionProfile(a.mandate, a.terms).ok);
  });
});

/** Decode one RLP list of byte strings (no nesting beyond an empty access list). */
function rlpList(b: Uint8Array): Uint8Array[] {
  const len = (off: number, n: number) => { let v = 0; for (let i = 0; i < n; i += 1) v = v * 256 + (b[off + i] as number); return v; };
  let p = b[0] as number;
  let i = p <= 0xf7 ? 1 : 1 + (p - 0xf7);
  const out: Uint8Array[] = [];
  while (i < b.length) {
    p = b[i] as number;
    if (p < 0x80) { out.push(b.subarray(i, i + 1)); i += 1; }
    else if (p <= 0xb7) { out.push(b.subarray(i + 1, i + 1 + p - 0x80)); i += 1 + p - 0x80; }
    else if (p <= 0xbf) { const n = p - 0xb7; const l = len(i + 1, n); out.push(b.subarray(i + 1 + n, i + 1 + n + l)); i += 1 + n + l; }
    else { out.push(new Uint8Array(0)); i += 1 + (p <= 0xf7 ? p - 0xc0 : len(i + 1, p - 0xf7) + p - 0xf7); }
  }
  return out;
}

describe('EIP-1559 transactions', () => {
  it('signatures recover to the sender, and the chain id is fixed', () => {
    const s = new TxSender(SUBMITTER_KEY, CHAIN);
    const tx = { chainId: CHAIN, nonce: 3n, maxPriorityFeePerGas: 0n, maxFeePerGas: 20_000_001n, gasLimit: 500_000n, to: PRINCIPAL, value: 0n, data: '0x1234' };
    const signed = s.signTransaction(tx);
    assert.equal(signed.hash, toHex(keccak_256(hexBytes(signed.raw))));
    assert.equal(signed.raw.slice(0, 4), '0x02');
    // Decode the typed envelope's RLP list; its last three items are yParity, r, s.
    const items = rlpList(hexBytes(`0x${signed.raw.slice(4)}`));
    assert.equal(items.length, 12);
    const [yParity, r, sv] = items.slice(9) as [Uint8Array, Uint8Array, Uint8Array];
    const rs = new Uint8Array(64);
    rs.set(r, 32 - r.length);
    rs.set(sv, 64 - sv.length);
    const pub = secp256k1.Signature.fromBytes(rs).addRecoveryBit(yParity.length === 0 ? 0 : (yParity[0] as number)).recoverPublicKey(signingHash(tx));
    assert.equal(toHex(keccak_256(pub.toBytes(false).subarray(1)).subarray(12)), s.address);
    assert.throws(() => s.signTransaction({ ...tx, chainId: 4_663n }), /bound to chain/);
  });

  it('RLP follows the Yellow Paper on its boundary cases', () => {
    assert.equal(toHex(rlpEncode(new Uint8Array(0))), '0x80');
    assert.equal(toHex(rlpEncode(new Uint8Array([0x7f]))), '0x7f');
    assert.equal(toHex(rlpEncode(new Uint8Array([0x80]))), '0x8180');
    assert.equal(toHex(rlpEncode([])), '0xc0');
    assert.equal(toHex(rlpEncode(new Uint8Array(56))).slice(0, 6), '0xb838');
    assert.equal(toHex(quantityBytes(0n)), '0x');
    assert.equal(toHex(quantityBytes(0x100n)), '0x0100');
  });

  it('CREATE addresses match the gate test world’s derivation', () => {
    for (let n = 1; n < 5; n += 1) assert.equal(createAddress('0x000000000000000000000000000000000000a7e0', BigInt(n)), referenceCreateAddress('0x000000000000000000000000000000000000a7e0', n));
    // A well-known vector: the first contract of 0x6ac7…c0a4 is 0xcd23…c1d8.
    assert.equal(createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 0n), '0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d');
  });
});
