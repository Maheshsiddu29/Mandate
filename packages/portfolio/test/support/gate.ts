/**
 * The stock child's real issuance path, offline: the portfolio's compiled
 * grants in the SQLite reference store with its durable lifecycle table, the
 * existing `GateSigner`, `LocalGateCustody` behind the portfolio's mandatory
 * signer factory, the stock agent's own key, and a chain that executes
 * every call through the Phase 6 reference model (the evm-robinhood test
 * `ModelChain`, which the frozen differential corpus proves byte-equal in its
 * decisions to the Solidity gate). **SIMULATED: no transaction is sent.**
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAdapterRef, validatePrincipalId, type ReservationId } from '@mandate/core';
import { DurableAdapterRegistry, DurableModuleRegistry, IssuanceJournal, SqliteLedgerStore, openLifecycle } from '@mandate/ledger-sqlite';
import { GateSigner, LocalAgentSigner, LocalGateCustody, gateAdapterRef, type GateKeyCustody } from '@mandate/evm-robinhood';
import {
  compilePortfolio,
  createPortfolioCore,
  createPortfolioGateSigner,
  registerPortfolio,
  type ActionCandidate,
  type ChildExecutionAuthorization,
  type PortfolioCore,
  type StockBinding,
  type VerificationTranscript,
} from '../../src/index.ts';
import { DEMO_DOMAIN_SEPARATOR, DEMO_GATE, DEMO_GATE_CODEHASH, DEMO_GATE_CONFIG, DEMO_T0, DEMO_USDC_TOKEN, PRINCIPAL, USDC, demoBindings, demoKey, demoMandate, demoParty } from '../../src/demo/index.ts';
import { ModelChain } from '../../../evm-robinhood/test/support/world.ts';
import { NOW } from './candidates.ts';

export interface GateWorld {
  readonly core: PortfolioCore;
  readonly store: ReturnType<typeof SqliteLedgerStore.open>;
  readonly chain: ModelChain;
  readonly signer: GateSigner;
  readonly binding: StockBinding;
  readonly children: Map<string, { child: ChildExecutionAuthorization; candidate: ActionCandidate; record: import('@mandate/control').AuthorizationRecord; transcript: VerificationTranscript }>;
  readonly keyUses: () => number;
  close(): void;
}

export async function gateWorld(): Promise<GateWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-portfolio-gate-'));
  const path = join(dir, 'ledger.db');
  const m = demoMandate();
  const compiled = compilePortfolio(m, demoBindings());
  if (!compiled.ok) assert.fail('compile');
  const lifecycle = openLifecycle(path);
  for (const mod of compiled.value.modules) lifecycle.table.setModule({ module: mod.ref, status: 'ACTIVE', implementations: [mod.implementation] });
  for (const a of compiled.value.adapters) {
    const ref = validateAdapterRef(a);
    if (!ref.ok) assert.fail('adapter');
    lifecycle.table.setAdapter({ adapter: ref.value, status: 'ACTIVE' });
  }
  let store: ReturnType<typeof SqliteLedgerStore.open> | null = null;
  const core = createPortfolioCore(compiled.value, {
    storeOf: (rules) => (store = SqliteLedgerStore.open({ path, rules })),
    registries: { modules: new DurableModuleRegistry(lifecycle.table), adapters: new DurableAdapterRegistry(lifecycle.table) },
  });
  if (store === null) assert.fail('store');
  const sqlite = store as ReturnType<typeof SqliteLedgerStore.open>;
  const registered = await registerPortfolio(core, DEMO_T0);
  if (!registered.ok) assert.fail(`register: ${JSON.stringify(registered.error)}`);

  const binding = compiled.value.bindings.find((b) => b.kind === 'STOCK_BUY') as StockBinding;
  const adapterRef = gateAdapterRef({ gate: DEMO_GATE_CONFIG, gateCodehash: DEMO_GATE_CODEHASH, domainSeparator: DEMO_DOMAIN_SEPARATOR });
  const principalId = validatePrincipalId(PRINCIPAL, 'p');
  if (!principalId.ok) assert.fail('principal');
  const journal = new IssuanceJournal(sqlite);
  const chain = new ModelChain(NOW + 5n, DEMO_GATE_CONFIG);
  chain.fund(DEMO_USDC_TOKEN, PRINCIPAL.value, USDC(1_000n));
  // The principal's only approval is to the gate, for exactly its spot-capital authority.
  chain.approve(DEMO_USDC_TOKEN, PRINCIPAL.value, DEMO_GATE, USDC(800n));
  const children = new Map<string, { child: ChildExecutionAuthorization; candidate: ActionCandidate; record: import('@mandate/control').AuthorizationRecord; transcript: VerificationTranscript }>();
  const inner = new LocalGateCustody(
    demoKey('principal'),
    {
      ledger: () => sqlite.readCommitted(principalId.value).state,
      issued: (attempt) => journal.get(attempt) !== null,
      lifecycle: (kind, name, version) => {
        const row = lifecycle.table.read(kind, name, version);
        if (row === null) return null;
        const ref = JSON.parse(row.ref) as { moduleDigest?: string; adapterDigest?: string };
        return { status: row.status, digest: ref.moduleDigest ?? ref.adapterDigest ?? '' };
      },
      now: () => chain.time,
    },
    { module: binding.policy.ref, adapter: adapterRef },
  );
  let keyUses = 0;
  const counted: GateKeyCustody = {
    principal: () => inner.principal(),
    signMandate: (artifact, terms, claim) => {
      keyUses += 1;
      return inner.signMandate(artifact, terms, claim);
    },
  };
  const signer = createPortfolioGateSigner({
    engine: core.engine,
    store: sqlite,
    journal,
    custody: counted,
    agent: new LocalAgentSigner(demoKey('stock')),
    chain,
    config: { gate: DEMO_GATE_CONFIG, gateCodehash: DEMO_GATE_CODEHASH, domainSeparator: DEMO_DOMAIN_SEPARATOR, principal: principalId.value, principalAddress: PRINCIPAL.value, agentAddress: demoParty('stock').value, adapter: adapterRef, policy: binding.policy.ref, deadlineSeconds: 120n, retry: { maxAttempts: 32 } },
    portfolio: { core, childOf: (r: ReservationId) => children.get(r) ?? null, transcriptOf: (r: ReservationId) => children.get(r)?.transcript ?? null, state: () => sqlite.readCommitted(principalId.value).state },
  });
  return {
    core,
    store: sqlite,
    chain,
    signer,
    binding,
    children,
    keyUses: () => keyUses,
    close: () => {
      sqlite.close();
      lifecycle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
