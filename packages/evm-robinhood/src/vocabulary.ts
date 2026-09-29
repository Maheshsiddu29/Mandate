/**
 * GateSpotPolicy v1's vocabulary and canonical codecs (Phase 7E.3).
 *
 * Everything here is pure: identifiers, resource ids, the typed action
 * payload the agent proposes, and the typed state payload a chain reader
 * normalizes from the deployed gate's market table.
 *
 * **Resources.** An EVM account is `eip155:<chain>:account:<address>`; a market
 * is the gate's own market key, the representation identifier
 * `eip155:<chain>/erc20:<token>` the gate hashes (execution-gate.md §3). Both
 * addresses are lowercase: the gate's encoder spells them so, and a checksum
 * variant would be a second spelling of one fact.
 */

import { ByteWriter } from '@mandate/kernel';
import {
  CoreReader,
  readResourceIdInput,
  validateResourceId,
  writeResourceId,
  type AccountId,
  type MarketId,
  type ResourceId,
  type ResourceIdInput,
  type StateKind,
  type StateSourceId,
} from '@mandate/core';

export const DOMAIN_ID = 'robinhood-evm';
export const MODULE_ID = 'gate-spot';
export const MODULE_VERSION = 1;

/** A BUY through the gate: exact quantity of one market's representation, paid in its funding token. */
export const ACTION_GATE_BUY = 'evm.gate-buy';

/** The deployed gate's market-table entry for one market, as read from the chain. */
export const STATE_GATE_MARKET = 'evm.gate-market' as StateKind;

export type Address = string;
export const ADDRESS = /^0x[0-9a-f]{40}$/;

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; path: string } }): T {
  if (!r.ok) throw new Error(`evm-robinhood constant invalid: ${r.error.code} at ${r.error.path}`);
  return r.value;
}

// --- Resources --------------------------------------------------------------------------

/** `eip155:<chain>/erc20:<token>` — the registry's and the gate's representation identifier. */
export function representationIdOf(chainId: bigint, token: Address): string {
  return `eip155:${chainId.toString(10)}/erc20:${token}`;
}

export function marketResource(chainId: bigint, representation: Address): MarketId {
  return must(validateResourceId({ domain: DOMAIN_ID, kind: 'MARKET', localId: representationIdOf(chainId, representation) }, ['MARKET'] as const, 'market'));
}

export function accountResource(chainId: bigint, address: Address): AccountId {
  return must(validateResourceId({ domain: DOMAIN_ID, kind: 'ACCOUNT', localId: `eip155:${chainId.toString(10)}:account:${address}` }, ['ACCOUNT'] as const, 'account'));
}

/** The funding token as a representation asset: what a `CAPITAL` demand is denominated in. */
export function fundingResource(chainId: bigint, token: Address): ResourceIdInput {
  return { domain: DOMAIN_ID, kind: 'REPRESENTATION_ASSET', localId: representationIdOf(chainId, token) };
}

/** `eip155:<chain>:account:<address>` → the address, or `null` (another chain, a checksum spelling, not an account). */
export function accountAddressOf(r: ResourceId, chainId: bigint): Address | null {
  const m = /^eip155:(\d+):account:(0x[0-9a-f]{40})$/.exec(r.localId);
  if (r.domain !== DOMAIN_ID || r.kind !== 'ACCOUNT' || m === null || BigInt(m[1] as string) !== chainId) return null;
  return m[2] as Address;
}

/** `eip155:<chain>/erc20:<token>` → the token, or `null`. */
export function marketTokenOf(r: ResourceId, chainId: bigint): Address | null {
  const m = /^eip155:(\d+)\/erc20:(0x[0-9a-f]{40})$/.exec(r.localId);
  if (r.domain !== DOMAIN_ID || r.kind !== 'MARKET' || m === null || BigInt(m[1] as string) !== chainId) return null;
  return m[2] as Address;
}

// --- Exact arithmetic ---------------------------------------------------------------------

export function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a + b - 1n) / b;
}

export function decodeWith<T>(bytes: Uint8Array, read: (r: CoreReader) => T): T | null {
  try {
    const r = new CoreReader(bytes);
    const v = read(r);
    r.finish();
    return v;
  } catch {
    return null;
  }
}

// --- Action payload ----------------------------------------------------------------------------

/**
 * `evm.gate-buy`: buy exactly `quantity` atoms of the market's representation
 * for the principal account. What the agent does **not** choose is absent: the
 * price (the gate's immutable fixture price), the spend cap (derived exactly
 * from it), the recipient (always the principal, which the gate requires), the
 * deadline, the gate, and every signature. Those are the adapter's, derived
 * from the authorization (gate.ts).
 */
export interface GateBuy {
  readonly account: ResourceIdInput;
  readonly market: ResourceIdInput;
  /** Representation atoms, at the market's representation decimals. */
  readonly quantity: bigint;
}

export interface DecodedBuy {
  readonly account: AccountId;
  readonly market: MarketId;
  readonly quantity: bigint;
}

