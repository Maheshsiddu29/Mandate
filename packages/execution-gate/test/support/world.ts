/**
 * The differential world: one fixed deployment both implementations replay.
 *
 * Every address here is where `contracts/test/Differential.t.sol` deploys the
 * corresponding contract, so the gate's EIP-712 domain, the representation
 * identifiers and therefore every digest and signature are the same on both
 * sides. The tokens are labelled fixtures. Each market's adapter is the one the
 * gate's constructor creates (Phase 6R.1a), at the gate's own CREATE address;
 * the harness then etches the `ScriptedAdapter` test double over it — this world
 * exercises the gate's decision, not a venue.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, eip712SigningHash, hexToBytes, keccak256, type Bytes32 } from '@mandate/kernel';
import { addressOf, signHash, TEST_PRIVATE_KEY, TEST_PRIVATE_KEY_2 } from '../../../kernel/test/support/signing.ts';
import {
  caip2,
  eip712Hash,
  encodeGateCandidate,
  encodeGateMandate,
  executionCommitment,
  gateDomain,
  representationIdFor,
  authorizeExecution,
  settleExecution,
  encodeRevert,
  gateRevertData,
  type ExecutionPlan,
  type GateAttempt,
  type GateCandidate,
  type GateDeployment,
  type GateMandate,
  type GateMarket,
  type GateTerms,
} from '../../src/index.ts';

export const CHAIN_ID = 46630n;
export const T0 = 1_800_000_000n;

export const PRINCIPAL_KEY = TEST_PRIVATE_KEY;
export const AGENT_KEY = TEST_PRIVATE_KEY_2;
/** A third fixed, published test key. Secures nothing. */
export const STRANGER_KEY = '0x' + '0'.repeat(59) + 'a11ce';

export const PRINCIPAL = addressOf(PRINCIPAL_KEY);
export const AGENT = addressOf(AGENT_KEY);
export const STRANGER = addressOf(STRANGER_KEY);
/** Where a misbehaving adapter sends output it should have sent to the principal. */
export const SINK = '0x000000000000000000000000000000000000dead';

/**
 * The address a contract at `sender` creates with its `nonce`-th CREATE:
 * `keccak256(rlp([sender, nonce]))[12:]`, for the small nonces a constructor uses.
 */
export function createAddress(sender: string, nonce: number): string {
  if (!Number.isInteger(nonce) || nonce < 1 || nonce > 0x7f) throw new Error(`unsupported nonce ${nonce}`);
  const addr = hexToBytes(sender);
  if (addr === undefined || addr.length !== 20) throw new Error(`not an address: ${sender}`);
  const rlp = new Uint8Array([0xd6, 0x94, ...addr, nonce]);
  return `0x${bytesToHex(keccak_256(rlp)).slice(26)}`;
}

const GATE_ADDRESS = '0x000000000000000000000000000000000000a7e0';

/**
 * The adapter the gate creates for its `index`-th market. Each market's
 * constructor step creates the venue, then the adapter; a newly created
 * contract's nonce starts at 1 (EIP-161), so market i's adapter is CREATE 2i+2.
 */
export function marketAdapter(index: number): string {
  return createAddress(GATE_ADDRESS, 2 * index + 2);
}

export const ADDR = {
  gate: GATE_ADDRESS,
  funding6: '0x000000000000000000000000000000000000f006',
  funding18: '0x000000000000000000000000000000000000f018',
  aapl: '0x000000000000000000000000000000000000aa01',
  nvda: '0x000000000000000000000000000000000000aa02',
  synth: '0x000000000000000000000000000000000000aa03',
  eightDecimal: '0x000000000000000000000000000000000000aa08',
  /** Never deployed as a market: an unsupported representation. */
  unlisted: '0x000000000000000000000000000000000000bad0',
} as const;

export const AAPL = { assetClass: 'equity', idScheme: 'isin', value: 'US0378331005' } as const;
export const NVDA = { assetClass: 'equity', idScheme: 'isin', value: 'US67066G1040' } as const;

/** Token deployment facts, in the order the Solidity harness deploys them. */
export const TOKENS = [
  { address: ADDR.funding6, name: 'Fixture USD Coin', symbol: 'fUSDC', decimals: 6 },
  { address: ADDR.funding18, name: 'Fixture USD 18', symbol: 'fUSD18', decimals: 18 },
  { address: ADDR.aapl, name: 'Fixture Apple Stock Token', symbol: 'fAAPL', decimals: 18 },
  { address: ADDR.nvda, name: 'Fixture NVIDIA Stock Token', symbol: 'fNVDA', decimals: 18 },
  { address: ADDR.synth, name: 'Fixture Synthetic Apple', symbol: 'sAAPL', decimals: 18 },
  { address: ADDR.eightDecimal, name: 'Fixture Apple 8dp', symbol: 'fAAPL8', decimals: 8 },
] as const;

