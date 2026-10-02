/**
 * The testnet settlement fixture: how a reserved Live AI Stock decision is
 * exercised on Robinhood Chain testnet.
 *
 * The Live AI Lab's Stock domain decides over the labelled market set V2
 * (portfolio/src/demo/live-markets.ts): two reviewed, approved NVDA notes
 * — `nvda-note-a` and `nvda-note-c` — on an *offline* reviewed gate
 * configuration that settles an engineered USDC. The deployed Phase 7E.3
 * gate has exactly one market: the labelled fixture MDEMO against MDUSD.
 * This module is the mapping between the two, and it says exactly what it
 * is:
 *
 * - **Decision semantics:** the exact semantic candidate the model chose
 *   and Mandate screened, verified and reserved — note A or note C, by its
 *   candidate id and its registry representation together. Its canonical
 *   asset stays NVDA; nothing here changes it.
 * - **Execution fixture:** a BUY of MDEMO for MDUSD through the deployed
 *   `MandateExecutionGate`, for either note. Valueless assets whose only
 *   purpose is to exercise the Robinhood Chain testnet settlement path.
 *   MDEMO is not NVDA and not a Robinhood Stock Token; MDUSD is not a
 *   stablecoin.
 *
 * The candidates it is defined for are the Live Lab settlement profile's
 * table (`ROBINHOOD_TESTNET_STOCK_FIXTURES` in `@mandate/live-agents`): the
 * same list that decided, before the model was asked, which candidates
 * were offered as executable. This module does not trust that earlier
 * answer; it looks the reserved candidate up again and refuses anything
 * the table does not name (`FIXTURE_UNDEFINED_FOR_CANDIDATE`).
 *
 * **The rule (quantity-preserving), the same for every note.** The gate
 * BUY's quantity is the reserved STOCK_BUY's quantity, atom for atom (both
 * 18 decimals). The debit is whatever the fixture venue charges for that
 * quantity at its immutable price (`buyCost`), which the gate itself
 * enforces. The semantic note's own price and fee (125.00, or 124.75 plus
 * 25 bps) are fixture economics of the decision; they are not reproduced on
 * chain and are never claimed to be. The recipient defaults to the
 * deployment's principal. A V2 settlement may name the wallet instead: the
 * gate accepts any principal that signs, and debits that address. Nothing
 * else is carried over, and nothing comes from a model.
 *
 * **Identity.** Both notes reach the same fixture token, so the chain alone
 * cannot say which note was settled — the binding does. Every field that
 * reaches the chain is bound into `bindingDigest` together with the
 * reserved candidate's representation, its candidate digest, the proposal,
 * the child, the reservation and the action; the Core action the domain leg
 * reserves carries the digest's first eight bytes as its nonce, so the
 * principal-signed gate mandate (whose id derives from that action) commits
 * to this exact semantic candidate. A note C reservation cannot produce a
 * note A binding, and nothing here ever substitutes one for the other.
 */

import { ByteWriter } from '@mandate/kernel';
import { keccakDigest, type Digest32 } from '@mandate/core';
import { ADDRESS, buyCost, grossCost, representationIdOf, type Address, type ReviewedMarket } from '@mandate/evm-robinhood';
import { ROBINHOOD_TESTNET_STOCK_FIXTURES, stockFixtureFor, type StockFixtureDefinition } from '@mandate/live-agents';
import { LIVE_GATE_CONFIG } from '@mandate/portfolio/demo';
import type { AuthorizedExecution } from './authorized-execution.ts';
import type { TestnetDeployment } from './deployment.ts';

export const TESTNET_SETTLEMENT_FIXTURE = {
  id: 'live-ai.robinhood-testnet-settlement-fixture',
  version: 1,
  decision: 'the exact reserved semantic Stock candidate — nvda-note-a or nvda-note-c (Live AI Lab decision semantics, labelled offline market set V2)',
  candidates: ROBINHOOD_TESTNET_STOCK_FIXTURES.map((d) => d.semantic),
  execution: 'MDUSD → MDEMO through the Phase 7E.3 MandateExecutionGate on Robinhood Chain testnet (valueless execution-fixture assets)',
  rule: 'quantity-preserving: gate BUY quantity = the reserved STOCK_BUY quantity, atom for atom; debit = the fixture venue’s quote for that quantity; recipient = the deployment principal, or the V2 wallet when that wallet is the execution principal',
  disclaimer: 'Robinhood Chain testnet fixture settlement. MDEMO is not NVDA and not a Robinhood Stock Token; MDUSD is not a stablecoin. Valueless demo assets. This is not an NVDA trade.',
} as const;

/** A sanity ceiling on the fixture debit, in MDUSD atoms (100 MDUSD). Note A's 800 maximum maps to 64, note C's 600 to under 48. */
export const FIXTURE_MAX_DEBIT_ATOMS = 100_000_000n;

export interface FixtureSettlement {
  readonly fixture: typeof TESTNET_SETTLEMENT_FIXTURE;
  /** The semantic candidate this settlement exercises: exactly the reserved one. */
  readonly semantic: StockFixtureDefinition;
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

/** The offline reviewed market a semantic representation decides over (its decimals are what the quantity carries). */
const sourceMarketOf = (representation: string) => LIVE_GATE_CONFIG.markets.find((m) => `eip155:${LIVE_GATE_CONFIG.chainId}/erc20:${m.representation}` === representation);

export function settlementBindingDigest(s: Omit<FixtureSettlement, 'bindingDigest' | 'actionNonce' | 'fixture' | 'semantic' | 'execution' | 'market'> & { readonly execution: AuthorizedExecution }): Digest32 {
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
  // The reserved candidate's own id and representation, together; never one note standing in for another.
  const semantic = stockFixtureFor(x.candidateId, c.representation);
  const sourceMarket = semantic === null ? undefined : sourceMarketOf(semantic.representation);
  if (semantic === null || sourceMarket === undefined) return { ok: false, reason: 'FIXTURE_UNDEFINED_FOR_CANDIDATE' };
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
  return { ok: true, value: { ...base, fixture: TESTNET_SETTLEMENT_FIXTURE, semantic, market, bindingDigest, actionNonce: BigInt(bindingDigest.slice(0, 18)) } };
}

/** The representation id the gate candidate must name: MDEMO on 46630. */
export function fixtureRepresentationId(s: FixtureSettlement): string {
  return representationIdOf(s.chainId, s.tokenOut);
}
