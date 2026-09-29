/** Candidate builders over the demonstration markets. Deterministic; every identifier a labelled fixture. */

import { validateActionCandidate, type ActionCandidate, type ActionCandidateInput, type ClaimsInput } from '../../src/index.ts';
import {
  APPROVED_POOL,
  APPROVED_ROUTER,
  APPROVED_VAULT,
  BTC_PERP,
  BTC_PRICE_LIGHTER,
  DEMO_T0,
  FIXTURE_USDC,
  GENESIS_COLLECTION,
  MARKETPLACE,
  PERP_ACCOUNT,
  PRINCIPAL_ON_ARBITRUM,
  PRINCIPAL_ON_ROBINHOOD,
  STOCK_APPROVED,
  WETH,
} from '../../src/demo/index.ts';

export const NO_CLAIMS: ClaimsInput = { ticker: null, displayName: null, issuer: null, asset: null };
export const TOKEN = 10n ** 18n;
/** The decision time these candidates are built for; quotes default to ten seconds before it. */
export const NOW = DEMO_T0 + 1_000n;
const QUOTED = NOW - 10n;

function must(input: ActionCandidateInput): ActionCandidate {
  const r = validateActionCandidate(input);
  if (!r.ok) throw new Error(`candidate refused: ${r.error.code} at ${r.error.path}`);
  return r.value;
}

/** `tenths` tenths of a token: 48 → 4.8 tokens. */
export function stockBuy(o: { representation?: string; tenths?: bigint; quantity?: bigint; account?: string; claims?: Partial<ClaimsInput> } = {}): ActionCandidate {
  return must({ kind: 'STOCK_BUY', representation: o.representation ?? STOCK_APPROVED, account: o.account ?? PRINCIPAL_ON_ROBINHOOD, quantity: o.quantity ?? ((o.tenths ?? 48n) * TOKEN) / 10n, claims: { ...NO_CLAIMS, ticker: 'NVDA', ...o.claims } });
}

export function swap(o: { router?: string; route?: string[]; tokenIn?: string; tokenOut?: string; amount?: bigint; quotedOut?: bigint; minOut?: bigint; observedAt?: bigint; recipient?: string } = {}): ActionCandidate {
  const quotedOut = o.quotedOut ?? 120_000_000_000_000_000n;
  return must({
    kind: 'SWAP_EXACT_IN',
    router: o.router ?? APPROVED_ROUTER,
    route: o.route ?? [APPROVED_POOL],
    tokenIn: o.tokenIn ?? FIXTURE_USDC,
    tokenOut: o.tokenOut ?? WETH,
    amountIn: o.amount ?? 300_000_000n,
    quotedOut,
    minOut: o.minOut ?? (quotedOut * 9_970n) / 10_000n,
    quoteObservedAt: o.observedAt ?? QUOTED,
    recipient: o.recipient ?? PRINCIPAL_ON_ARBITRUM,
    claims: NO_CLAIMS,
  });
}

export function nftBuy(o: { collection?: string; price?: bigint; recipient?: string; displayName?: string } = {}): ActionCandidate {
  return must({ kind: 'NFT_BUY', marketplace: MARKETPLACE, collection: o.collection ?? GENESIS_COLLECTION, tokenId: 42n, maxPrice: o.price ?? 350_000_000n, recipient: o.recipient ?? PRINCIPAL_ON_ARBITRUM, claims: { ...NO_CLAIMS, displayName: o.displayName ?? 'Mandate-Genesis' } });
}

export function yieldDeposit(o: { product?: string; amount?: bigint; apyBps?: number; observedAt?: bigint; issuer?: string | null } = {}): ActionCandidate {
  return must({ kind: 'YIELD_DEPOSIT', product: o.product ?? APPROVED_VAULT, amount: o.amount ?? 700_000_000n, quotedApyBps: o.apyBps ?? 520, quoteObservedAt: o.observedAt ?? QUOTED, recipient: PRINCIPAL_ON_ARBITRUM, claims: { ...NO_CLAIMS, issuer: o.issuer ?? null } });
}

/** `usdc` whole USDC of BTC at 100,000.0: 1 base atom (0.00001 BTC) is 1 USDC. */
export function perpOpen(o: { usdc?: bigint; imf?: number; market?: string; account?: string } = {}): ActionCandidate {
  return must({ kind: 'PERP_OPEN', market: o.market ?? BTC_PERP, account: o.account ?? PERP_ACCOUNT, side: 'LONG', size: o.usdc ?? 600n, price: BTC_PRICE_LIGHTER, initialMarginFraction: o.imf ?? 5_000, claims: NO_CLAIMS });
}
