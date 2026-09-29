/**
 * Action candidates (portfolio-mandate.md §8).
 *
 * The one exact action a proposal asks for. Five kinds in v1, each naming the
 * exact identity it would touch — a registry representation, a router and its
 * route, a collection contract, a vault, a perp market — and its own
 * economics in the instrument's atoms.
 *
 * **Claims are not identity.** Every candidate may also say what the agent
 * *believes*: a ticker, a display name, an issuer, a canonical asset. Those
 * are committed with the candidate, so a receipt can show that a look-alike
 * carried the right ticker, but no check reads a claim as identity. The
 * verifier derives identity from the registry or a reviewed instrument table
 * and refuses a claim that disagrees (`IDENTITY_CLAIM_MISMATCH`).
 *
 * The candidate's digest is its `candidateReference`: a proposal, a child
 * execution authorization and a Core action all bind it, and any change to
 * any field is a different candidate.
 */

import { ok, type ByteWriter, type CanonicalAssetId, type Identifier } from '@mandate/kernel';
import {
  UINT256_MAX,
  at,
  checkArray,
  checkFields,
  fail,
  parseEnum,
  parseIdentifierAs,
  parseInteger,
  parseSmallUint,
  parseUnixSeconds,
  readCode,
  readNullable,
  writeCode,
  writeNullable,
  type CoreReader,
  type CoreResult,
  type Digest32,
  type IntegerInput,
  type Tagged,
} from '@mandate/core';
import { PortfolioTag, portfolioDigest, portfolioWriter } from './encoding.ts';
import { ACTION_KIND_CODE, ACTION_KINDS, readCanonicalAssetInput, validateCanonicalAsset, writeCanonicalAsset, type ActionKind, type CanonicalAssetInput } from './scope.ts';

export type CandidateDigest = Tagged<Digest32, 'CandidateDigest'>;

/** A swap route has at most this many pools; a route is an ordered path, not a set. */
export const MAX_ROUTE_HOPS = 4;

export interface ClaimsInput {
  readonly ticker: string | null;
  readonly displayName: string | null;
  readonly issuer: string | null;
  readonly asset: CanonicalAssetInput | null;
}

/** What the agent believes. Committed, displayed, compared with derived facts — never identity. */
export type Claims = Tagged<
  { readonly ticker: Identifier | null; readonly displayName: Identifier | null; readonly issuer: Identifier | null; readonly asset: CanonicalAssetId | null },
  'Claims'
>;

export const PerpSide = { LONG: 'LONG', SHORT: 'SHORT' } as const;
export type PerpSide = (typeof PerpSide)[keyof typeof PerpSide];
const PERP_SIDES: readonly PerpSide[] = ['LONG', 'SHORT'];
const PERP_SIDE_CODE = { LONG: 1, SHORT: 2 } as const;

export type ActionCandidateInput =
  | { readonly kind: 'STOCK_BUY'; readonly representation: string; readonly account: string; readonly quantity: IntegerInput; readonly claims: ClaimsInput }
  | {
      readonly kind: 'SWAP_EXACT_IN';
      readonly router: string;
      readonly route: readonly string[];
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly amountIn: IntegerInput;
      readonly quotedOut: IntegerInput;
      readonly minOut: IntegerInput;
      readonly quoteObservedAt: IntegerInput;
      readonly recipient: string;
      readonly claims: ClaimsInput;
    }
  | { readonly kind: 'NFT_BUY'; readonly marketplace: string; readonly collection: string; readonly tokenId: IntegerInput; readonly maxPrice: IntegerInput; readonly recipient: string; readonly claims: ClaimsInput }
  | { readonly kind: 'YIELD_DEPOSIT'; readonly product: string; readonly amount: IntegerInput; readonly quotedApyBps: number; readonly quoteObservedAt: IntegerInput; readonly recipient: string; readonly claims: ClaimsInput }
  | {
      readonly kind: 'PERP_OPEN';
      readonly market: string;
      readonly account: string;
      readonly side: string;
      readonly size: IntegerInput;
      readonly price: IntegerInput;
      /** Per 10,000: the account's initial margin fraction for the market; leverage is 10,000 / this. */
      readonly initialMarginFraction: number;
      readonly claims: ClaimsInput;
    };