function market(index: number, representation: string, fundingToken: string, representationDecimals: number, fundingDecimals: number, overrides: Partial<GateMarket> = {}): GateMarket {
  return {
    representation,
    fundingToken,
    adapter: marketAdapter(index),
    representationDecimals,
    fundingDecimals,
    canonicalAsset: AAPL,
    issuer: 'issuer.alpha',
    venue: 'venue.fixture',
    quantityUnit: 'TOKEN',
    settlementUnit: 'USD',
    synthetic: false,
    classification: 'FIXTURE',
    fixturePrice: { numeratorUnit: 'USD', denominatorUnit: 'TOKEN', decimals: 18, atoms: 200n * 10n ** 18n },
    ...overrides,
  };
}

export const DEPLOYMENT: GateDeployment = {
  chainId: CHAIN_ID,
  gate: ADDR.gate,
  markets: [
    market(0, ADDR.aapl, ADDR.funding6, 18, 6),
    market(1, ADDR.nvda, ADDR.funding6, 18, 6, {
      canonicalAsset: NVDA,
      fixturePrice: { numeratorUnit: 'USD', denominatorUnit: 'TOKEN', decimals: 18, atoms: 100n * 10n ** 18n },
    }),
    market(2, ADDR.synth, ADDR.funding6, 18, 6, { issuer: 'issuer.synthetic', synthetic: true }),
    market(3, ADDR.eightDecimal, ADDR.funding18, 8, 18, { venue: 'venue.other' }),
  ],
};

export const DOMAIN = gateDomain(CHAIN_ID, ADDR.gate);

// --- Attempt construction ----------------------------------------------------

const usd = (atoms: bigint, decimals = 18) => ({ unit: 'USD', decimals, atoms });

/** BUY 10 fAAPL for at most 2010.00 USD, live T0-60 .. T0+3600. */
export function baseMandate(): GateMandate {
  return {
    version: 2n,
    mandateId: '0x' + '11'.repeat(32),
    nonce: 1n,
    principal: PRINCIPAL,
    agent: AGENT,
    canonicalAsset: AAPL,
    side: 1n,
    maxNotional: usd(2_000n * 10n ** 18n),
    economicLimit: usd(2_010n * 10n ** 18n),
    maxDeviationBps: 40n,
    syntheticPolicy: 1n,
    allowedIssuers: ['issuer.alpha'],
    allowedChains: [caip2(CHAIN_ID)],
    allowedVenues: ['venue.other', 'venue.fixture'],
    requiredCorporateActionEpoch: 1n,
    maxPriceAgeSeconds: 60n,
    maxCorporateActionAgeSeconds: 3_600n,
    haltPolicy: 1n,
    createdAtUnixSeconds: T0 - 100n,
    notBeforeUnixSeconds: T0 - 60n,
    expiresAtUnixSeconds: T0 + 3_600n,
  };
}

export function baseCandidate(token: string = ADDR.aapl, side: bigint = 1n): GateCandidate {
  return {
    version: 3n,
    representationId: representationIdFor(CHAIN_ID, token),
    canonicalAsset: AAPL,
    issuer: 'issuer.alpha',
    chain: caip2(CHAIN_ID),
    venue: 'venue.fixture',
    side,
    agent: AGENT,
    quantity: { unit: 'TOKEN', decimals: 18, atoms: 10n * 10n ** 18n },
    executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'TOKEN', decimals: 18, atoms: 200n * 10n ** 18n },
    notional: usd(2_000n * 10n ** 18n),
    feeTotal: usd(6n * 10n ** 18n),
    evaluationStateId: 'state.fixture.0001',
    evaluationStateDigest: '0x' + 'e1'.repeat(32),
    registrySnapshotDigest: '0x' + 'a5'.repeat(32),
    corporateActionEpoch: 1n,
  };
}

export function baseTerms(): GateTerms {
  return { recipient: PRINCIPAL, fundingLimit: 2_010n * 10n ** 6n, deadline: T0 + 300n, executionData: '0x' };
}

export interface Unsigned {
  readonly mandate: GateMandate;
  readonly candidate: GateCandidate;
  readonly terms: GateTerms;
}

export function baseBuy(): Unsigned {
  return { mandate: baseMandate(), candidate: baseCandidate(), terms: baseTerms() };
}

