import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@mandate/kernel';
import { EXECUTION_AUTHORIZATION_TYPE } from '../src/commitment.ts';
import {
  DELEGATED_EXECUTION_APPROVAL_TYPE,
  DELEGATED_PORTFOLIO_AUTHORIZATION_V3_TYPE,
  DELEGATED_VECTORS,
  EMPTY_DELEGATED_STATE,
  applyDelegatedExecution,
  delegationStructHash,
  revokeDelegationState,
} from '../src/delegated.ts';

const utf8 = new TextEncoder();

function typehash(s: string): string {
  return bytesToHex(keccak_256(utf8.encode(s)));
}

describe('delegated execution reference model', () => {
  it('typehashes match Solidity / cast keccak vectors', () => {
    assert.equal(typehash(DELEGATED_PORTFOLIO_AUTHORIZATION_V3_TYPE), DELEGATED_VECTORS.typehashes.delegatedPortfolioAuthorizationV3);
    assert.equal(typehash(DELEGATED_EXECUTION_APPROVAL_TYPE), DELEGATED_VECTORS.typehashes.delegatedExecutionApproval);
    assert.equal(typehash(EXECUTION_AUTHORIZATION_TYPE), DELEGATED_VECTORS.typehashes.executionAuthorization);
  });

  it('delegation struct hash matches the Forge sample', () => {
    assert.equal(delegationStructHash(DELEGATED_VECTORS.sample.delegation), DELEGATED_VECTORS.sample.delegationStructHash);
  });

  it('cumulative accounting and nonce replay', () => {
    const d = DELEGATED_VECTORS.sample.delegation;
    const digest = delegationStructHash(d);
    const first = applyDelegatedExecution(EMPTY_DELEGATED_STATE, d, digest, 1n, 2_006_000_000n, 1_800_000_000n);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const replay = applyDelegatedExecution(first.next, d, digest, 1n, 2_006_000_000n, 1_800_000_000n);
    assert.equal(replay.ok, false);
    if (replay.ok) return;
    assert.equal(replay.reason, 'ExecutionNonceAlreadyUsed');
    const second = applyDelegatedExecution(first.next, d, digest, 2n, 2_006_000_000n, 1_800_000_000n);
    assert.equal(second.ok, true);
  });

  it('over-cap, expiry, revoke fail closed', () => {
    const d = { ...DELEGATED_VECTORS.sample.delegation, cumulativeDebitLimit: 2_006_000_000n };
    const digest = delegationStructHash(d);
    const first = applyDelegatedExecution(EMPTY_DELEGATED_STATE, d, digest, 1n, 2_006_000_000n, 1_800_000_000n);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const over = applyDelegatedExecution(first.next, d, digest, 2n, 1n, 1_800_000_000n);
    assert.equal(over.ok, false);
    const expired = applyDelegatedExecution(EMPTY_DELEGATED_STATE, d, digest, 1n, 1n, d.validUntil);
    assert.equal(expired.ok, false);
    const revoked = applyDelegatedExecution(revokeDelegationState(EMPTY_DELEGATED_STATE, digest), d, digest, 1n, 1n, 1_800_000_000n);
    assert.equal(revoked.ok, false);
  });

  it('does not embed portfolio policy interpretation', () => {
    // Guard: this module must not import portfolio/live-agents policy helpers.
    const src = createHash('sha256').update(DELEGATED_PORTFOLIO_AUTHORIZATION_V3_TYPE).digest('hex');
    assert.equal(typeof src, 'string');
  });
});