export type StockBuy = { readonly kind: 'STOCK_BUY'; readonly representation: Identifier; readonly account: Identifier; readonly quantity: bigint; readonly claims: Claims };
export type SwapExactIn = {
  readonly kind: 'SWAP_EXACT_IN';
  /** The venue: the router contract itself, never a name for it. */
  readonly router: Identifier;
  readonly route: readonly Identifier[];
  readonly tokenIn: Identifier;
  readonly tokenOut: Identifier;
  readonly amountIn: bigint;
  /** The venue's quoted output: an observation, not a promise. */
  readonly quotedOut: bigint;
  /** The least the artifact accepts; slippage is measured between the two. */
  readonly minOut: bigint;
  readonly quoteObservedAt: bigint;
  readonly recipient: Identifier;
  readonly claims: Claims;
};
export type NftBuy = { readonly kind: 'NFT_BUY'; readonly marketplace: Identifier; readonly collection: Identifier; readonly tokenId: bigint; readonly maxPrice: bigint; readonly recipient: Identifier; readonly claims: Claims };
export type YieldDeposit = {
  readonly kind: 'YIELD_DEPOSIT';
  readonly product: Identifier;
  readonly amount: bigint;
  /** A quote observed at `quoteObservedAt`. Not a guaranteed yield; it ranks, it never authorizes. */
  readonly quotedApyBps: number;
  readonly quoteObservedAt: bigint;
  readonly recipient: Identifier;
  readonly claims: Claims;
};
export type PerpOpen = {
  readonly kind: 'PERP_OPEN';
  readonly market: Identifier;
  readonly account: Identifier;
  readonly side: PerpSide;
  readonly size: bigint;
  readonly price: bigint;
  readonly initialMarginFraction: number;
  readonly claims: Claims;
};

export type ActionCandidate = Tagged<StockBuy | SwapExactIn | NftBuy | YieldDeposit | PerpOpen, 'ActionCandidate'>;

// --- Validation --------------------------------------------------------------------------

function nullableIdentifier(raw: string | null, path: string): CoreResult<Identifier | null> {
  if (raw === null) return ok(null);
  return parseIdentifierAs(raw, path);
}

export function validateClaims(input: ClaimsInput, path: string): CoreResult<Claims> {
  const shape = checkFields(input, ['ticker', 'displayName', 'issuer', 'asset'], path);
  if (!shape.ok) return shape;
  const ticker = nullableIdentifier(input.ticker, at(path, 'ticker'));
  if (!ticker.ok) return ticker;
  const displayName = nullableIdentifier(input.displayName, at(path, 'displayName'));
  if (!displayName.ok) return displayName;
  const issuer = nullableIdentifier(input.issuer, at(path, 'issuer'));
  if (!issuer.ok) return issuer;
  let asset: CanonicalAssetId | null = null;
  if (input.asset !== null) {
    const a = validateCanonicalAsset(input.asset, at(path, 'asset'));
    if (!a.ok) return a;
    asset = a.value;
  }
  return ok({ ticker: ticker.value, displayName: displayName.value, issuer: issuer.value, asset } as Claims);
}

/** A positive amount that fits the uint256 the enforcement points use. Zero is not an action. */
function positive(raw: IntegerInput, path: string): CoreResult<bigint> {
  const v = parseInteger(raw, path);
  if (!v.ok) return v;
  if (v.value <= 0n || v.value > UINT256_MAX) return fail('INTEGER_OUT_OF_RANGE', path);
  return v;
}

function unsigned(raw: IntegerInput, path: string): CoreResult<bigint> {
  const v = parseInteger(raw, path);
  if (!v.ok) return v;
  if (v.value < 0n || v.value > UINT256_MAX) return fail('INTEGER_OUT_OF_RANGE', path);
  return v;
}

