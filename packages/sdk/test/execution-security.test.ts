/**
 * C3.6 side-effect boundaries + security scan of the facade.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMandateClient, liveLabDomainBindings } from '../src/index.ts';
import type { PrepareExecutionResult, ReconciliationResult, SettlementBackend } from '../src/types.ts';

describe('sdk execution + reconcile side effects', () => {
  it('prepareExecution broadcasts 0 transactions', async () => {
    let prepareCalls = 0;
    const backend: SettlementBackend = {
      async prepareExecution(): Promise<PrepareExecutionResult> {
        prepareCalls += 1;
        return {
          ok: true,
          execution: {
            broadcasts: 0,
            prepared: { to: '0xgate', calldata: '0x', note: 'dry-run only' },
          },
        };
      },
      async reconcile(): Promise<ReconciliationResult> {
        return { ok: true, reports: [], resent: false, broadcasts: 0 };
      },
    };
    const client = createMandateClient({
      principal: '0x1111111111111111111111111111111111111111',
      chainId: 1,
      now: () => 1n,
      bindings: liveLabDomainBindings(),
      settlement: backend,
    });
    const result = await client.prepareExecution({
      ok: true,
      reservationId: '0xabc',
      childDigest: '0xdef',
      proposalDigest: '0x123',
      ledgerVersion: '1',
      broadcasts: 0,
    });
    assert.equal(prepareCalls, 1);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.execution.broadcasts, 0);
  });

  it('reconcile never resends a confirmed settlement', async () => {
    const backend: SettlementBackend = {
      async prepareExecution(): Promise<PrepareExecutionResult> {
        return { ok: false, code: 'UNUSED', message: '', broadcasts: 0 };
      },
      async reconcile(): Promise<ReconciliationResult> {
        return { ok: true, reports: [], resent: false, broadcasts: 0 };
      },
    };
    const client = createMandateClient({
      principal: '0x1111111111111111111111111111111111111111',
      chainId: 1,
      now: () => 1n,
      bindings: liveLabDomainBindings(),
      settlement: backend,
    });
    const result = await client.reconcile({});
    assert.equal(result.ok, true);
    assert.equal(result.resent, false);
    assert.equal(result.broadcasts, 0);
  });

  it('SDK refuses a settlement backend that claims a broadcast during prepare', async () => {
    const backend: SettlementBackend = {
      async prepareExecution(): Promise<PrepareExecutionResult> {
        return {
          ok: true,
          execution: {
            broadcasts: 1 as 0,
            prepared: {},
          },
        };
      },
      async reconcile(): Promise<ReconciliationResult> {
        return { ok: true, reports: [], resent: false, broadcasts: 0 };
      },
    };
    const client = createMandateClient({
      principal: '0x1111111111111111111111111111111111111111',
      chainId: 1,
      now: () => 1n,
      bindings: liveLabDomainBindings(),
      settlement: backend,
    });
    const result = await client.prepareExecution({
      ok: true,
      reservationId: '0xabc',
      childDigest: '0xdef',
      proposalDigest: '0x123',
      ledgerVersion: '1',
      broadcasts: 0,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'UNEXPECTED_BROADCAST');
  });
});

describe('sdk security surface', () => {
  it('source tree has none of the forbidden secret/broadcast patterns', () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    for (const f of readdirSync(root, { recursive: true }).map(String)) {
      if (!f.endsWith('.ts') || f.startsWith('examples/')) continue;
      const text = readFileSync(join(root, f), 'utf8');
      assert.doesNotMatch(text, /privateKey|mnemonic|\bseed\b|process\.env|cast send|eth_sendTransaction|eth_sendRawTransaction/, f);
    }
  });
});
