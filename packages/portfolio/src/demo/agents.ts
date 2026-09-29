/**
 * The demonstration's five agents. **Deterministic strategies, no model.**
 *
 * Each agent has its own ranked opportunities — what it "discovered" — and
 * prefers them in order: the stock agent the cheaper same-ticker token, the
 * swap agent the router quoting more output, the NFT agent the cheaper
 * collection with the right display name, the yield agent the 12.60 % vault,
 * the perps agent the full 600 position. The agents are *untrusted*: nothing
 * they believe is authority. They are deliberately wrong in the ways real
 * agents are wrong, and the portfolio's authority stops each one.
 *
 * Strategy, for every agent:
 *
 * - on `ACCEPTED`: done;
 * - on `REJECTED`: move to its next opportunity;
 * - on `REDUCE_REQUESTED`: resize the same opportunity to the largest size
 *   whose demand fits the target, if that is still at least its minimum;
 *   otherwise move on;
 * - with nothing left to propose: release its unused allocation once, then idle.
 *
 * Agents price their requests with the same public binding code the verifier
 * uses — any agent can — and declare exactly that demand.
 */

import type { Identifier } from '@mandate/kernel';
import {
  agentPolicyOf,
  amountOf,
  portfolioMandateDigest,
  proposalDigest,
  proposalSigningHash,
  releaseDigest,
  releaseSigningHash,
  resolveCandidate,
  resourceVectorInputOf,
  validateActionCandidate,
  validateAgentProposal,
  validateAgentRelease,
  validateResourceVector,
  type ActionCandidate,
  type ActionCandidateInput,
  type AgentMessage,
  type AgentPolicy,
  type AgentStrategy,
  type DomainBinding,
  type PortfolioMandate,
  type ResourceAmountInput,
  type ResourceVector,
  type RoomFeedback,
} from '../index.ts';
import { demoKey, demoParty, signPrehash } from './keys.ts';
import {
  APPROVED_POOL,
  APPROVED_ROUTER,
  APPROVED_VAULT,
  BTC_PERP,
  BTC_PRICE_LIGHTER,
  DEMO_T0,
  FIXTURE_USDC,
  IMPOSTOR_COLLECTION,
  LOOKALIKE_QUOTE_ATOMS,
  MARKETPLACE,
  NVDA,
  PERP_ACCOUNT,
  PRINCIPAL_ON_ARBITRUM,
  PRINCIPAL_ON_ROBINHOOD,
  STOCK_APPROVED,
  STOCK_LOOKALIKE,
  STOCK_PRICE_ATOMS,
  UNKNOWN_ROUTER,
  UNVETTED_VAULT,
  WETH,
} from './markets.ts';

const TOKEN = 10n ** 18n;
const NONE = { ticker: null, displayName: null, issuer: null, asset: null };

/**
 * One discovered opportunity: a candidate at a size (in USDC atoms of what
 * it commits), the size the agent wants, the least it would accept, and how
 * it would price it if the portfolio's tools cannot (an unknown instrument).
 */
export interface Opportunity {
  readonly name: Identifier;
  readonly at: (size: bigint) => ActionCandidateInput;
  readonly size: bigint;
  readonly minimum: bigint;
  /** The agent's own notional estimate, in USDC atoms, used only when the instrument cannot be resolved. */
  readonly estimate: (size: bigint) => bigint;
  readonly resizable: boolean;
}

function candidate(input: ActionCandidateInput): ActionCandidate {
  const c = validateActionCandidate(input);
  if (!c.ok) throw new Error(`demo candidate refused: ${c.error.code} at ${c.error.path}`);
  return c.value;
}

const usdc = (whole: bigint) => whole * 1_000_000n;

/** Whole-token quantity (18 decimals) buying `notional` USDC atoms at `price` USDC atoms per token, rounded down. */
const tokensFor = (notional: bigint, price: bigint) => (notional * TOKEN) / price;