const FIELDS: { readonly [K in ActionKind]: readonly string[] } = {
  STOCK_BUY: ['kind', 'representation', 'account', 'quantity', 'claims'],
  SWAP_EXACT_IN: ['kind', 'router', 'route', 'tokenIn', 'tokenOut', 'amountIn', 'quotedOut', 'minOut', 'quoteObservedAt', 'recipient', 'claims'],
  NFT_BUY: ['kind', 'marketplace', 'collection', 'tokenId', 'maxPrice', 'recipient', 'claims'],
  YIELD_DEPOSIT: ['kind', 'product', 'amount', 'quotedApyBps', 'quoteObservedAt', 'recipient', 'claims'],
  PERP_OPEN: ['kind', 'market', 'account', 'side', 'size', 'price', 'initialMarginFraction', 'claims'],
};

export function validateActionCandidate(input: ActionCandidateInput, path = 'candidate'): CoreResult<ActionCandidate> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('WRONG_TYPE', path);
  const kind = parseEnum(input.kind, ACTION_KINDS, at(path, 'kind'));
  if (!kind.ok) return kind;
  const shape = checkFields(input, FIELDS[kind.value], path);
  if (!shape.ok) return shape;
  const claims = validateClaims(input.claims, at(path, 'claims'));
  if (!claims.ok) return claims;
  const id = (raw: string, field: string) => parseIdentifierAs(raw, at(path, field));
  switch (input.kind) {
    case 'STOCK_BUY': {
      const representation = id(input.representation, 'representation');
      if (!representation.ok) return representation;
      const account = id(input.account, 'account');
      if (!account.ok) return account;
      const quantity = positive(input.quantity, at(path, 'quantity'));
      if (!quantity.ok) return quantity;
      return ok({ kind: 'STOCK_BUY', representation: representation.value, account: account.value, quantity: quantity.value, claims: claims.value } as ActionCandidate);
    }
    case 'SWAP_EXACT_IN': {
      const router = id(input.router, 'router');
      if (!router.ok) return router;
      const arr = checkArray(input.route, MAX_ROUTE_HOPS, at(path, 'route'));
      if (!arr.ok) return arr;
      if (input.route.length === 0) return fail('COLLECTION_EMPTY', at(path, 'route'));
      const route: Identifier[] = [];
      for (let i = 0; i < input.route.length; i += 1) {
        const hop = parseIdentifierAs(input.route[i] as string, at(at(path, 'route'), i));
        if (!hop.ok) return hop;
        route.push(hop.value);
      }
      const tokenIn = id(input.tokenIn, 'tokenIn');
      if (!tokenIn.ok) return tokenIn;
      const tokenOut = id(input.tokenOut, 'tokenOut');
      if (!tokenOut.ok) return tokenOut;
      const amountIn = positive(input.amountIn, at(path, 'amountIn'));
      if (!amountIn.ok) return amountIn;
      const quotedOut = positive(input.quotedOut, at(path, 'quotedOut'));
      if (!quotedOut.ok) return quotedOut;
      const minOut = unsigned(input.minOut, at(path, 'minOut'));
      if (!minOut.ok) return minOut;
      // A minimum above the quote is not a slippage bound, it is an order the quote cannot fill.
      if (minOut.value > quotedOut.value) return fail('INTEGER_OUT_OF_RANGE', at(path, 'minOut'));
      const observed = parseUnixSeconds(input.quoteObservedAt, at(path, 'quoteObservedAt'));
      if (!observed.ok) return observed;
      const recipient = id(input.recipient, 'recipient');
      if (!recipient.ok) return recipient;
      const swap: SwapExactIn = {
        kind: 'SWAP_EXACT_IN',
        router: router.value,
        route,
        tokenIn: tokenIn.value,
        tokenOut: tokenOut.value,
        amountIn: amountIn.value,
        quotedOut: quotedOut.value,
        minOut: minOut.value,
        quoteObservedAt: observed.value,
        recipient: recipient.value,
        claims: claims.value,
      };
      return ok(swap as ActionCandidate);
    }
    case 'NFT_BUY': {
      const marketplace = id(input.marketplace, 'marketplace');
      if (!marketplace.ok) return marketplace;
      const collection = id(input.collection, 'collection');
      if (!collection.ok) return collection;
      const tokenId = unsigned(input.tokenId, at(path, 'tokenId'));
      if (!tokenId.ok) return tokenId;
      const maxPrice = positive(input.maxPrice, at(path, 'maxPrice'));
      if (!maxPrice.ok) return maxPrice;
      const recipient = id(input.recipient, 'recipient');
      if (!recipient.ok) return recipient;
      return ok({ kind: 'NFT_BUY', marketplace: marketplace.value, collection: collection.value, tokenId: tokenId.value, maxPrice: maxPrice.value, recipient: recipient.value, claims: claims.value } as ActionCandidate);
    }
    case 'YIELD_DEPOSIT': {
      const product = id(input.product, 'product');
      if (!product.ok) return product;
      const amount = positive(input.amount, at(path, 'amount'));
      if (!amount.ok) return amount;
      const apy = parseSmallUint(input.quotedApyBps, 1_000_000, at(path, 'quotedApyBps'));
      if (!apy.ok) return apy;
      const observed = parseUnixSeconds(input.quoteObservedAt, at(path, 'quoteObservedAt'));
      if (!observed.ok) return observed;
      const recipient = id(input.recipient, 'recipient');
      if (!recipient.ok) return recipient;
      return ok({ kind: 'YIELD_DEPOSIT', product: product.value, amount: amount.value, quotedApyBps: apy.value, quoteObservedAt: observed.value, recipient: recipient.value, claims: claims.value } as ActionCandidate);
    }
    case 'PERP_OPEN': {
      const market = id(input.market, 'market');
      if (!market.ok) return market;
      const account = id(input.account, 'account');
      if (!account.ok) return account;
      const side = parseEnum(input.side, PERP_SIDES, at(path, 'side'));
      if (!side.ok) return side;
      const size = positive(input.size, at(path, 'size'));
      if (!size.ok) return size;
      const price = positive(input.price, at(path, 'price'));
      if (!price.ok) return price;
      const imf = parseSmallUint(input.initialMarginFraction, 10_000, at(path, 'initialMarginFraction'));
      if (!imf.ok) return imf;
      if (imf.value === 0) return fail('INTEGER_OUT_OF_RANGE', at(path, 'initialMarginFraction'));
      return ok({ kind: 'PERP_OPEN', market: market.value, account: account.value, side: side.value, size: size.value, price: price.value, initialMarginFraction: imf.value, claims: claims.value } as ActionCandidate);
    }
  }
}

