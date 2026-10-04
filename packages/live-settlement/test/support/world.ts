/**
 * A deterministic settlement world: a scripted Live AI session, a manifest
 * shaped like the real one but naming the evm-robinhood test fixture gate
 * and published test keys, and a `TestnetRpc` over the Phase 6 reference
 * model (`ModelChain`, which the frozen differential corpus proves equal in
 * its decisions to the Solidity gate). No network, no live key.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from '@mandate/kernel';
import { gateMarketState, keyAddress, reviewedSnapshot, type Address, type BlockRef, type GateCall, type GateMarketSnapshot, type GateSpotPolicy, type GateStateRead, type Read, type Receipt, type Simulation } from '@mandate/evm-robinhood';
import { LiveSession, presetDraft, type AgentModelProvider, type EligibilityFilter, type LiveEvent, type LiveEventKind, type SettlementProfile } from '@mandate/live-agents';
import { AGENT, AGENT_KEY, DOMAIN_SEPARATOR, GATE, GATE_CODEHASH, MARKET, MDEMO, MDUSD, ModelChain, PRINCIPAL, PRINCIPAL_KEY, SUBMITTER_KEY, T, type ModelTx } from '../../../evm-robinhood/test/support/world.ts';
import { ScriptedProvider, json } from '../../../live-agents/test/support/providers.ts';
import { TestTime } from '../../../live-agents/test/support/world.ts';
import { parseDeployment, type TestnetDeployment } from '../../src/deployment.ts';
import type { Transport } from '../../src/evidence.ts';
import type { BroadcastResult, PreparedTx, RpcProvenance, TestnetRpc, TxLookup } from '../../src/rpc.ts';
import { SettlementJournal } from '../../src/journal.ts';
import { LiveSettlement, type Prepared, type RunOptions, type SettlementEnv, type SettlementOutcome } from '../../src/settlement.ts';

/** The settlement with a durable journal in the world's directory unless a run names its own. */
export class JournaledSettlement extends LiveSettlement {
  readonly journal: SettlementJournal;
  constructor(env: SettlementEnv, journal: SettlementJournal) {
    super(env);
    this.journal = journal;
  }
  override run(p: Prepared, o: RunOptions): Promise<SettlementOutcome> {
    return super.run(p, { journal: this.journal, ...o });
  }
}

export { AGENT, AGENT_KEY, GATE, MARKET, MDEMO, MDUSD, PRINCIPAL, PRINCIPAL_KEY, SUBMITTER_KEY };
export const SUBMITTER = keyAddress(SUBMITTER_KEY);
export const KEYS = { principal: PRINCIPAL_KEY, agent: AGENT_KEY } as const;
/** Every private key in the world: none may ever appear in an event. */
export const ALL_TEST_KEYS = [PRINCIPAL_KEY, AGENT_KEY, SUBMITTER_KEY].map((k) => k.replace(/^0x/, '').toLowerCase());

const hashOf = (label: string): string => keccak256(new TextEncoder().encode(label));
export const CODE_HASHES = { gate: GATE_CODEHASH, venue: hashOf('venue'), adapter: hashOf('adapter'), mdemo: hashOf('mdemo'), mdusd: hashOf('mdusd') } as const;

/** The real manifest's shape, naming the test fixture gate and test parties. */
export function testManifest(o: { chainId?: number } = {}): object {
  const c = (address: string, runtimeCodeHash: string, extra: object = {}) => ({ address, runtimeCodeHash, ...extra });
  return {
    label: 'TEST',
    network: { name: 'Robinhood Chain Testnet', chainId: o.chainId ?? 46630, explorer: 'https://explorer.testnet.chain.robinhood.com' },
    deployer: SUBMITTER,
    principal: PRINCIPAL,
    agent: AGENT,
    contracts: {
      mandateExecutionGate: c(GATE, CODE_HASHES.gate, { domainSeparator: DOMAIN_SEPARATOR }),
      fixtureVenue: c(MARKET.venue, CODE_HASHES.venue),
      fixtureVenueAdapter: c(MARKET.adapter, CODE_HASHES.adapter),
      mdemo: c(MDEMO, CODE_HASHES.mdemo, { name: 'Mandate Demo Asset (TESTNET FIXTURE)', symbol: 'MDEMO', decimals: 18 }),
      mdusd: c(MDUSD, CODE_HASHES.mdusd, { name: 'Mandate Demo Dollar (TESTNET FIXTURE)', symbol: 'MDUSD', decimals: 6 }),
    },
    market: {
      representation: MDEMO,
      fundingToken: MDUSD,
      canonicalAsset: { assetClass: 'fixture', idScheme: 'mandate-demo', value: 'MDEMO' },
      issuer: 'issuer.mandate-demo',
      venue: 'venue.mandate-fixture',
      quantityUnit: 'TOKEN',
      settlementUnit: 'MDUSD',
      synthetic: false,
      fixturePriceDecimals: 6,
      fixturePrice: '10000000',
      fixtureFeeBps: 0,
    },
  };
}