export const DEMO_OPPORTUNITIES: { readonly [role: string]: readonly Opportunity[] } = {
  stock: [
    {
      // Cheaper, same display ticker — an unapproved issuer's synthetic look-alike.
      name: 'stock/lookalike-nvda-122.50' as Identifier,
      at: (n) => ({ kind: 'STOCK_BUY', representation: STOCK_LOOKALIKE, account: PRINCIPAL_ON_ROBINHOOD, quantity: tokensFor(n, LOOKALIKE_QUOTE_ATOMS), claims: { ...NONE, ticker: 'NVDA', asset: NVDA } }),
      size: usdc(600n),
      minimum: usdc(400n),
      estimate: (n) => n,
      resizable: true,
    },
    {
      name: 'stock/approved-nvda-125.00' as Identifier,
      at: (n) => ({ kind: 'STOCK_BUY', representation: STOCK_APPROVED, account: PRINCIPAL_ON_ROBINHOOD, quantity: tokensFor(n, STOCK_PRICE_ATOMS), claims: { ...NONE, ticker: 'NVDA', asset: NVDA } }),
      size: usdc(600n),
      minimum: usdc(400n),
      estimate: (n) => n,
      resizable: true,
    },
  ],
  swap: [
    {
      // An unknown router quoting more WETH for the same USDC.
      name: 'swap/unknown-router-best-quote' as Identifier,
      at: (n) => ({ kind: 'SWAP_EXACT_IN', router: UNKNOWN_ROUTER, route: [APPROVED_POOL], tokenIn: FIXTURE_USDC, tokenOut: WETH, amountIn: n, quotedOut: (n * 125_000_000_000n) / 1_000_000n, minOut: (n * 124_625_000_000n) / 1_000_000n, quoteObservedAt: DEMO_QUOTED, recipient: PRINCIPAL_ON_ARBITRUM, claims: NONE }),
      size: usdc(300n),
      minimum: usdc(200n),
      estimate: (n) => n,
      resizable: true,
    },
    {
      name: 'swap/approved-router' as Identifier,
      at: (n) => ({ kind: 'SWAP_EXACT_IN', router: APPROVED_ROUTER, route: [APPROVED_POOL], tokenIn: FIXTURE_USDC, tokenOut: WETH, amountIn: n, quotedOut: (n * 120_000_000_000n) / 1_000_000n, minOut: (n * 119_640_000_000n) / 1_000_000n, quoteObservedAt: DEMO_QUOTED, recipient: PRINCIPAL_ON_ARBITRUM, claims: NONE }),
      size: usdc(300n),
      minimum: usdc(200n),
      estimate: (n) => n,
      resizable: true,
    },
  ],
  nft: [
    {
      // Same display name, lower price, another contract.
      name: 'nft/impostor-genesis-350' as Identifier,
      at: (n) => ({ kind: 'NFT_BUY', marketplace: MARKETPLACE, collection: IMPOSTOR_COLLECTION, tokenId: 7n, maxPrice: n, recipient: PRINCIPAL_ON_ARBITRUM, claims: { ...NONE, displayName: 'Mandate-Genesis' } }),
      size: usdc(350n),
      minimum: usdc(350n),
      estimate: (n) => n,
      resizable: false,
    },
  ],
  yield: [
    {
      // 12.60 % quoted by a vault from an issuer nobody vetted.
      name: 'yield/unvetted-12.60' as Identifier,
      at: (n) => ({ kind: 'YIELD_DEPOSIT', product: UNVETTED_VAULT, amount: n, quotedApyBps: 1_260, quoteObservedAt: DEMO_QUOTED, recipient: PRINCIPAL_ON_ARBITRUM, claims: NONE }),
      size: usdc(700n),
      minimum: usdc(400n),
      estimate: (n) => n,
      resizable: true,
    },
    {
      name: 'yield/approved-5.20' as Identifier,
      at: (n) => ({ kind: 'YIELD_DEPOSIT', product: APPROVED_VAULT, amount: n, quotedApyBps: 520, quoteObservedAt: DEMO_QUOTED, recipient: PRINCIPAL_ON_ARBITRUM, claims: NONE }),
      size: usdc(700n),
      minimum: usdc(400n),
      estimate: (n) => n,
      resizable: true,
    },
  ],
  perps: [
    {
      // BTC long at 2x: locally valid, 600 of committed notional.
      name: 'perps/btc-long-2x' as Identifier,
      at: (n) => ({ kind: 'PERP_OPEN', market: BTC_PERP, account: PERP_ACCOUNT, side: 'LONG', size: n / BTC_PRICE_LIGHTER, price: BTC_PRICE_LIGHTER, initialMarginFraction: 5_000, claims: NONE }),
      size: usdc(600n),
      minimum: usdc(200n),
      estimate: (n) => n,
      resizable: true,
    },
  ],
};

/** Agents rank claims on released allocation by their own conviction: metadata, never authority. */
export const DEMO_UTILITY: { readonly [role: string]: bigint } = { stock: 900n, swap: 800n, perps: 700n, yield: 600n, nft: 500n };

/** Quotes the agents observed: ten seconds before the demonstration's decision time. */
export const DEMO_QUOTED = DEMO_T0 + 990n;

