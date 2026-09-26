import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verifyAuthorization, AuthorizationScheme, type Bytes32 } from '@mandate/kernel';
import { signHash } from '../../kernel/test/support/signing.ts';
import {
  authorizeExecution,
  gateRevertData,
  MAX_EXECUTION_DATA_BYTES,
  MAX_PROFILE_SET_SIZE,
  recoverSigner,
  settleExecution,
  validateExecutionProfile,
  type ExecutionPlan,
} from '../src/index.ts';
import {
  ADDR,
  AGENT,
  DEPLOYMENT,
  DOMAIN,
  PRINCIPAL,
  PRINCIPAL_KEY,
  STRANGER,
  T0,
  baseBuy,
  baseSell,
  mandateDigestOf,
  now,
  principalHash,
  sign,
} from './support/world.ts';

const ctx = (timestamp = T0) => ({ ...now(timestamp), consumed: new Set<string>() });

function plan(result: ReturnType<typeof authorizeExecution>): ExecutionPlan {
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.rejection, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
  return result.value;
}

describe('reference model: authorization', () => {
  it('can reject an oversized executable profile before either party signs', () => {
    const u = baseBuy();
    const exact = Array.from({ length: MAX_PROFILE_SET_SIZE }, (_, i) => `issuer.${i.toString().padStart(2, '0')}`);
    assert.ok(validateExecutionProfile({ ...u.mandate, allowedIssuers: exact }, {
      ...u.terms,
      executionData: '0x' + '00'.repeat(MAX_EXECUTION_DATA_BYTES),
    }).ok);
    const tooMany = validateExecutionProfile({ ...u.mandate, allowedIssuers: [...exact, 'issuer.16'] }, u.terms);
    assert.ok(!tooMany.ok);
    assert.equal(tooMany.rejection.error, 'ExecutionProfileExceeded');
    const tooLong = validateExecutionProfile(u.mandate, {
      ...u.terms,
      executionData: '0x' + '00'.repeat(MAX_EXECUTION_DATA_BYTES + 1),
    });
    assert.ok(!tooLong.ok);
    assert.equal(tooLong.rejection.error, 'ExecutionProfileExceeded');
  });

  it('plans a BUY as funding in, representation out, bounded by the agent-signed limit', () => {
    const p = plan(authorizeExecution(DEPLOYMENT, sign(baseBuy()), ctx()));
    assert.equal(p.side, 'BUY');
    assert.equal(p.inputToken, ADDR.funding6);
    assert.equal(p.outputToken, ADDR.aapl);
    assert.equal(p.inputAmount, 2_010_000_000n);
    assert.equal(p.minOutput, 10n * 10n ** 18n);
    assert.equal(p.principal, PRINCIPAL);
    assert.equal(p.agent, AGENT);
  });

  it('plans a SELL as exactly the candidate quantity in and at least the agent-signed floor out', () => {
    const p = plan(authorizeExecution(DEPLOYMENT, sign(baseSell()), ctx()));
    assert.equal(p.side, 'SELL');
    assert.equal(p.inputToken, ADDR.aapl);
    assert.equal(p.outputToken, ADDR.funding6);
    assert.equal(p.inputAmount, 10n * 10n ** 18n);
    assert.equal(p.minOutput, 1_990_000_000n);
  });

  it('returns the first refusal in the gate\'s order, not every violation', () => {
    // Agent signature is checked before chain time, so an expired attempt signed
    // by a stranger is refused for the signature.
    const a = sign(baseBuy(), { agentKey: '0x' + '0'.repeat(59) + 'a11ce' });
    const r = authorizeExecution(DEPLOYMENT, a, ctx(T0 + 99_999n));
    assert.ok(!r.ok);
    assert.equal(r.rejection.error, 'AgentSignatureInvalid');
  });

  it('refuses a consumed mandate digest regardless of which execution consumed it', () => {
    const a = sign(baseBuy());
    const consumed = new Set([mandateDigestOf(a.mandate)]);
    const r = authorizeExecution(DEPLOYMENT, a, { ...now(), consumed });
    assert.ok(!r.ok);
    assert.equal(r.rejection.error, 'MandateAlreadyConsumed');
  });

  it('encodes refusals as the exact Solidity revert data', () => {
    const r = authorizeExecution(DEPLOYMENT, sign({ ...baseBuy(), terms: { ...baseBuy().terms, fundingLimit: 2_010_000_001n } }), ctx());
    assert.ok(!r.ok);
    // FundingLimitExceedsMandate(uint256,uint256): selector, then two words.
    assert.equal(
      gateRevertData(r.rejection),
      '0x4eafacbe' + (2_010_000_001n).toString(16).padStart(64, '0') + (2_010_000_000n).toString(16).padStart(64, '0'),
    );
  });
});