export function testDeployment(): TestnetDeployment {
  const d = parseDeployment(testManifest());
  if (!d.ok) throw new Error(d.error);
  return d.value;
}

export type BroadcastBehaviour = 'MINE' | 'ERROR_NOT_SENT' | 'ERROR_BUT_MINED' | 'RPC_REJECTED';

/** A `TestnetRpc` over the reference model, with every failure a test needs. Counts everything that could leave a process. */
export class ModelRpc implements TestnetRpc {
  transport: Transport = 'REFERENCE_MODEL';
  readonly submitter = SUBMITTER;
  readonly chain: ModelChain;
  chainIdValue: bigint | null = 46_630n;
  codehashes = new Map<string, string>([
    [GATE, CODE_HASHES.gate],
    [MARKET.venue, CODE_HASHES.venue],
    [MARKET.adapter, CODE_HASHES.adapter],
    [MDEMO, CODE_HASHES.mdemo],
    [MDUSD, CODE_HASHES.mdusd],
  ]);
  submitterWei = 10n ** 18n;
  simulateRevert: string | null = null;
  estimateError: string | null = null;
  broadcastBehaviour: BroadcastBehaviour = 'MINE';
  prepareError: string | null = null;
  /** Runs just before a broadcast mines: lets a test change the chain between simulation and inclusion. */
  beforeMine: (() => void) | null = null;
  /** When true, receipts are never found: a hash without a receipt. */
  withholdReceipts = false;
  readonly executeTargets: string[] = [];
  simulations = 0;
  estimates = 0;
  prepared = 0;
  broadcasts = 0;
  readonly #mined = new Map<string, ModelTx>();
  /** Mirror RobinhoodTestnetRpc.boundGate; tests may rebind for V3. */
  boundGate: Address = GATE;

  constructor() {
    this.chain = new ModelChain(T + 5n);
    this.chain.fund(MDUSD, PRINCIPAL, 700_000_000n);
    this.chain.approve(MDUSD, PRINCIPAL, GATE, 200_000_000n);
    this.chain.fund(MDEMO, MARKET.venue, 970n * 10n ** 18n);
  }

  async chainId(): Promise<Read<bigint>> {
    return this.chainIdValue === null ? { ok: false, error: 'NETWORK.TimeoutError' } : { ok: true, value: this.chainIdValue };
  }
  latest(): Promise<Read<BlockRef>> {
    return this.chain.latest();
  }
  async codehash(address: Address): Promise<Read<string>> {
    const h = this.codehashes.get(address);
    return h === undefined ? { ok: false, error: 'NO_CODE' } : { ok: true, value: h };
  }
  async domainSeparator(): Promise<Read<string>> {
    return { ok: true, value: this.chain.domainSep };
  }
  async nativeBalance(address: Address): Promise<Read<bigint>> {
    return { ok: true, value: address === SUBMITTER ? this.submitterWei : 0n };
  }
  async tokenBalance(token: Address, owner: Address): Promise<Read<bigint>> {
    return { ok: true, value: this.chain.balanceOf(token, owner) };
  }
  async allowance(token: Address, owner: Address, spender: Address): Promise<Read<bigint>> {
    return { ok: true, value: this.chain.allowance(token, owner, spender) };
  }
  async gateMarket(gate: Address, representation: Address): Promise<Read<GateMarketSnapshot>> {
    if (gate.toLowerCase() !== this.boundGate.toLowerCase()) return { ok: false, error: 'TARGET_NOT_THE_GATE' };
    if (representation !== MDEMO) return { ok: false, error: 'MARKET_NOT_LISTED' };
    return { ok: true, value: reviewedSnapshot(46_630n, gate, MARKET) };
  }
  executionCommitmentOf(_gate: Address, mandateDigest: string): Promise<Read<string>> {
    return this.chain.executionCommitmentOf(mandateDigest);
  }
  async gateMarkets(policy: GateSpotPolicy): Promise<GateStateRead> {
    const b = await this.chain.latest();
    if (!b.ok) return { status: 'UNKNOWN', reason: b.error };
    const snapshot = reviewedSnapshot(46_630n, GATE, MARKET);
    return { status: 'OK', block: b.value, snapshots: [snapshot], states: [gateMarketState(policy, snapshot, b.value.timestamp)] };
  }
  /**
   * When set, `simulateExecute`/`broadcast` skip the V2 ModelChain for that
   * gate address (V3 delegated calldata is not executable on the V2 model).
   */
  v3PassthroughGate: string | null = null;

