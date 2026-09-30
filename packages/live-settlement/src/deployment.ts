/**
 * The deployed Phase 7E.3 stack, as the repository records it.
 *
 * `docs/phase-7e/deployment-manifest.json` is authoritative: it was written
 * by the deploy command from the chain itself. This module parses it —
 * nothing here is typed in by hand — and refuses anything that is not
 * exactly the Robinhood Chain testnet fixture stack: chain 46630, the gate,
 * the venue and adapter the gate created, and the two labelled fixture
 * tokens (MDEMO, MDUSD). Preflight then checks every address and code hash
 * it names against the chain.
 */

import { ADDRESS, checkReviewedMarket, type Address, type ReviewedGate, type ReviewedMarket } from '@mandate/evm-robinhood';

export const ROBINHOOD_TESTNET = 46_630n;

export interface DeployedContract {
  readonly address: Address;
  readonly runtimeCodeHash: string;
}

export interface FixtureToken extends DeployedContract {
  readonly symbol: 'MDEMO' | 'MDUSD';
  readonly name: string;
  readonly decimals: number;
}

export interface TestnetDeployment {
  readonly chainId: bigint;
  readonly networkName: string;
  /** The explorer the manifest records; transaction links are derived from it. */
  readonly explorer: string;
  readonly gate: DeployedContract & { readonly domainSeparator: string };
  readonly venue: DeployedContract;
  readonly adapter: DeployedContract;
  readonly mdemo: FixtureToken;
  readonly mdusd: FixtureToken;
  /** Public addresses of the three disposable 7E.3 keys. */
  readonly principal: Address;
  readonly agent: Address;
  readonly submitter: Address;
  readonly reviewed: ReviewedGate;
  readonly market: ReviewedMarket;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const HASH = /^0x[0-9a-f]{64}$/;

type Obj = { readonly [k: string]: unknown };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class ManifestError extends Error {}

function field(o: Obj, key: string): unknown {
  if (!(key in o)) throw new ManifestError(`MISSING:${key}`);
  return o[key];
}
function obj(o: Obj, key: string): Obj {
  const v = field(o, key);
  if (!isObj(v)) throw new ManifestError(`NOT_OBJECT:${key}`);
  return v;
}
function text(o: Obj, key: string): string {
  const v = field(o, key);
  if (typeof v !== 'string' || v === '') throw new ManifestError(`NOT_TEXT:${key}`);
  return v;
}
function addr(o: Obj, key: string): Address {
  const v = text(o, key);
  if (!ADDRESS.test(v)) throw new ManifestError(`NOT_LOWERCASE_ADDRESS:${key}`);
  return v;
}
function hash(o: Obj, key: string): string {
  const v = text(o, key);
  if (!HASH.test(v)) throw new ManifestError(`NOT_HASH:${key}`);
  return v;
}
function int(o: Obj, key: string): number {
  const v = field(o, key);
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ManifestError(`NOT_INTEGER:${key}`);
  return v;
}

function contract(o: Obj, key: string): DeployedContract {
  const c = obj(o, key);
  return { address: addr(c, 'address'), runtimeCodeHash: hash(c, 'runtimeCodeHash') };
}

function token(o: Obj, key: string, symbol: 'MDEMO' | 'MDUSD'): FixtureToken {
  const c = obj(o, key);
  const name = text(c, 'name');
  if (text(c, 'symbol') !== symbol) throw new ManifestError(`SYMBOL:${key}`);
  // The token's own name says what it is; a token that does not is not this fixture.
  if (!name.includes('TESTNET FIXTURE')) throw new ManifestError(`NOT_LABELLED_FIXTURE:${key}`);
  return { ...contract(o, key), symbol, name, decimals: int(c, 'decimals') };
}

/** The deployment a manifest records, or why it is not exactly the Robinhood Chain testnet fixture stack. */
export function parseDeployment(raw: unknown): Parsed<TestnetDeployment> {
  try {
    if (!isObj(raw)) throw new ManifestError('NOT_OBJECT');
    const network = obj(raw, 'network');
    const chainId = BigInt(int(network, 'chainId'));
    // Exactly the testnet: nothing else is ever acted on, whatever else the file might describe.
    if (chainId !== ROBINHOOD_TESTNET) return { ok: false, error: `CHAIN_NOT_ROBINHOOD_TESTNET:${chainId}` };
    const explorer = text(network, 'explorer');
    if (!/^https:\/\/[a-z0-9.-]+$/.test(explorer)) throw new ManifestError('EXPLORER_NOT_HTTPS_HOST');
    const contracts = obj(raw, 'contracts');
    const g = obj(contracts, 'mandateExecutionGate');
    const gate = { ...contract(contracts, 'mandateExecutionGate'), domainSeparator: hash(g, 'domainSeparator') };
    const venue = contract(contracts, 'fixtureVenue');
    const adapter = contract(contracts, 'fixtureVenueAdapter');
    const mdemo = token(contracts, 'mdemo', 'MDEMO');
    const mdusd = token(contracts, 'mdusd', 'MDUSD');
    const m = obj(raw, 'market');
    const asset = obj(m, 'canonicalAsset');
    const price = text(m, 'fixturePrice');
    if (!/^[1-9][0-9]{0,30}$/.test(price)) throw new ManifestError('FIXTURE_PRICE');
    const market: ReviewedMarket = {
      representation: addr(m, 'representation'),
      fundingToken: addr(m, 'fundingToken'),
      adapter: adapter.address,
      venue: venue.address,
      representationDecimals: mdemo.decimals,
      fundingDecimals: mdusd.decimals,
      canonicalAsset: { assetClass: text(asset, 'assetClass'), idScheme: text(asset, 'idScheme'), value: text(asset, 'value') },
      issuer: text(m, 'issuer'),
      venueId: text(m, 'venue'),
      quantityUnit: text(m, 'quantityUnit'),
      settlementUnit: text(m, 'settlementUnit'),
      synthetic: field(m, 'synthetic') === true,
      fixturePrice: { decimals: int(m, 'fixturePriceDecimals'), atoms: BigInt(price) },
      feeBps: int(m, 'fixtureFeeBps'),
    };
    if (market.representation !== mdemo.address || market.fundingToken !== mdusd.address) throw new ManifestError('MARKET_NOT_THE_FIXTURE_TOKENS');
    // The gate pins a fixture canonical asset for this market and says so; anything else is not this stack.
    if (market.canonicalAsset.assetClass !== 'fixture' || market.synthetic) throw new ManifestError('MARKET_NOT_A_FIXTURE');
    const bad = checkReviewedMarket(market);
    if (bad !== null) throw new ManifestError(`MARKET_${bad}`);
    return {
      ok: true,
      value: {
        chainId,
        networkName: text(network, 'name'),
        explorer,
        gate,
        venue,
        adapter,
        mdemo,
        mdusd,
        principal: addr(raw, 'principal'),
        agent: addr(raw, 'agent'),
        submitter: addr(raw, 'deployer'),
        reviewed: { chainId, gate: gate.address, markets: [market] },
        market,
      },
    };
  } catch (e) {
    if (e instanceof ManifestError) return { ok: false, error: `MANIFEST_INVALID:${e.message}` };
    throw e;
  }
}

/** `<explorer>/tx/<hash>`, from the manifest's own explorer. */
export function explorerTxUrl(d: TestnetDeployment, txHash: string): string | null {
  return HASH.test(txHash) ? `${d.explorer}/tx/${txHash}` : null;
}