describe('reference model: signature acceptance', () => {
  it('accepts exactly the principal signatures the kernel accepts', () => {
    const a = sign(baseBuy());
    const digest = mandateDigestOf(a.mandate) as Bytes32;
    const variants = [
      a.principalSignature,
      a.principalSignature.slice(0, 130) + '00',
      a.principalSignature.slice(0, 130) + '01',
      a.principalSignature.slice(0, 130),
      '0x',
      signHash(principalHash(a.mandate), '0x' + '0'.repeat(59) + 'a11ce'),
    ];
    for (const signature of variants) {
      const kernel = verifyAuthorization(
        { scheme: AuthorizationScheme.EIP712_SECP256K1, signer: { kind: 'eip155-address', value: PRINCIPAL } as never, signature, domain: DOMAIN },
        digest,
        DOMAIN,
      );
      const recovered = recoverSigner(principalHash(a.mandate), signature);
      assert.equal(kernel.ok, recovered === PRINCIPAL, signature);
    }
  });

  it('recovers the signer of a valid signature and nothing for its high-s twin', () => {
    const hash = principalHash(baseBuy().mandate);
    const sig = signHash(hash, PRINCIPAL_KEY);
    assert.equal(recoverSigner(hash, sig), PRINCIPAL);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt('0x' + sig.slice(66, 130));
    const twin = sig.slice(0, 66) + (n - s).toString(16).padStart(64, '0') + (sig.endsWith('1b') ? '1c' : '1b');
    assert.equal(recoverSigner(hash, twin), undefined);
  });
});

describe('reference model: settlement on measured balances', () => {
  const p = plan(authorizeExecution(DEPLOYMENT, sign(baseBuy()), ctx()));

  it('settles when debit <= limit and credit equals the candidate quantity', () => {
    const r = settleExecution(p, { inputBefore: 5_000_000_000n, inputAfter: 5_000_000_000n - 2_006_000_000n, outputBefore: 0n, outputAfter: 10n * 10n ** 18n });
    assert.ok(r.ok);
    assert.equal(r.value.actualDebit, 2_006_000_000n);
  });

  it('refuses a debit one atom over the limit and a credit one atom under the quantity', () => {
    const over = settleExecution(p, { inputBefore: 5_000_000_000n, inputAfter: 5_000_000_000n - 2_010_000_001n, outputBefore: 0n, outputAfter: 10n * 10n ** 18n });
    assert.ok(!over.ok);
    assert.equal(over.rejection.error, 'DebitExceedsLimit');
    const under = settleExecution(p, { inputBefore: 5_000_000_000n, inputAfter: 5_000_000_000n, outputBefore: 0n, outputAfter: 10n * 10n ** 18n - 1n });
    assert.ok(!under.ok);
    assert.equal(under.rejection.error, 'CreditNotExact');
  });

  it('treats a balance that went the favourable way as zero debit, not as a negative one', () => {
    const r = settleExecution(p, { inputBefore: 1n, inputAfter: 2n, outputBefore: 0n, outputAfter: 10n * 10n ** 18n });
    assert.ok(r.ok);
    assert.equal(r.value.actualDebit, 0n);
  });

  it('never consults anything an adapter reports: the plan has no field for it', () => {
    assert.deepEqual(Object.keys(p).sort(), [
      'agent', 'candidateDigest', 'exactQuantity', 'executionCommitment', 'inputAmount', 'inputToken', 'mandateDigest', 'market', 'minOutput', 'outputToken', 'principal', 'recipient', 'side',
    ]);
    void STRANGER;
  });
});