export function baseSell(): Unsigned {
  return {
    mandate: { ...baseMandate(), side: 2n, economicLimit: usd(1_990n * 10n ** 18n) },
    candidate: baseCandidate(ADDR.aapl, 2n),
    terms: { ...baseTerms(), fundingLimit: 1_990n * 10n ** 6n },
  };
}

export function mandateDigestOf(m: GateMandate): string {
  return keccak256(encodeGateMandate(m));
}

/** What the principal signs: the kernel's own `MandateAuthorization` hash, under the gate's domain. */
export function principalHash(m: GateMandate, domain = DOMAIN): Uint8Array {
  return eip712SigningHash(domain, mandateDigestOf(m) as Bytes32);
}

/** What the agent signs: the execution commitment under the gate's domain. */
export function agentHash(u: Unsigned, domain = DOMAIN): Uint8Array {
  const commitment = executionCommitment({
    mandateDigest: mandateDigestOf(u.mandate) as Bytes32,
    candidateDigest: keccak256(encodeGateCandidate(u.candidate)),
    terms: u.terms,
  });
  return eip712Hash(domain, commitment);
}

export interface SignOptions {
  readonly principalKey?: string;
  readonly agentKey?: string;
  readonly principalDomain?: typeof DOMAIN;
  readonly agentDomain?: typeof DOMAIN;
}

/** Sign honestly (or with the overrides) and produce a complete attempt. */
export function sign(u: Unsigned, options: SignOptions = {}): GateAttempt {
  return {
    ...u,
    principalSignature: signHash(principalHash(u.mandate, options.principalDomain), options.principalKey ?? PRINCIPAL_KEY),
    agentSignature: signHash(agentHash(u, options.agentDomain), options.agentKey ?? AGENT_KEY),
  };
}

// --- Simulation --------------------------------------------------------------

export const ScriptMode = { SCRIPTED: 0, REVERT: 1, RETURN_GARBAGE: 2, PULL_FROM_PRINCIPAL: 5 } as const;

export interface Script {
  readonly mode: number;
  readonly deliver: bigint;
  readonly refund: bigint;
  readonly deliverElsewhere: boolean;
  readonly extraPull: bigint;
}

export const MAX_UINT = 2n ** 256n - 1n;
export const ADAPTER_INVENTORY = 10n ** 40n;

export interface TokenSetup {
  readonly token: string;
  readonly principalBalance: bigint;
  readonly gateAllowance: bigint;
  readonly adapterAllowance: bigint;
  readonly decimals: number;
}

export function defaultSetup(): TokenSetup[] {
  return TOKENS.map((t) => ({
    token: t.address,
    principalBalance: 1_000_000n * 10n ** BigInt(t.decimals),
    gateAllowance: MAX_UINT,
    adapterAllowance: 0n,
    decimals: t.decimals,
  }));
}

export interface ChainMoment {
  readonly chainId: bigint;
  readonly timestamp: bigint;
}

export interface Expected {
  readonly settled: boolean;
  readonly revertData: string;
  readonly mandateDigest: string;
  readonly candidateDigest: string;
  readonly executionCommitment: string;
  readonly debit: bigint;
  readonly credit: bigint;
}

const ZERO32 = '0x' + '00'.repeat(32);

class Ledger {
  readonly balances = new Map<string, bigint>();
  readonly allowances = new Map<string, bigint>();

  constructor(setup: readonly TokenSetup[]) {
    for (const s of setup) {
      this.balances.set(`${s.token}:${PRINCIPAL}`, s.principalBalance);
      this.allowances.set(`${s.token}:${PRINCIPAL}:${ADDR.gate}`, s.gateAllowance);
      // Every market's adapter holds inventory of every token and receives the same allowance.
      for (const m of DEPLOYMENT.markets) {
        this.balances.set(`${s.token}:${m.adapter}`, ADAPTER_INVENTORY);
        this.allowances.set(`${s.token}:${PRINCIPAL}:${m.adapter}`, s.adapterAllowance);
      }
    }
  }

  balance(token: string, holder: string): bigint {
    return this.balances.get(`${token}:${holder}`) ?? 0n;
  }

  /** OpenZeppelin ERC20 `transfer` failure semantics, as revert data or undefined on success. */
  transfer(token: string, from: string, to: string, value: bigint): string | undefined {
    const balance = this.balance(token, from);
    if (balance < value) return encodeRevert('ERC20InsufficientBalance(address,uint256,uint256)', [BigInt(from), balance, value]);
    this.balances.set(`${token}:${from}`, balance - value);
    this.balances.set(`${token}:${to}`, this.balance(token, to) + value);
    return undefined;
  }

