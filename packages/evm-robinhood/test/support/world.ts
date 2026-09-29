/**
 * A deterministic offline world for GateSpotPolicy and the Robinhood gate
 * signer: the policy over a reviewed fixture gate, the SQLite reference store
 * with its durable lifecycle table, the control engine, fixed published test
 * keys, and a fake chain that executes every submitted attempt through the
 * Phase 6 reference model (`authorizeExecution` → a simulated `FixtureVenue`
 * → `settleExecution`) — the model the differential corpus proves equal to the
 * Solidity gate. No network, no clock.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, domainSeparator } from '@mandate/kernel';
import {
  actionPayloadDigest,
  authorityId,
  validateActionEnvelope,
  validateAdapterRef,
  validateAuthorityGrant,
  validateModuleRef,
  validatePrincipalId,
  validatePrincipalPolicy,
  type ActionEnvelope,
  type AdapterRefInput,
  type AuthorityGrant,
  type AuthorityTermInput,
  type LedgerDimensionInput,
  type PartyIdInput,
  type PrincipalPolicy,
  type PrincipalPolicyTermInput,
  type StateSourceId,
} from '@mandate/core';
import { type RetryPolicy } from '@mandate/ledger';
import { ControlEngine, ModuleCatalog, controlRules, type AuthorizationOutcome, type AuthorizationRecord, type DomainModule, type EvaluationContextInput, type SuppliedState } from '@mandate/control';
import { DurableAdapterRegistry, DurableModuleRegistry, IssuanceJournal, SqliteLedgerStore, openLifecycle, type LifecycleTable } from '@mandate/ledger-sqlite';
import { authorizeExecution, gateDomain, reject, settleExecution, gateRevertData, type GateAttempt, type GateRejection } from '@mandate/execution-gate';
import {
  ACTION_GATE_BUY,
  DOMAIN_ID,
  GateSigner,
  LocalAgentSigner,
  LocalGateCustody,
  STATE_GATE_MARKET,
  accountResource,
  keyAddress,
  buyCost,
  createAddress,
  createGateSpotPolicy,
  encodeGateBuy,
  executeCalldata,
  gateAdapterRef,
  gateAdapterRefInput,
  gateDeploymentOf,
  gateMarketState,
  marketResource,
  reviewedSnapshot,
  type BlockRef,
  type GateCall,
  type GateChain,
  type GateSignerDeps,
  type GateSpotConfig,
  type GateSpotPolicy,
  type Read,
  type Receipt,
  type ReviewedGate,
  type ReviewedMarket,
  type Simulation,
  type Submission,
} from '../../src/index.ts';
import { TEST_PRIVATE_KEY, TEST_PRIVATE_KEY_2 } from '../../../kernel/test/support/signing.ts';

export function must<T>(r: { ok: true; value: T } | { ok: false; error: object }): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error, (_, v: bigint | string) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r.value;
}

// --- Keys and parties (fixed, published test keys: they secure nothing) ----------------------

export const PRINCIPAL_KEY = TEST_PRIVATE_KEY;
export const AGENT_KEY = TEST_PRIVATE_KEY_2;
export const SUBMITTER_KEY = `0x${'0'.repeat(59)}5ab17`;
export const STRANGER_KEY = `0x${'0'.repeat(59)}a11ce`;

export const PRINCIPAL = keyAddress(PRINCIPAL_KEY);
export const AGENT = keyAddress(AGENT_KEY);
export const P: PartyIdInput = { kind: 'eip155-address', value: PRINCIPAL };
export const AGENT_PARTY: PartyIdInput = { kind: 'eip155-address', value: AGENT };
export const PRINCIPAL_ID = must(validatePrincipalId(P, 'p'));

export const T0 = 1_790_812_800n; // 2026-10-01T00:00:00Z
export const T = T0 + 1_000n;
export const T_END = T0 + 90n * 86_400n;
export const ONCE: RetryPolicy = { maxAttempts: 1 };
export const RETRY: RetryPolicy = { maxAttempts: 32 };

// --- The reviewed fixture gate ------------------------------------------------------------------

export const CHAIN = 46_630n;
export const GATE = '0x000000000000000000000000000000000000a7e0';
export const MDEMO = '0x000000000000000000000000000000000000aa01';
export const MDUSD = '0x000000000000000000000000000000000000f006';
export const OTHER_TOKEN = '0x000000000000000000000000000000000000aa02';
export const GATE_CODEHASH = `0x${'c0'.repeat(32)}`;
export const DOMAIN_SEPARATOR = bytesToHex(domainSeparator(gateDomain(CHAIN, GATE)));

/** 10.000000 MDUSD per MDEMO, no fee: the demo market's economics. */
export const MARKET: ReviewedMarket = {
  representation: MDEMO,
  fundingToken: MDUSD,
  venue: createAddress(GATE, 1n),
  adapter: createAddress(GATE, 2n),
  representationDecimals: 18,
  fundingDecimals: 6,
  canonicalAsset: { assetClass: 'fixture', idScheme: 'mandate-demo', value: 'MDEMO' },
  issuer: 'issuer.mandate-demo',
  venueId: 'venue.mandate-fixture',
  quantityUnit: 'TOKEN',
  settlementUnit: 'MDUSD',
  synthetic: false,
  fixturePrice: { decimals: 6, atoms: 10_000_000n },
  feeBps: 0,
};

