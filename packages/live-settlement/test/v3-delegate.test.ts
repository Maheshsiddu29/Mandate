import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addressOfKey, demoKey } from '@mandate/portfolio/demo';
import {
  createExecutionDelegate,
  restoredExecutionDelegate,
  VerifiedDelegatedExecution,
} from '../src/v3/execution-delegate.ts';
import { deriveV3StockFixtureCap } from '../src/v3/cap.ts';
import { AutonomousSettlementGate } from '../src/v3/autonomous-gate.ts';
import { representationIdFor } from '@mandate/execution-gate';

const GATE = '0xa0cb889707d426a7a386870a03bc70d1b0697598';
const MARKET = {
  representation: '0x5d4c3618f996777baf0e0468884bb7a440f189e1',
  fundingToken: '0x53b640b9a573e33c541de5a4917bc4d28d956abf',
  adapter: '0x1111111111111111111111111111111111111111',
  venue: '0x2222222222222222222222222222222222222222',
  representationDecimals: 18,
  fundingDecimals: 6,
  canonicalAsset: { assetClass: 'fixture', idScheme: 'mandate-demo', value: 'MDEMO' },
  issuer: 'issuer.mandate-demo',
  venueId: 'venue.mandate-fixture',
  quantityUnit: 'TOKEN',
  settlementUnit: 'MDUSD',
  synthetic: false,
  fixturePrice: { atoms: 10_000_000n, decimals: 6 },
  feeBps: 0,
} as const;

describe('C2.3 V3 delegate and cap', () => {
  it('delegate address is never the Stock agent key', () => {
    const d = createExecutionDelegate();
    const stock = addressOfKey(demoKey('stock'));
    assert.notEqual(d.public.address, stock);
    assert.match(d.public.address, /^0x[0-9a-f]{40}$/);
    assert.equal(d.canSign, true);
  });

  it('restored delegate cannot sign', () => {
    const fresh = createExecutionDelegate();
    const restored = restoredExecutionDelegate(fresh.public.address);
    assert.equal(restored.canSign, false);
    assert.equal(restored.public.address, fresh.public.address);
    const artifact = VerifiedDelegatedExecution.create({
      chainId: 46_630n,
      gate: GATE,
      fields: {
        delegationDigest: `0x${'11'.repeat(32)}`,
        mandateDigest: `0x${'22'.repeat(32)}`,
        candidateDigest: `0x${'33'.repeat(32)}`,
        recipient: '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23',
        fundingLimit: 32_000_000n,
        deadline: 1_800_000_300n,
        executionDataHash: `0x${'44'.repeat(32)}`,
        executionNonce: 1n,
      },
    });
    assert.ok(artifact);
    assert.throws(() => restored.signDelegatedExecution(artifact!), /DELEGATE_KEY_UNAVAILABLE/);
  });

  it('fresh delegate signs a verified artifact; refuses unverified objects', () => {
    const d = createExecutionDelegate();
    const artifact = VerifiedDelegatedExecution.create({
      chainId: 46_630n,
      gate: GATE,
      fields: {
        delegationDigest: `0x${'11'.repeat(32)}`,
        mandateDigest: `0x${'22'.repeat(32)}`,
        candidateDigest: `0x${'33'.repeat(32)}`,
        recipient: '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23',
        fundingLimit: 32_000_000n,
        deadline: 1_800_000_300n,
        executionDataHash: `0x${'44'.repeat(32)}`,
        executionNonce: 1n,
      },
    });
    assert.ok(artifact);
    const sig = d.signDelegatedExecution(artifact!);
    assert.match(sig, /^0x[0-9a-f]{130}$/);
    assert.throws(() => d.signDelegatedExecution({} as never), /UNVERIFIED_ARTIFACT/);
  });

  it('cap uses plan when auto-realloc is off, maximum when on', () => {
    const plan = deriveV3StockFixtureCap({
      stock: { enabled: true, budget: '400000000', maxAllocation: '800000000' },
      autoReallocate: false,
      market: MARKET as never,
    });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.basis, 'PLAN');
    assert.equal(plan.stockAuthorityUsdcAtoms, 400_000_000n);
    // 400 USDC → 3.2 notes → 32 MDUSD at 10 MDUSD/MDEMO
    assert.equal(plan.cumulativeDebitLimit, 32_000_000n);

    const max = deriveV3StockFixtureCap({
      stock: { enabled: true, budget: '400000000', maxAllocation: '800000000' },
      autoReallocate: true,
      market: MARKET as never,
    });
    assert.equal(max.ok, true);
    if (!max.ok) return;
    assert.equal(max.basis, 'MAXIMUM');
    assert.equal(max.stockAuthorityUsdcAtoms, 800_000_000n);
    assert.equal(max.cumulativeDebitLimit, 64_000_000n);
  });

  it('autonomous gate is separate from SendGate and pause stops authorization', () => {
    const g = new AutonomousSettlementGate();
    assert.equal(g.mayAuthorizeExecution(), false);
    g.arm();
    assert.equal(g.mayAuthorizeExecution(), true);
    g.pause();
    assert.equal(g.mayAuthorizeExecution(), false);
    g.resume();
    assert.equal(g.mayAuthorizeExecution(), true);
    g.disarm();
    assert.equal(g.mayAuthorizeExecution(), false);
  });

  it('representation id helper stays on the fixture market', () => {
    assert.equal(
      representationIdFor(46_630n, MARKET.representation),
      'eip155:46630/erc20:0x5d4c3618f996777baf0e0468884bb7a440f189e1',
    );
  });
});