  /** OpenZeppelin ERC20 `transferFrom`: allowance first, then balance. */
  transferFrom(token: string, spender: string, from: string, to: string, value: bigint): string | undefined {
    const key = `${token}:${from}:${spender}`;
    const allowance = this.allowances.get(key) ?? 0n;
    if (allowance !== MAX_UINT) {
      if (allowance < value) return encodeRevert('ERC20InsufficientAllowance(address,uint256,uint256)', [BigInt(spender), allowance, value]);
    }
    const balance = this.balance(token, from);
    if (balance < value) return encodeRevert('ERC20InsufficientBalance(address,uint256,uint256)', [BigInt(from), balance, value]);
    if (allowance !== MAX_UINT) this.allowances.set(key, allowance - value);
    return this.transfer(token, from, to, value);
  }

  snapshot(): Ledger {
    const copy = Object.create(Ledger.prototype) as Ledger;
    (copy as { balances: Map<string, bigint> }).balances = new Map(this.balances);
    (copy as { allowances: Map<string, bigint> }).allowances = new Map(this.allowances);
    return copy;
  }
}

export interface SimAttempt {
  readonly moment: ChainMoment;
  readonly attempt: GateAttempt;
  readonly script: Script;
}

/**
 * Replay a sequence of attempts against the model and a ledger of the fixture
 * tokens, carrying consumption and balances forward exactly as a chain would —
 * including unwinding everything an attempt did when it reverts.
 */
export function simulate(setup: readonly TokenSetup[], attempts: readonly SimAttempt[]): Expected[] {
  let ledger = new Ledger(setup);
  const consumed = new Set<string>();
  const decimals = new Map(setup.map((s) => [s.token, s.decimals] as const));
  return attempts.map(({ moment, attempt, script }) => {
    const decision = authorizeExecution(DEPLOYMENT, attempt, { ...moment, consumed, tokenDecimals: decimals });
    const reverted = (revertData: string): Expected => ({
      settled: false,
      revertData,
      mandateDigest: ZERO32,
      candidateDigest: ZERO32,
      executionCommitment: ZERO32,
      debit: 0n,
      credit: 0n,
    });
    if (!decision.ok) return reverted(gateRevertData(decision.rejection));

    const working = ledger.snapshot();
    const outcome = interact(working, decision.value, script);
    if (typeof outcome === 'string') return reverted(outcome);
    const settlement = settleExecution(decision.value, outcome);
    if (!settlement.ok) return reverted(gateRevertData(settlement.rejection));

    ledger = working;
    consumed.add(decision.value.mandateDigest);
    return {
      settled: true,
      revertData: '0x',
      mandateDigest: decision.value.mandateDigest,
      candidateDigest: decision.value.candidateDigest,
      executionCommitment: decision.value.executionCommitment,
      debit: settlement.value.actualDebit,
      credit: settlement.value.actualCredit,
    };
  });
}

/** The gate's interaction phase against `ScriptedAdapter`: revert data, or the measured balances. */
function interact(ledger: Ledger, plan: ExecutionPlan, script: Script) {
  const inputBefore = ledger.balance(plan.inputToken, plan.principal);
  const outputBefore = ledger.balance(plan.outputToken, plan.recipient);

  const adapter = plan.market.adapter;
  const pull = ledger.transferFrom(plan.inputToken, ADDR.gate, plan.principal, adapter, plan.inputAmount);
  if (pull !== undefined) return pull;

  if (script.mode === ScriptMode.REVERT) return encodeRevert('ScriptedRevert()', []);
  if (script.mode === ScriptMode.PULL_FROM_PRINCIPAL) {
    const extra = ledger.transferFrom(plan.inputToken, adapter, plan.principal, adapter, script.extraPull);
    if (extra !== undefined) return extra;
  }
  if (script.deliver !== 0n) {
    const failed = ledger.transfer(plan.outputToken, adapter, script.deliverElsewhere ? SINK : plan.recipient, script.deliver);
    if (failed !== undefined) return failed;
  }
  if (script.refund !== 0n) {
    const failed = ledger.transfer(plan.inputToken, adapter, plan.principal, script.refund);
    if (failed !== undefined) return failed;
  }
  return {
    inputBefore,
    inputAfter: ledger.balance(plan.inputToken, plan.principal),
    outputBefore,
    outputAfter: ledger.balance(plan.outputToken, plan.recipient),
  };
}

export function honest(deliver: bigint, refund = 0n): Script {
  return { mode: ScriptMode.SCRIPTED, deliver, refund, deliverElsewhere: false, extraPull: 0n };
}

export const now = (timestamp: bigint = T0, chainId: bigint = CHAIN_ID): ChainMoment => ({ chainId, timestamp });
