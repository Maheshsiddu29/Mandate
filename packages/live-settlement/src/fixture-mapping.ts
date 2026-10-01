/**
 * The testnet settlement fixture: how a reserved Live AI Stock decision is
 * exercised on Robinhood Chain testnet.
 *
 * The Live AI Lab's Stock domain decides over the Phase 7F demonstration
 * market — `nvda-note-a`, a fictional fully backed NVIDIA note on an
 * *offline* reviewed gate configuration that settles an engineered USDC
 * (portfolio/src/demo/markets.ts). The repository defines no mapping from
 * that market to the deployed Phase 7E.3 gate, whose only market is the
 * labelled fixture MDEMO against MDUSD. This module is that mapping, and it
 * says exactly what it is:
 *
 * - **Decision semantics:** `nvda-note-a` — what the model chose, what
 *   Mandate screened, verified and reserved. Its canonical asset stays NVDA;
 *   nothing here changes it.
 * - **Execution fixture:** a BUY of MDEMO for MDUSD through the deployed
 *   `MandateExecutionGate`. Valueless assets whose only purpose is to
 *   exercise the Robinhood Chain testnet settlement path. MDEMO is not NVDA
 *   and not a Robinhood Stock Token; MDUSD is not a stablecoin.
 *
 * **The rule (quantity-preserving).** The gate BUY's quantity is the
 * reserved STOCK_BUY's quantity, atom for atom (both 18 decimals). The debit
 * is whatever the fixture venue charges for that quantity at its immutable
 * price (`buyCost`), which the gate itself enforces. The recipient defaults
 * to the deployment's principal. A V2 settlement may name the wallet instead:
 * the gate accepts any principal that signs, and debits that address. Nothing
 * else is carried over, and nothing comes from a model.
 *
 * Every field that reaches the chain is bound into `bindingDigest`, and the
 * Core action the domain leg reserves carries its first eight bytes as its
 * nonce, so the principal-signed gate mandate (whose id derives from that
 * action) commits to this mapping.
 */

import { ByteWriter } from '@mandate/kernel';
import { keccakDigest, type Digest32 } from '@mandate/core';
import { ADDRESS, buyCost, grossCost, representationIdOf, type Address, type ReviewedMarket } from '@mandate/evm-robinhood';
import { DEMO_GATE_CONFIG, STOCK_APPROVED } from '@mandate/portfolio/demo';
import type { AuthorizedExecution } from './authorized-execution.ts';
import type { TestnetDeployment } from './deployment.ts';

export const TESTNET_SETTLEMENT_FIXTURE = {
  id: 'live-ai.robinhood-testnet-settlement-fixture',
  version: 1,
  decision: 'nvda-note-a — Fixture Backed NVIDIA Note (Live AI Lab decision semantics, Phase 7F offline demonstration market)',
  execution: 'MDUSD → MDEMO through the Phase 7E.3 MandateExecutionGate on Robinhood Chain testnet (valueless execution-fixture assets)',
  rule: 'quantity-preserving: gate BUY quantity = the reserved STOCK_BUY quantity, atom for atom; debit = the fixture venue’s quote for that quantity; recipient = the deployment principal, or the V2 wallet when that wallet is the execution principal',
  disclaimer: 'Robinhood Chain testnet fixture settlement. MDEMO is not NVDA and not a Robinhood Stock Token; MDUSD is not a stablecoin. Valueless demo assets. This is not an NVDA trade.',
} as const;

/** The candidate the fixture is defined for: the reviewed backed note, nothing else. */
export const FIXTURE_SOURCE_REPRESENTATION = STOCK_APPROVED as string;
/** A sanity ceiling on the fixture debit, in MDUSD atoms (100 MDUSD). The Stock agent's own maximum maps to 64. */
export const FIXTURE_MAX_DEBIT_ATOMS = 100_000_000n;