export const REVIEWED: ReviewedGate = { chainId: CHAIN, gate: GATE, markets: [MARKET] };
export const SOURCE = 'robinhood.rpc' as StateSourceId;

export function policyConfig(gate: ReviewedGate = REVIEWED): GateSpotConfig {
  return { gate, sources: { gateMarket: SOURCE }, maxMarketAgeSeconds: 60n, lifetimeSeconds: 3_600n };
}

export const ADAPTER_CONFIG = { gate: REVIEWED, gateCodehash: GATE_CODEHASH, domainSeparator: DOMAIN_SEPARATOR };
export const ADAPTER: AdapterRefInput = gateAdapterRefInput(ADAPTER_CONFIG);
export const ACCOUNT = accountResource(CHAIN, PRINCIPAL);
export const DEMO_MARKET = marketResource(CHAIN, MDEMO);

/** Whole MDEMO at 18 decimals. */
export const mdemo = (n: bigint) => n * 10n ** 18n;
/** Whole MDUSD at 6 decimals. */
export const mdusd = (n: bigint) => n * 10n ** 6n;

// --- Terms ----------------------------------------------------------------------------------------

export function capitalDim(unit: string, atoms: bigint, decimals = 6): LedgerDimensionInput {
  return { kind: 'LEDGER_DIMENSION', dimensionId: `capital-${unit.toLowerCase()}`, limit: { kind: 'CAPITAL', unit, decimals, atoms }, accounting: 'CAPACITY', restoration: 'AS_CHARGED', epoch: null, sign: 'UNSIGNED', scope: { asset: null, market: null, domain: null, account: null } };
}

export function coverage(policy: GateSpotPolicy, adapters: readonly AdapterRefInput[] = [ADAPTER], markets = [DEMO_MARKET]): AuthorityTermInput[] {
  const ref = policy.ref;
  return [
    { kind: 'SET', vocabulary: 'MODULES', members: [{ domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest }] },
    { kind: 'SET', vocabulary: 'ADAPTERS', members: [...adapters] },
    { kind: 'SET', vocabulary: 'ACTION_TYPES', members: [{ domain: DOMAIN_ID, actionType: ACTION_GATE_BUY }] },
    { kind: 'SET', vocabulary: 'MARKETS', members: markets.map((m) => ({ domain: m.domain, kind: m.kind, localId: m.localId })) },
    { kind: 'RIGHT', right: 'OPEN_RISK' },
  ];
}

export function principalPolicy(terms: readonly PrincipalPolicyTermInput[] = []): PrincipalPolicy {
  return must(validatePrincipalPolicy({ principal: P, sequence: 1n, terms, nonce: 0n }));
}

