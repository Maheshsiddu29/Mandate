/**
 * Deterministic identifiers shared by Core tests.
 *
 * Every digest here is keccak-256 of a readable label, so a fixture's
 * provenance is visible in the source and no value is random. Venue names are
 * placeholders ("venue L", "venue M"), as in examples.md; nothing here is a
 * claim about any real venue, token or module.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  bytesToHex,
  type AdapterRefInput,
  type CoreResult,
  type ModuleRefInput,
  type PartyIdInput,
  type ResourceIdInput,
} from '../../src/index.ts';

const utf8 = new TextEncoder();

/** keccak-256 of a label, as a Core digest string. */
export function digestOf(label: string): string {
  return bytesToHex(keccak_256(utf8.encode(label)));
}

/** Unwrap a Core result in a test, failing loudly with the structured error. */
export function must<T>(r: CoreResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code} at ${r.error.path}`);
  return r.value;
}

function address(byte: string): PartyIdInput {
  return { kind: 'eip155-address', value: `0x${byte.repeat(20)}` };
}

// --- Parties ---------------------------------------------------------------------

export const PRINCIPAL = address('11');
export const PRINCIPAL_2 = address('12');
export const TRADING_AGENT = address('21');
export const PERP_AGENT = address('22');
export const SPOT_AGENT = address('23');

// --- Modules and adapters --------------------------------------------------------

export const PERP_V1: ModuleRefInput = { domainId: 'perp', moduleId: 'perp-policy', moduleVersion: 1, moduleDigest: digestOf('manifest:perp-policy:1') };
export const PERP_V2: ModuleRefInput = { domainId: 'perp', moduleId: 'perp-policy', moduleVersion: 2, moduleDigest: digestOf('manifest:perp-policy:2') };
export const EVM_SPOT_V1: ModuleRefInput = { domainId: 'evm-spot', moduleId: 'evm-spot', moduleVersion: 1, moduleDigest: digestOf('manifest:evm-spot:1') };

export const VENUE_SIGNER_L: AdapterRefInput = { adapterId: 'venue-signer-l', adapterVersion: 1, adapterDigest: digestOf('adapter:venue-signer-l:1') };
export const VENUE_SIGNER_M: AdapterRefInput = { adapterId: 'venue-signer-m', adapterVersion: 1, adapterDigest: digestOf('adapter:venue-signer-m:1') };
export const EVM_GATE: AdapterRefInput = { adapterId: 'evm-gate', adapterVersion: 1, adapterDigest: digestOf('adapter:evm-gate:1') };

export const PERP_V1_IMPL = digestOf('implementation:perp-policy:1:a');
export const PERP_V2_IMPL = digestOf('implementation:perp-policy:2:a');
export const EVM_SPOT_IMPL = digestOf('implementation:evm-spot:1:a');

// --- Resources -------------------------------------------------------------------

export const BTC: ResourceIdInput = { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:btc' };
export const AAPL: ResourceIdInput = { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'equity:figi:BBG000B9XRY4' };
export const USDG: ResourceIdInput = { domain: 'evm-spot', kind: 'REPRESENTATION_ASSET', localId: 'arbitrum:erc20:usdg' };
export const USDG_ON_L: ResourceIdInput = { domain: 'perp', kind: 'REPRESENTATION_ASSET', localId: 'venue-l:collateral:usdg' };
export const FAAPL: ResourceIdInput = { domain: 'evm-spot', kind: 'REPRESENTATION_ASSET', localId: 'arbitrum:erc20:faapl' };
export const BTC_PERP_L: ResourceIdInput = { domain: 'perp', kind: 'MARKET', localId: 'venue-l:BTC-PERP' };
export const BTC_PERP_M: ResourceIdInput = { domain: 'perp', kind: 'MARKET', localId: 'venue-m:BTC-PERP' };
export const ETH_PERP_L: ResourceIdInput = { domain: 'perp', kind: 'MARKET', localId: 'venue-l:ETH-PERP' };
export const SOL_PERP_L: ResourceIdInput = { domain: 'perp', kind: 'MARKET', localId: 'venue-l:SOL-PERP' };
export const FAAPL_MARKET: ResourceIdInput = { domain: 'evm-spot', kind: 'MARKET', localId: 'fixture:fAAPL' };
export const L_SUB: ResourceIdInput = { domain: 'perp', kind: 'ACCOUNT', localId: 'venue-l:sub-1' };
export const EVM_ACCOUNT: ResourceIdInput = { domain: 'evm-spot', kind: 'ACCOUNT', localId: 'arbitrum:0x1111111111111111111111111111111111111111' };
export const EXTERNAL_X: ResourceIdInput = { domain: 'evm-spot', kind: 'RECIPIENT', localId: 'arbitrum:0x9999999999999999999999999999999999999999' };