  async simulateExecute(gate: Address, call: GateCall): Promise<Simulation> {
    this.executeTargets.push(gate);
    this.simulations += 1;
    if (gate.toLowerCase() !== this.boundGate.toLowerCase()) return { ok: false, revert: 'TARGET_NOT_THE_GATE' };
    if (this.simulateRevert !== null) return { ok: false, revert: this.simulateRevert };
    if (this.v3PassthroughGate !== null && gate.toLowerCase() === this.v3PassthroughGate.toLowerCase()) {
      return { ok: true, returnData: '0x' };
    }
    return this.chain.simulate(call);
  }
  async estimateExecute(gate: Address): Promise<Read<bigint>> {
    this.executeTargets.push(gate);
    this.estimates += 1;
    if (gate.toLowerCase() !== this.boundGate.toLowerCase()) return { ok: false, error: 'TARGET_NOT_THE_GATE' };
    return this.estimateError === null ? { ok: true, value: 240_000n } : { ok: false, error: this.estimateError };
  }
  async prepareExecute(gate: Address, call: GateCall, gasLimit: bigint): Promise<Read<PreparedTx>> {
    this.executeTargets.push(gate);
    if (gate.toLowerCase() !== this.boundGate.toLowerCase()) return { ok: false, error: 'TARGET_NOT_THE_GATE' };
    if (this.prepareError !== null) return { ok: false, error: this.prepareError };
    this.prepared += 1;
    const hash = hashOf(`${call.calldata}:${this.prepared}`);
    return { ok: true, value: { hash, raw: '0x02', call, from: SUBMITTER, to: gate, nonce: BigInt(this.prepared), gasLimit, maxFeePerGas: 20_000_001n } };
  }
  async broadcast(tx: PreparedTx): Promise<BroadcastResult> {
    this.broadcasts += 1;
    this.beforeMine?.();
    if (tx.to.toLowerCase() !== this.boundGate.toLowerCase()) return { kind: 'ERROR', error: 'NOT_A_PREPARED_GATE_EXECUTE' };
    const v3 = this.v3PassthroughGate !== null && tx.to.toLowerCase() === this.v3PassthroughGate.toLowerCase();
    switch (this.broadcastBehaviour) {
      case 'ERROR_NOT_SENT':
        return { kind: 'ERROR', error: 'NETWORK.TimeoutError' };
      case 'RPC_REJECTED':
        return { kind: 'ERROR', error: 'RPC_-32000:nonce too low' };
      case 'ERROR_BUT_MINED': {
        const mined = v3
          ? { txHash: tx.hash, call: tx.call, result: 'SUCCESS' as const, revert: null, block: (this.chain.block += 1n) }
          : this.chain.mine(tx.call);
        this.#mined.set(tx.hash, mined);
        return { kind: 'ERROR', error: 'NETWORK.TimeoutError' };
      }
      default:
        if (v3) {
          this.chain.block += 1n;
          this.#mined.set(tx.hash, { txHash: tx.hash, call: tx.call, result: 'SUCCESS', revert: null, block: this.chain.block });
        } else {
          this.#mined.set(tx.hash, this.chain.mine(tx.call));
        }
        return { kind: 'ACCEPTED', hash: tx.hash };
    }
  }
  async transactionKnown(hash: string): Promise<Read<boolean>> {
    return { ok: true, value: this.#mined.has(hash) };
  }
  provenance(): RpcProvenance {
    return 'mock';
  }
  async transaction(hash: string): Promise<Read<TxLookup | null>> {
    const tx = this.#mined.get(hash);
    return { ok: true, value: tx === undefined ? null : { blockNumber: tx.block, from: SUBMITTER, nonce: 0n } };
  }
  async receiptOnce(hash: string): Promise<Read<Receipt | null>> {
    if (!this.#mined.has(hash) || this.withholdReceipts) return { ok: true, value: null };
    return this.receipt(hash);
  }
  async nonceAt(): Promise<Read<bigint>> {
    return { ok: true, value: BigInt(this.#mined.size) };
  }
  async receipt(hash: string): Promise<Read<Receipt>> {
    const tx = this.#mined.get(hash);
    if (tx === undefined || this.withholdReceipts) return { ok: false, error: 'RECEIPT_TIMEOUT' };
    return { ok: true, value: { status: tx.result, blockNumber: tx.block, blockHash: `0x${tx.block.toString(16).padStart(64, '0')}`, gasUsed: 250_000n, effectiveGasPrice: 20_000_000n, contractAddress: null, logs: tx.result === 'SUCCESS' ? 3 : 0 } };
  }
}

export const USDC = (whole: number): string => (BigInt(whole) * 1_000_000n).toString();
export const propose = (candidateId: string, whole: number): string => json({ action: 'PROPOSE', candidateId, requestedAtoms: USDC(whole), rationale: `pick ${candidateId}` });
export const abstain = json({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, rationale: 'nothing acceptable' });

/** A provider that answers as scripted and reports `kind` — `LIVE` only to exercise the evidence rule. */
const KEEP = json({ action: 'KEEP', newRequestedAtoms: null, rationale: 'keep' });

function provider(decide: (role: string) => string, kind: 'SCRIPTED' | 'LIVE', negotiate: (role: string) => string = () => KEEP): AgentModelProvider {
  const inner = new ScriptedProvider({ decide: (r) => ({ text: decide(r.role) }), negotiate: (r) => ({ text: negotiate(r.role) }) });
  return kind === 'SCRIPTED' ? inner : { name: 'scripted-as-live', model: 'scripted-v1', kind: 'LIVE', decide: (r, o) => inner.decide(r, o), negotiate: (r, o) => inner.negotiate(r, o), interpretMandateDraft: (r, o) => inner.interpretMandateDraft(r, o), selectPolicyCase: (r, o) => inner.selectPolicyCase(r, o), assessOpportunity: (r, o) => inner.assessOpportunity(r, o) };
}

export interface SettlementWorld {
  readonly session: LiveSession;
  readonly time: TestTime;
  readonly rpc: ModelRpc;
  readonly deployment: TestnetDeployment;
  readonly settlement: JournaledSettlement;
  readonly journal: SettlementJournal;
  readonly ledgerPath: () => string;
  readonly kinds: () => readonly LiveEventKind[];
  readonly of: (kind: LiveEventKind) => readonly LiveEvent[];
  close(): void;
}

/**
 * A session whose Stock agent proposes `stock` (default: nvda-note-a at 400
 * USDC) and every other agent answers `others[role]` (default: abstains),
 * already run. In a Room, each agent answers `negotiate(role)` (default: KEEP).
 */
export async function settlementWorld(o: { stock?: string; others?: { readonly [role: string]: string }; kind?: 'SCRIPTED' | 'LIVE'; run?: boolean; eligibility?: EligibilityFilter; settlement?: SettlementProfile | null; negotiate?: (role: string) => string } = {}): Promise<SettlementWorld> {
  const time = new TestTime();
  const decide = (role: string) => (role === 'stock' ? (o.stock ?? propose('nvda-note-a', 400)) : (o.others?.[role] ?? abstain));
  const session = new LiveSession({ provider: provider(decide, o.kind ?? 'SCRIPTED', o.negotiate), sessionId: 'settlement-test', agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000, protocolNow: time.read, ...(o.eligibility === undefined ? {} : { eligibility: o.eligibility }), ...(o.settlement === undefined ? {} : { settlement: o.settlement }) });
  const auth = await session.authorize(presetDraft('balanced'), 'AUTHORIZE MANDATE V1');
  if (!auth.ok) throw new Error(`mandate refused: ${auth.code}`);
  if (o.run !== false) await session.run();
  const rpc = new ModelRpc();
  const deployment = testDeployment();
  const dir = mkdtempSync(join(tmpdir(), 'mandate-live-settlement-'));
  const journal = SettlementJournal.open(join(dir, 'settlement.db'));
  let n = 0;
  return {
    session,
    time,
    rpc,
    deployment,
    journal,
    settlement: new JournaledSettlement({ session, deployment, rpc, keys: KEYS }, journal),
    ledgerPath: () => join(dir, `ledger-${(n += 1)}.db`),
    kinds: () => session.events.events.map((e) => e.kind),
    of: (kind) => session.events.events.filter((e) => e.kind === kind),
    close: () => {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