export interface FixtureSettlement {
  readonly fixture: typeof TESTNET_SETTLEMENT_FIXTURE;
  readonly execution: AuthorizedExecution;
  readonly chainId: bigint;
  readonly gate: Address;
  readonly market: ReviewedMarket;
  /** MDUSD: what the principal pays. */
  readonly tokenIn: Address;
  /** MDEMO: what the principal receives. */
  readonly tokenOut: Address;
  /** MDEMO atoms. */
  readonly quantity: bigint;
  /** MDUSD atoms: the venue's exact quote, fee included; the only amount the gate can pull. */
  readonly debit: bigint;
  /** MDUSD atoms before fees. */
  readonly gross: bigint;
  readonly recipient: Address;
  readonly agent: Address;
  readonly bindingDigest: Digest32;
  /** The domain leg's Core action nonce: the first eight bytes of `bindingDigest`. */
  readonly actionNonce: bigint;
}

export type Mapped = { readonly ok: true; readonly value: FixtureSettlement } | { readonly ok: false; readonly reason: string };

const sourceMarket = DEMO_GATE_CONFIG.markets.find((m) => `eip155:${DEMO_GATE_CONFIG.chainId}/erc20:${m.representation}` === FIXTURE_SOURCE_REPRESENTATION);

export function settlementBindingDigest(s: Omit<FixtureSettlement, 'bindingDigest' | 'actionNonce' | 'fixture' | 'execution' | 'market'> & { readonly execution: AuthorizedExecution }): Digest32 {
  const x = s.execution;
  const w = new ByteWriter().str('mandate/live-settlement/robinhood-testnet-fixture').u16(TESTNET_SETTLEMENT_FIXTURE.version);
  for (const v of [x.portfolioMandate, x.proposal, x.candidateDigest, x.child, x.reservation, x.executionAuthorization, x.action, x.receiptDigest]) w.str(v);
  w.u64(x.generation).u64(BigInt(x.version)).str(x.candidate.representation).u256(x.candidate.quantity).u256(x.notionalAtoms);
  w.u64(s.chainId).str(s.gate).str(s.tokenIn).str(s.tokenOut).u256(s.quantity).u256(s.debit).u256(s.gross).str(s.recipient).str(s.agent);
  return keccakDigest<Digest32>(w.finish());
}

/**
 * The fixture settlement of `x` on `d`, or why the fixture does not define one.
 * `recipient` defaults to the deployment principal. A V2 wallet that is not
 * that address passes itself: the binding then commits to that recipient.
 * Pure.
 */
export function mapToFixture(x: AuthorizedExecution, d: TestnetDeployment, recipient: Address = d.principal): Mapped {
  if (!ADDRESS.test(recipient)) return { ok: false, reason: 'FIXTURE_RECIPIENT_INVALID' };
  const c = x.candidate;
  if (c.representation !== FIXTURE_SOURCE_REPRESENTATION || sourceMarket === undefined) return { ok: false, reason: 'FIXTURE_UNDEFINED_FOR_CANDIDATE' };
  const market = d.market;
  // Quantity is carried atom for atom only between equal precisions; anything else would be a silent rescale.
  if (sourceMarket.representationDecimals !== market.representationDecimals) return { ok: false, reason: 'FIXTURE_DECIMALS_DIFFER' };
  if (c.quantity <= 0n) return { ok: false, reason: 'FIXTURE_QUANTITY_NOT_POSITIVE' };
  if (market.representation !== d.mdemo.address || market.fundingToken !== d.mdusd.address) return { ok: false, reason: 'FIXTURE_MARKET_NOT_MDEMO_MDUSD' };
  const debit = buyCost(market, c.quantity);
  if (debit <= 0n) return { ok: false, reason: 'FIXTURE_DEBIT_NOT_POSITIVE' };
  if (debit > FIXTURE_MAX_DEBIT_ATOMS) return { ok: false, reason: 'FIXTURE_DEBIT_ABOVE_CEILING' };
  const base = { execution: x, chainId: d.chainId, gate: d.gate.address, tokenIn: market.fundingToken, tokenOut: market.representation, quantity: c.quantity, debit, gross: grossCost(market, c.quantity), recipient, agent: d.agent };
  const bindingDigest = settlementBindingDigest(base);
  return { ok: true, value: { ...base, fixture: TESTNET_SETTLEMENT_FIXTURE, market, bindingDigest, actionNonce: BigInt(bindingDigest.slice(0, 18)) } };
}

/** The representation id the gate candidate must name: MDEMO on 46630. */
export function fixtureRepresentationId(s: FixtureSettlement): string {
  return representationIdOf(s.chainId, s.tokenOut);
}