export function rootGrant(policy: GateSpotPolicy, terms: readonly AuthorityTermInput[]): AuthorityGrant {
  return must(validateAuthorityGrant({ lineage: { kind: 'ROOT', issuer: P }, principal: P, holder: AGENT_PARTY, notBefore: T0, expiresAt: T_END, terms: [...coverage(policy), ...terms], nonce: 0n }));
}

// --- State, context, actions ---------------------------------------------------------------------

export function marketStates(policy: GateSpotPolicy, at: bigint = T, market: ReviewedMarket = MARKET): SuppliedState[] {
  return [gateMarketState(policy, reviewedSnapshot(CHAIN, GATE, market), at)];
}

export function context(at: bigint = T): EvaluationContextInput {
  return { evaluationTime: at, sources: [{ sourceId: SOURCE, trustClass: 'VERIFIED', kinds: [{ domain: DOMAIN_ID, stateKind: STATE_GATE_MARKET }] }], blockHeads: [], sequenceWatermarks: [] };
}

export function buy(policy: GateSpotPolicy, authority: AuthorityGrant, quantity: bigint, o: { nonce?: bigint; validFrom?: bigint; adapter?: AdapterRefInput; account?: ReturnType<typeof accountResource>; market?: ReturnType<typeof marketResource> } = {}): { envelope: ActionEnvelope; payload: Uint8Array } {
  const ref = policy.ref;
  const moduleInput = { domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest };
  const account = o.account ?? ACCOUNT;
  const market = o.market ?? DEMO_MARKET;
  const payload = encodeGateBuy({ account, market, quantity });
  return {
    envelope: must(
      validateActionEnvelope({
        principal: P,
        authority: authorityId(authority),
        actor: AGENT_PARTY,
        module: moduleInput,
        actionType: ACTION_GATE_BUY,
        adapter: o.adapter ?? ADAPTER,
        target: market,
        resources: [account],
        payloadDigest: must(actionPayloadDigest(must(validateModuleRef(moduleInput)), payload)),
        validFrom: o.validFrom ?? T0,
        expiresAt: T_END,
        nonce: o.nonce ?? 0n,
      }),
    ),
    payload,
  };
}

export function request(policy: GateSpotPolicy, a: { envelope: ActionEnvelope; payload: Uint8Array }, at: bigint = T) {
  return { action: a.envelope, payload: a.payload, generation: 1n, states: marketStates(policy, at), context: context(at) };
}

export function authorized(o: AuthorizationOutcome): AuthorizationRecord {
  if (o.status !== 'AUTHORIZED') assert.fail(`expected AUTHORIZED, got ${o.status} ${o.refusal.code}/${o.refusal.reason} at ${o.refusal.path}`);
  return o.authorization;
}

export function refusal(o: AuthorizationOutcome): { code: string; reason: string } {
  if (o.status !== 'REFUSED') assert.fail(`expected REFUSED, got ${o.status}`);
  return { code: o.refusal.code, reason: o.refusal.reason };
}

// --- The fake chain: the Phase 6 reference model over simulated balances ---------------------------

const key = (token: string, owner: string) => `${token}:${owner}`;
const ZERO32 = `0x${'0'.repeat(64)}`;

export interface ModelTx {
  readonly txHash: string;
  readonly call: GateCall;
  readonly result: 'SUCCESS' | 'REVERTED';
  readonly revert: string | null;
  readonly block: bigint;
}

/**
 * Executes `execute` exactly as the reference model decides it, with the
 * fixture venue simulated: the gate pulls `fundingLimit` from the principal,
 * the venue charges `quoteBuy(quantity)` and delivers `quantity`, the adapter
 * refunds the rest. Balances, allowances and consumed replay keys persist.
 */