export class DemoAgent implements AgentStrategy {
  readonly role: string;
  readonly agent: { kind: string; value: string };
  readonly #m: PortfolioMandate;
  readonly #policy: AgentPolicy;
  readonly #bindings: readonly DomainBinding[];
  readonly #now: bigint;
  readonly #opportunities: readonly Opportunity[];
  #index = 0;
  #size: bigint;
  #sequence = 0n;
  #releases = 0n;
  #done = false;
  #released = false;

  constructor(role: string, m: PortfolioMandate, bindings: readonly DomainBinding[], now: bigint, opportunities: readonly Opportunity[] = DEMO_OPPORTUNITIES[role] ?? []) {
    this.role = role;
    this.agent = demoParty(role);
    this.#m = m;
    const policy = agentPolicyOf(m, this.agent);
    if (policy === null) throw new Error(`${role} is not an agent of this mandate`);
    this.#policy = policy;
    this.#bindings = bindings;
    this.#now = now;
    this.#opportunities = opportunities;
    this.#size = opportunities[0]?.size ?? 0n;
  }

  /** What an opportunity at a size would demand, by the portfolio's own public code; the agent's estimate if it cannot resolve. */
  demandAt(o: Opportunity, size: bigint): ResourceVector {
    const r = resolveCandidate(this.#bindings, this.#m, this.#policy, candidate(o.at(size)), this.#now);
    if (r.ok) return r.action.demand;
    const own = validateResourceVector([{ resource: 'portfolio-notional', atoms: o.estimate(size) }], 'estimate');
    return own.ok ? own.value : [];
  }

  /** The largest size, at most the current one, whose demand fits `target`; binary search over a monotone demand. */
  #fit(o: Opportunity, target: ResourceVector): bigint | null {
    const fits = (s: bigint) => this.demandAt(o, s).every((a) => target.every((t) => t.resource !== a.resource || a.atoms <= t.atoms));
    if (fits(this.#size)) return this.#size;
    let lo = 0n;
    let hi = this.#size;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo >= o.minimum && fits(lo) ? lo : null;
  }

  #next(): void {
    this.#index += 1;
    this.#size = this.#opportunities[this.#index]?.size ?? 0n;
  }

  act(_round: number, feedback: RoomFeedback): AgentMessage {
    for (const d of feedback.decisions) {
      const o = this.#opportunities[this.#index];
      if (d.outcome === 'ACCEPTED') this.#done = true;
      else if (d.outcome === 'REJECTED' || o === undefined) this.#next();
      else {
        const size = o.resizable ? this.#fit(o, d.target) : null;
        if (size === null) this.#next();
        else this.#size = size;
      }
    }
    if (this.#done || this.#released) return { kind: 'IDLE' };
    const o = this.#opportunities[this.#index];
    if (o === undefined) return this.#release();
    this.#sequence += 1n;
    const demand = this.demandAt(o, this.#size);
    const requested = resourceVectorInputOf(demand);
    const minimum: ResourceAmountInput[] = [{ resource: 'portfolio-notional', atoms: o.minimum < amountOf(demand, 'portfolio-notional') ? o.minimum : amountOf(demand, 'portfolio-notional') }];
    const p = validateAgentProposal({
      portfolioMandate: portfolioMandateDigest(this.#m),
      agent: this.agent,
      sequence: this.#sequence,
      candidate: o.at(this.#size),
      requested,
      minimum,
      utilityBps: DEMO_UTILITY[this.role] ?? 0n,
      createdAt: this.#now - 10n,
      expiresAt: this.#now + 3_600n,
      criticalExtensions: [],
    });
    if (!p.ok) throw new Error(`demo proposal refused: ${p.error.code} at ${p.error.path}`);
    return { kind: 'PROPOSE', signed: { proposal: p.value, signature: signPrehash(proposalSigningHash(proposalDigest(p.value)), demoKey(this.role)) } };
  }

  /** Nothing left worth proposing: give back every unused preferred allocation, once. */
  #release(): AgentMessage {
    this.#released = true;
    if (this.#policy.preferred.length === 0) return { kind: 'IDLE' };
    this.#releases += 1n;
    const r = validateAgentRelease({ portfolioMandate: portfolioMandateDigest(this.#m), agent: this.agent, sequence: this.#releases, amounts: resourceVectorInputOf(this.#policy.preferred) });
    if (!r.ok) throw new Error(`demo release refused: ${r.error.code}`);
    return { kind: 'RELEASE', signed: { release: r.value, signature: signPrehash(releaseSigningHash(releaseDigest(r.value)), demoKey(this.role)) } };
  }
}

export function demoAgentStrategies(m: PortfolioMandate, bindings: readonly DomainBinding[], now: bigint): readonly DemoAgent[] {
  return ['stock', 'swap', 'nft', 'yield', 'perps'].map((role) => new DemoAgent(role, m, bindings, now));
}