const BUY_TAG = 'robinhood-evm/v1/gate-buy';

export function encodeGateBuy(b: GateBuy): Uint8Array {
  const w = new ByteWriter().str(BUY_TAG);
  writeResourceId(w, must(validateResourceId(b.account, ['ACCOUNT'] as const, 'account')));
  writeResourceId(w, must(validateResourceId(b.market, ['MARKET'] as const, 'market')));
  return w.u256(b.quantity).finish();
}

export function decodeGateBuy(bytes: Uint8Array): DecodedBuy | null {
  return decodeWith(bytes, (r) => {
    if (r.str() !== BUY_TAG) throw new Error('tag');
    const account = validateResourceId(readResourceIdInput(r), ['ACCOUNT'] as const, 'account');
    const market = validateResourceId(readResourceIdInput(r), ['MARKET'] as const, 'market');
    if (!account.ok || !market.ok) throw new Error('resource');
    return { account: account.value, market: market.value, quantity: r.u256() };
  });
}

// --- State payload ---------------------------------------------------------------------------

/**
 * One market of the deployed gate, as its `marketOf` and `fixtureVenueOf`
 * views and the created venue report it. Identifier fields are the gate's
 * keccak-256 hashes, which is what the chain stores; the policy compares them
 * with the hashes of its reviewed configuration.
 */
export interface GateMarketSnapshot {
  readonly chainId: bigint;
  readonly gate: Address;
  readonly representation: Address;
  readonly fundingToken: Address;
  readonly adapter: Address;
  readonly venue: Address;
  readonly representationDecimals: number;
  readonly fundingDecimals: number;
  readonly synthetic: boolean;
  /** 1 = FIXTURE, the only classification the frozen gate accepts. */
  readonly classification: number;
  readonly canonicalAssetHash: string;
  readonly issuerHash: string;
  readonly venueHash: string;
  readonly quantityUnitHash: string;
  readonly settlementUnitHash: string;
  readonly fixturePriceDecimals: number;
  readonly fixturePriceAtoms: bigint;
  /** The created `FixtureVenue`'s `FEE_BPS`. */
  readonly feeBps: number;
}

const MARKET_TAG = 'robinhood-evm/v1/gate-market';

function writeAddress(w: ByteWriter, a: Address): void {
  if (!ADDRESS.test(a)) throw new Error(`not a lowercase address: ${a}`);
  w.str(a);
}

function readAddress(r: CoreReader): Address {
  const a = r.str();
  if (!ADDRESS.test(a)) throw new Error('address');
  return a;
}

const HASH = /^0x[0-9a-f]{64}$/;

export function encodeGateMarket(m: GateMarketSnapshot): Uint8Array {
  const w = new ByteWriter().str(MARKET_TAG).u64(m.chainId);
  for (const a of [m.gate, m.representation, m.fundingToken, m.adapter, m.venue]) writeAddress(w, a);
  w.u8(m.representationDecimals).u8(m.fundingDecimals).u8(m.synthetic ? 1 : 0).u8(m.classification);
  for (const h of [m.canonicalAssetHash, m.issuerHash, m.venueHash, m.quantityUnitHash, m.settlementUnitHash]) {
    if (!HASH.test(h)) throw new Error(`not a hash: ${h}`);
    w.str(h);
  }
  return w.u8(m.fixturePriceDecimals).u256(m.fixturePriceAtoms).u16(m.feeBps).finish();
}

export function decodeGateMarket(bytes: Uint8Array): GateMarketSnapshot | null {
  return decodeWith(bytes, (r) => {
    if (r.str() !== MARKET_TAG) throw new Error('tag');
    const chainId = r.u64();
    const [gate, representation, fundingToken, adapter, venue] = [readAddress(r), readAddress(r), readAddress(r), readAddress(r), readAddress(r)];
    const representationDecimals = r.u8();
    const fundingDecimals = r.u8();
    const synthetic = r.u8();
    const classification = r.u8();
    const hashes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const h = r.str();
      if (!HASH.test(h)) throw new Error('hash');
      hashes.push(h);
    }
    if (synthetic > 1) throw new Error('flag');
    const [canonicalAssetHash, issuerHash, venueHash, quantityUnitHash, settlementUnitHash] = hashes as [string, string, string, string, string];
    return {
      chainId,
      gate: gate as Address,
      representation: representation as Address,
      fundingToken: fundingToken as Address,
      adapter: adapter as Address,
      venue: venue as Address,
      representationDecimals,
      fundingDecimals,
      synthetic: synthetic === 1,
      classification,
      canonicalAssetHash,
      issuerHash,
      venueHash,
      quantityUnitHash,
      settlementUnitHash,
      fixturePriceDecimals: r.u8(),
      fixturePriceAtoms: r.u256(),
      feeBps: r.u16(),
    };
  });
}

export interface SourceConfig {
  /** The chain reader that reads the gate's market table. */
  readonly gateMarket: StateSourceId;
}