export class ModelChain implements GateChain {
  time: bigint;
  block = 1_000n;
  codehash = GATE_CODEHASH;
  domainSep = DOMAIN_SEPARATOR;
  readonly balances = new Map<string, bigint>();
  readonly allowances = new Map<string, bigint>();
  readonly consumed = new Map<string, string>();
  readonly txs: ModelTx[] = [];
  submitBehaviour: 'MINE' | 'UNKNOWN' = 'MINE';
  onSubmit: (() => void) | null = null;
  onSimulate: (() => void) | null = null;
  /** The last attempt preflighted: what the signer signed, whether or not it was broadcast. */
  lastSimulated: GateAttempt | null = null;
  readonly gate: ReviewedGate;

  constructor(time: bigint, gate: ReviewedGate = REVIEWED) {
    this.time = time;
    this.gate = gate;
  }

  fund(token: string, owner: string, amount: bigint): void {
    this.balances.set(key(token, owner), (this.balances.get(key(token, owner)) ?? 0n) + amount);
  }

  approve(token: string, owner: string, spender: string, amount: bigint): void {
    this.allowances.set(key(token, `${owner}>${spender}`), amount);
  }

  balanceOf(token: string, owner: string): bigint {
    return this.balances.get(key(token, owner)) ?? 0n;
  }

  allowance(token: string, owner: string, spender: string): bigint {
    return this.allowances.get(key(token, `${owner}>${spender}`)) ?? 0n;
  }

  async latest(): Promise<Read<BlockRef>> {
    return { ok: true, value: { number: this.block, hash: `0x${this.block.toString(16).padStart(64, '0')}`, timestamp: this.time } };
  }

  async gateIdentity(): Promise<Read<{ codehash: string; domainSeparator: string }>> {
    return { ok: true, value: { codehash: this.codehash, domainSeparator: this.domainSep } };
  }

  async funding(token: string, owner: string, spender: string): Promise<Read<{ balance: bigint; allowance: bigint }>> {
    return { ok: true, value: { balance: this.balanceOf(token, owner), allowance: this.allowance(token, owner, spender) } };
  }

  async executionCommitmentOf(mandateDigest: string): Promise<Read<string>> {
    return { ok: true, value: this.consumed.get(mandateDigest) ?? ZERO32 };
  }

  /** The gate's decision and its effects, or the revert data it would return. */
  execute(attempt: GateAttempt, commit: boolean): { ok: true; debit: bigint; credit: bigint } | { ok: false; revert: string } {
    const rej = (r: GateRejection) => ({ ok: false as const, revert: gateRevertData(r) });
    const plan = authorizeExecution(gateDeploymentOf(this.gate), attempt, { chainId: CHAIN, timestamp: this.time, consumed: new Set(this.consumed.keys()) });
    if (!plan.ok) return rej(plan.rejection);
    const p = plan.value;
    const market = this.gate.markets.find((m) => m.representation === p.market.representation) as ReviewedMarket;
    const allowance = this.allowance(p.inputToken, p.principal, this.gate.gate);
    const inputBefore = this.balanceOf(p.inputToken, p.principal);
    const outputBefore = this.balanceOf(p.outputToken, p.recipient);
    // OpenZeppelin ERC20InsufficientAllowance / ERC20InsufficientBalance surface through the gate as reverts.
    if (allowance < p.inputAmount) return { ok: false, revert: 'ERC20InsufficientAllowance' };
    if (inputBefore < p.inputAmount) return { ok: false, revert: 'ERC20InsufficientBalance' };
    const cost = buyCost(market, p.exactQuantity);
    const inputAfter = inputBefore - cost;
    const outputAfter = outputBefore + p.exactQuantity;
    const settled = settleExecution(p, { inputBefore, inputAfter, outputBefore, outputAfter });
    if (!settled.ok) return rej(settled.rejection);
    if (commit) {
      this.consumed.set(p.mandateDigest, p.executionCommitment);
      this.allowances.set(key(p.inputToken, `${p.principal}>${this.gate.gate}`), allowance - p.inputAmount);
      this.balances.set(key(p.inputToken, p.principal), inputAfter);
      this.balances.set(key(p.outputToken, p.recipient), outputAfter);
    }
    return { ok: true, debit: settled.value.actualDebit, credit: settled.value.actualCredit };
  }

