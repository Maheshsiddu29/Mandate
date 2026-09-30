/**
 * Evidence classes are honest: LIVE_TESTNET only for the Robinhood
 * integration, only from the recorded Phase 7E.3 files, never for anything
 * this offline run did; fixtures stay FIXTURE, simulated settlement stays
 * SIMULATED. The evidence parser fails closed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROBINHOOD_EVIDENCE_FILES, checkEvidenceClaims, loadRobinhoodEvidence, robinhoodEvidenceFrom, type RobinhoodLiveEvidence } from '../src/index.ts';
import { judgeDemo } from './support/demo.ts';

const demo = judgeDemo();
const REPO = new URL('../../../', import.meta.url);
const recorded = (path: string) => JSON.parse(readFileSync(new URL(path, REPO), 'utf8')) as { [key: string]: unknown };
const manifest = () => recorded(ROBINHOOD_EVIDENCE_FILES.manifest);
const receipt = () => recorded(ROBINHOOD_EVIDENCE_FILES.receipt);

describe('evidence classes', () => {
  it('each domain carries its repository evidence class: Robinhood LIVE_TESTNET, Lighter OFFCHAIN_ONLY, swap/NFT/yield FIXTURE', async () => {
    const { protocol, transcript } = await demo;
    const classes = Object.fromEntries(protocol.core.compiled.bindings.map((b) => [b.domain, b.evidence]));
    assert.deepEqual(classes, { 'robinhood-evm': 'LIVE_TESTNET', 'swap-fixture': 'FIXTURE', 'nft-fixture': 'FIXTURE', 'yield-fixture': 'FIXTURE', 'lighter-perp': 'OFFCHAIN_ONLY' });
    const done = transcript.events.find((e) => e.kind === 'DEMO_COMPLETED');
    const table = done?.data['evidence'] as readonly { domain: string; integrationEvidence: string; thisRun: readonly string[]; historicalLiveEvidence: string | null }[];
    assert.deepEqual(Object.fromEntries(table.map((r) => [r.domain, r.integrationEvidence])), classes);
    assert.deepEqual(Object.fromEntries(table.map((r) => [r.domain, r.thisRun])), { 'robinhood-evm': ['OFFCHAIN_ONLY'], 'swap-fixture': ['SIMULATED'], 'nft-fixture': [], 'yield-fixture': ['SIMULATED'], 'lighter-perp': ['OFFCHAIN_ONLY'] });
    assert.deepEqual(table.filter((r) => r.historicalLiveEvidence !== null).map((r) => r.domain), ['robinhood-evm']);
  });

  it('no fixture, and nothing this run executed, is ever labelled LIVE_TESTNET', async () => {
    const { protocol, transcript } = await demo;
    for (const e of transcript.events) {
      if (e.evidence === 'LIVE_TESTNET') assert.equal(e.kind, 'LIVE_TESTNET_EVIDENCE', `${e.sequence} ${e.kind}`);
      if (e.domain !== null && /fixture/.test(e.domain)) assert.notEqual(e.evidence, 'LIVE_TESTNET', `${e.sequence}`);
    }
    for (const r of [protocol.initial, protocol.attack, protocol.compliant, protocol.conflict]) {
      for (const x of r.executions) {
        assert.notEqual(x.evidence, 'LIVE_TESTNET');
        if (x.integrationEvidence === 'FIXTURE') assert.equal(x.evidence, 'SIMULATED');
      }
    }
    assert.doesNotMatch(transcript.events.map((e) => e.message).join('\n'), /five live|5 live/i);
  });

  it('the Robinhood evidence is read only from the recorded files, value for value', async () => {
    const { transcript } = await demo;
    const e = transcript.events.find((x) => x.kind === 'LIVE_TESTNET_EVIDENCE');
    assert.ok(e !== undefined);
    const m = manifest() as { network: { chainId: number }; contracts: { mandateExecutionGate: { address: string } } };
    const r = receipt() as { authorizedAction: { transaction: string; gasUsed: string; result: string }; replay: { transaction: string; revert: string }; mutation: { amount: { transaction: string; revert: string } }; refusedBeforeTransaction: { transactions: number } };
    assert.equal(e.data['chainId'], m.network.chainId);
    assert.equal((e.data['gate'] as { address: string }).address, m.contracts.mandateExecutionGate.address);
    const buy = e.data['buy'] as { transaction: string; gasUsed: string; status: string };
    assert.deepEqual([buy.transaction, buy.gasUsed, buy.status], [r.authorizedAction.transaction, r.authorizedAction.gasUsed, r.authorizedAction.result]);
    assert.deepEqual([(e.data['replay'] as { transaction: string; revert: string }).transaction, (e.data['replay'] as { revert: string }).revert], [r.replay.transaction, r.replay.revert]);
    assert.equal((e.data['amountMutation'] as { revert: string }).revert, r.mutation.amount.revert);
    assert.equal((e.data['overBudget'] as { transactions: number }).transactions, r.refusedBeforeTransaction.transactions);
    assert.match(String(e.data['seam']), /offline Phase 7F gate configuration/);
    assert.equal(e.status, 'RECORDED');
  });

  it('the parser fails closed on any record that does not support a LIVE_TESTNET claim', () => {
    assert.ok(robinhoodEvidenceFrom(manifest(), receipt()).ok);
    type Tree = { [key: string]: unknown };
    /** Set (or, with `undefined`, delete) one dotted path of a parsed record. */
    const put = (o: Tree, path: string, v: unknown) => {
      const keys = path.split('.');
      const last = keys.pop() as string;
      const parent = keys.reduce<Tree>((cur, k) => cur[k] as Tree, o);
      if (v === undefined) delete parent[last];
      else parent[last] = v;
    };
    const tamper = (file: 'manifest' | 'receipt', path: string, v: unknown): string => {
      const m = manifest();
      const r = receipt();
      put(file === 'manifest' ? m : r, path, v);
      const out = robinhoodEvidenceFrom(m, r);
      assert.equal(out.ok, false, `${file}:${path}`);
      return out.ok ? '' : out.error.join();
    };
    assert.match(tamper('receipt', 'dryRun', true), /not a live run/);
    assert.match(tamper('receipt', 'chainId', 1), /chainId differs/);
    assert.match(tamper('receipt', 'gate', `0x${'11'.repeat(20)}`), /gate differs/);
    assert.match(tamper('receipt', 'authorizedAction.result', 'REVERTED'), /not SUCCESS/);
    assert.match(tamper('receipt', 'authorizedAction.transaction', '0x1234'), /authorizedAction.transaction/);
    assert.match(tamper('receipt', 'replay.status', 'SUCCESS'), /not REVERTED/);
    assert.match(tamper('receipt', 'refusedBeforeTransaction.transactions', 1), /records transactions/);
    assert.match(tamper('manifest', 'network', undefined), /network/);
    assert.equal(robinhoodEvidenceFrom(null, []).ok, false);
  });

  it('a LIVE_TESTNET label without recorded evidence on its chain is refused', async () => {
    const { protocol } = await demo;
    const real = loadRobinhoodEvidence();
    checkEvidenceClaims(protocol, real);
    const elsewhere: RobinhoodLiveEvidence = { ...real, chainId: 1, chain: 'eip155:1' };
    assert.throws(() => checkEvidenceClaims(protocol, elsewhere), /LIVE_TESTNET without recorded evidence/);
  });
});