// --- Encoding ------------------------------------------------------------------------------

function writeClaims(w: ByteWriter, c: Claims): void {
  writeNullable(w, c.ticker, (x, v) => x.str(v));
  writeNullable(w, c.displayName, (x, v) => x.str(v));
  writeNullable(w, c.issuer, (x, v) => x.str(v));
  writeNullable(w, c.asset, writeCanonicalAsset);
}

function readClaimsInput(r: CoreReader): ClaimsInput {
  const ticker = readNullable(r, (x) => x.str());
  const displayName = readNullable(r, (x) => x.str());
  const issuer = readNullable(r, (x) => x.str());
  const asset = readNullable(r, readCanonicalAssetInput);
  return { ticker, displayName, issuer, asset };
}

/** The candidate body, as embedded in a proposal and a child authorization. */
export function writeActionCandidate(w: ByteWriter, c: ActionCandidate): void {
  writeCode(w, ACTION_KIND_CODE, c.kind);
  switch (c.kind) {
    case 'STOCK_BUY':
      w.str(c.representation).str(c.account).u256(c.quantity);
      break;
    case 'SWAP_EXACT_IN':
      w.str(c.router).u16(c.route.length);
      for (const hop of c.route) w.str(hop);
      w.str(c.tokenIn).str(c.tokenOut).u256(c.amountIn).u256(c.quotedOut).u256(c.minOut).i64(c.quoteObservedAt).str(c.recipient);
      break;
    case 'NFT_BUY':
      w.str(c.marketplace).str(c.collection).u256(c.tokenId).u256(c.maxPrice).str(c.recipient);
      break;
    case 'YIELD_DEPOSIT':
      w.str(c.product).u256(c.amount).u32(c.quotedApyBps).i64(c.quoteObservedAt).str(c.recipient);
      break;
    case 'PERP_OPEN':
      w.str(c.market).str(c.account);
      writeCode(w, PERP_SIDE_CODE, c.side);
      w.u256(c.size).u256(c.price).u16(c.initialMarginFraction);
      break;
  }
  writeClaims(w, c.claims);
}