  async simulate(call: GateCall): Promise<Simulation> {
    assert.equal(call.calldata, executeCalldata(call.attempt.mandate, call.attempt.principalSignature, call.attempt.candidate, call.attempt.terms, call.attempt.agentSignature), 'calldata encodes the attempt');
    this.lastSimulated = call.attempt;
    this.onSimulate?.();
    const r = this.execute(call.attempt, false);
    return r.ok ? { ok: true, returnData: '0x' } : { ok: false, revert: r.revert };
  }

  /** Mine `call` whatever the preflight said: a reverted transaction is evidence too. */
  mine(call: GateCall): ModelTx {
    this.onSubmit?.();
    this.block += 1n;
    const r = this.execute(call.attempt, true);
    const txHash = bytesToHex(keccak_256(new TextEncoder().encode(`${call.calldata}:${this.txs.length}`)));
    const tx: ModelTx = { txHash, call, result: r.ok ? 'SUCCESS' : 'REVERTED', revert: r.ok ? null : r.revert, block: this.block };
    this.txs.push(tx);
    return tx;
  }

  async submit(call: GateCall): Promise<Submission> {
    if (this.submitBehaviour === 'UNKNOWN') return { kind: 'UNKNOWN', error: 'TimeoutError' };
    return { kind: 'SENT', txHash: this.mine(call).txHash };
  }

  async receipt(txHash: string): Promise<Read<Receipt>> {
    const tx = this.txs.find((t) => t.txHash === txHash);
    if (tx === undefined) return { ok: false, error: 'RECEIPT_TIMEOUT' };
    return { ok: true, value: { status: tx.result, blockNumber: tx.block, blockHash: ZERO32, gasUsed: 250_000n, effectiveGasPrice: 1n, contractAddress: null, logs: tx.result === 'SUCCESS' ? 3 : 0 } };
  }
}

export { reject };

// --- The issuance world --------------------------------------------------------------------------

export interface GateWorld {
  readonly policy: GateSpotPolicy;
  readonly engine: ControlEngine;
  readonly store: SqliteLedgerStore;
  readonly journal: IssuanceJournal;
  readonly lifecycle: LifecycleTable;
  readonly chain: ModelChain;
  readonly signer: GateSigner;
  readonly deps: GateSignerDeps;
  readonly grant: AuthorityGrant;
  readonly path: string;
  close(): void;
}

export interface GateWorldOptions {
  /** Capital authority, in MDUSD atoms. Default 500 MDUSD. */
  readonly capital?: bigint;
  readonly extraTerms?: readonly AuthorityTermInput[];
  readonly principalTerms?: readonly PrincipalPolicyTermInput[];
  readonly extraModules?: readonly DomainModule[];
  readonly extraAdapters?: readonly AdapterRefInput[];
  /** Allowance the principal granted the gate. Default: the capital authority. */
  readonly allowance?: bigint;
  readonly adapterStatus?: 'ACTIVE' | 'RETIRING' | 'DISABLED';
  readonly skipSetup?: boolean;
  readonly grantOf?: (policy: GateSpotPolicy) => AuthorityGrant;
}

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-evm-robinhood-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function gateWorld(o: GateWorldOptions = {}): Promise<GateWorld> {
  const tmp = tempDir();
  const path = join(tmp.dir, 'ledger.db');
  const policy = createGateSpotPolicy(policyConfig());
  const modules: DomainModule[] = [policy, ...(o.extraModules ?? [])];
  const lifecycle = openLifecycle(path);
  for (const m of modules) lifecycle.table.setModule({ module: m.ref, status: 'ACTIVE', implementations: [m.implementation] });
  const adapterRef = gateAdapterRef(ADAPTER_CONFIG);
  lifecycle.table.setAdapter({ adapter: adapterRef, status: o.adapterStatus ?? 'ACTIVE' });
  for (const a of o.extraAdapters ?? []) lifecycle.table.setAdapter({ adapter: must(validateAdapterRef(a)), status: 'ACTIVE' });
  const registry = new DurableModuleRegistry(lifecycle.table);
  const adapters = new DurableAdapterRegistry(lifecycle.table);
  const catalog = must(ModuleCatalog.create(registry, modules.map((module) => ({ module, corpus: [] }))));
  const store = SqliteLedgerStore.open({ path, rules: controlRules(catalog) });
  const engine = new ControlEngine({ store, registry, catalog, adapters });
  const capital = o.capital ?? mdusd(500n);
  const grant = o.grantOf?.(policy) ?? rootGrant(policy, [capitalDim('MDUSD', capital), ...(o.extraTerms ?? [])]);
  if (o.skipSetup !== true) {
    const r = await engine.registerPolicy(principalPolicy(o.principalTerms ?? []), T0, ONCE);
    if (r.status !== 'REGISTERED') assert.fail(`policy: ${r.refusal.code}/${r.refusal.reason}`);
    const g = await engine.registerDelegation(grant, T0, ONCE);
    if (g.status !== 'REGISTERED') assert.fail(`grant: ${g.refusal.code}/${g.refusal.reason} at ${g.refusal.path}`);
  }
  const journal = new IssuanceJournal(store);
  const chain = new ModelChain(T + 5n);
  chain.fund(MDUSD, PRINCIPAL, mdusd(1_000n));
  chain.approve(MDUSD, PRINCIPAL, GATE, o.allowance ?? capital);
  const custody = new LocalGateCustody(
    PRINCIPAL_KEY,
    {
      ledger: () => store.readCommitted(PRINCIPAL_ID).state,
      issued: (attempt) => journal.get(attempt) !== null,
      lifecycle: (kind, name, version) => {
        const row = lifecycle.table.read(kind, name, version);
        if (row === null) return null;
        const ref = JSON.parse(row.ref) as { moduleDigest?: string; adapterDigest?: string };
        return { status: row.status, digest: ref.moduleDigest ?? ref.adapterDigest ?? '' };
      },
      now: () => chain.time,
    },
    { module: policy.ref, adapter: adapterRef },
  );
  const deps: GateSignerDeps = {
    engine,
    store,
    journal,
    custody,
    agent: new LocalAgentSigner(AGENT_KEY),
    chain,
    config: { gate: REVIEWED, gateCodehash: GATE_CODEHASH, domainSeparator: DOMAIN_SEPARATOR, principal: PRINCIPAL_ID, principalAddress: PRINCIPAL, agentAddress: AGENT, adapter: adapterRef, policy: policy.ref, deadlineSeconds: 120n, retry: RETRY },
  };
  return {
    policy,
    engine,
    store,
    journal,
    lifecycle: lifecycle.table,
    chain,
    signer: new GateSigner(deps),
    deps,
    grant,
    path,
    close: () => {
      store.close();
      lifecycle.close();
      tmp.cleanup();
    },
  };
}


/** Authorize a BUY of `quantity` MDEMO atoms at `at`, and the issuance request for 5 s later. */
export async function authorizeBuy(w: GateWorld, quantity: bigint, o: { nonce?: bigint; at?: bigint } = {}) {
  const at = o.at ?? T;
  const a = buy(w.policy, w.grant, quantity, { nonce: o.nonce ?? 0n });
  const out = await w.engine.authorizeAndReserve(request(w.policy, a, at), ONCE);
  const rec = authorized(out);
  w.chain.time = at + 5n;
  return { rec, a, issue: { payload: a.payload, states: marketStates(w.policy, at + 5n), context: context(at + 5n) } };
}

export async function withWorld(f: (w: GateWorld) => Promise<void>, o: GateWorldOptions = {}): Promise<void> {
  const w = await gateWorld(o);
  try {
    await f(w);
  } finally {
    w.close();
  }
}