export function readActionCandidateInput(r: CoreReader): ActionCandidateInput {
  const kind = readCode(r, ACTION_KIND_CODE);
  switch (kind) {
    case 'STOCK_BUY': {
      const representation = r.str();
      const account = r.str();
      const quantity = r.u256();
      return { kind, representation, account, quantity, claims: readClaimsInput(r) };
    }
    case 'SWAP_EXACT_IN': {
      const router = r.str();
      // A route is ordered: hops are not a set and may not be re-sorted.
      const route = r.list(MAX_ROUTE_HOPS, (x) => x.str(), false);
      const tokenIn = r.str();
      const tokenOut = r.str();
      const amountIn = r.u256();
      const quotedOut = r.u256();
      const minOut = r.u256();
      const quoteObservedAt = r.i64();
      const recipient = r.str();
      return { kind, router, route, tokenIn, tokenOut, amountIn, quotedOut, minOut, quoteObservedAt, recipient, claims: readClaimsInput(r) };
    }
    case 'NFT_BUY': {
      const marketplace = r.str();
      const collection = r.str();
      const tokenId = r.u256();
      const maxPrice = r.u256();
      const recipient = r.str();
      return { kind, marketplace, collection, tokenId, maxPrice, recipient, claims: readClaimsInput(r) };
    }
    case 'YIELD_DEPOSIT': {
      const product = r.str();
      const amount = r.u256();
      const quotedApyBps = r.u32();
      const quoteObservedAt = r.i64();
      const recipient = r.str();
      return { kind, product, amount, quotedApyBps, quoteObservedAt, recipient, claims: readClaimsInput(r) };
    }
    case 'PERP_OPEN': {
      const market = r.str();
      const account = r.str();
      const side = readCode(r, PERP_SIDE_CODE);
      const size = r.u256();
      const price = r.u256();
      const initialMarginFraction = r.u16();
      return { kind, market, account, side, size, price, initialMarginFraction, claims: readClaimsInput(r) };
    }
  }
}

export function encodeActionCandidate(c: ActionCandidate): Uint8Array {
  const w = portfolioWriter(PortfolioTag.ACTION_CANDIDATE);
  writeActionCandidate(w, c);
  return w.finish();
}

/** The `candidateReference` a proposal, a child authorization and a Core action all bind. */
export function candidateDigest(c: ActionCandidate): CandidateDigest {
  return portfolioDigest<CandidateDigest>(encodeActionCandidate(c));
}

function claimsInputOf(c: Claims): ClaimsInput {
  return { ticker: c.ticker, displayName: c.displayName, issuer: c.issuer, asset: c.asset === null ? null : { assetClass: c.asset.assetClass, idScheme: c.asset.idScheme, value: c.asset.value } };
}

export function actionCandidateInputOf(c: ActionCandidate): ActionCandidateInput {
  const claims = claimsInputOf(c.claims);
  switch (c.kind) {
    case 'STOCK_BUY':
      return { kind: c.kind, representation: c.representation, account: c.account, quantity: c.quantity, claims };
    case 'SWAP_EXACT_IN':
      return { kind: c.kind, router: c.router, route: [...c.route], tokenIn: c.tokenIn, tokenOut: c.tokenOut, amountIn: c.amountIn, quotedOut: c.quotedOut, minOut: c.minOut, quoteObservedAt: c.quoteObservedAt, recipient: c.recipient, claims };
    case 'NFT_BUY':
      return { kind: c.kind, marketplace: c.marketplace, collection: c.collection, tokenId: c.tokenId, maxPrice: c.maxPrice, recipient: c.recipient, claims };
    case 'YIELD_DEPOSIT':
      return { kind: c.kind, product: c.product, amount: c.amount, quotedApyBps: c.quotedApyBps, quoteObservedAt: c.quoteObservedAt, recipient: c.recipient, claims };
    case 'PERP_OPEN':
      return { kind: c.kind, market: c.market, account: c.account, side: c.side, size: c.size, price: c.price, initialMarginFraction: c.initialMarginFraction, claims };
  }
}
