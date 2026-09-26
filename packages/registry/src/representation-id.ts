/**
 * Representation identity: one concrete tokenized instrument (design section 5.3).
 *
 * CAIP-19 shaped, and the same string form the kernel already carries as an
 * opaque identifier:
 *
 * ```
 * eip155:42161/erc20:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
 * ```
 *
 * Three rules, each of which exists because the alternative has a failure mode:
 *
 * - **`ticker + chain` is not identity** and is not accepted as one. Two tokens on
 *   one chain can carry one symbol, and one of them can be a counterfeit.
 * - **Chain identity comes from a chain id**, never an RPC URL, hostname or
 *   network name. An endpoint is a data source and can lie about which network it
 *   serves.
 * - **A contract address is validated, then canonicalized.** A mixed-case address
 *   is accepted only if its EIP-55 checksum verifies; an all-lowercase address is
 *   accepted as already canonical. A failing checksum is a rejection, never a
 *   repair — which is the kernel's rule about not repairing identifiers, applied
 *   to the one identifier where an actual integrity check exists.
 */

import { err, keccak256, ok, parseIdentifier, type ChainId, type Identifier, type Result } from '@mandate/kernel';
import type { RegistryReasonCodeName } from './reason-codes.ts';

/**
 * Chain namespaces this registry implements. Closed: an unrecognized namespace is
 * one whose address format and checksum rules are unknown, so it fails closed
 * rather than being stored unvalidated.
 */
export const ChainNamespace = { EIP155: 'eip155' } as const;
export type ChainNamespace = (typeof ChainNamespace)[keyof typeof ChainNamespace];

/** Token standards this registry implements. Closed for the same reason. */
export const AssetNamespace = { ERC20: 'erc20' } as const;
export type AssetNamespace = (typeof AssetNamespace)[keyof typeof AssetNamespace];

declare const ContractAddressBrand: unique symbol;
/** Lowercase, `0x`-prefixed, 20 bytes. The canonical form; never mixed case. */
export type ContractAddress = string & { readonly [ContractAddressBrand]: true };

const LOWER_ADDRESS = /^0x[0-9a-f]{40}$/;
const ANY_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CHAIN_REFERENCE = /^[1-9][0-9]{0,31}$/;

const encoder = new TextEncoder();

/**
 * EIP-55 checksum verification.
 *
 * The checksum is over the lowercase hex body: a hex letter is upper-case exactly
 * where the corresponding nibble of `keccak256(ascii(body))` is 8 or above.
 */
function hasValidEip55Checksum(address: string): boolean {
  const body = address.slice(2);
  const lower = body.toLowerCase();
  const hash = keccak256(encoder.encode(lower)).slice(2);
  for (let i = 0; i < 40; i += 1) {
    const c = body[i] as string;
    if (c >= '0' && c <= '9') continue;
    const nibble = Number.parseInt(hash[i] as string, 16);
    const shouldBeUpper = nibble >= 8;
    const isUpper = c >= 'A' && c <= 'F';
    if (shouldBeUpper !== isUpper) return false;
  }
  return true;
}

/**
 * Parse and canonicalize a contract address.
 *
 * An all-lowercase address carries no checksum information and is accepted as the
 * canonical form. Anything with an upper-case hex letter is claiming a checksum,
 * and that claim is verified rather than discarded: discarding it would throw away
 * the one integrity check on the single most dangerous value in the system.
 */
export function parseContractAddress(raw: unknown): Result<ContractAddress, RegistryReasonCodeName> {
  if (typeof raw !== 'string' || !ANY_ADDRESS.test(raw)) return err('REPRESENTATION_ID_MALFORMED');
  if (LOWER_ADDRESS.test(raw)) return ok(raw as ContractAddress);
  if (!hasValidEip55Checksum(raw)) return err('REPRESENTATION_ID_MALFORMED');
  return ok(raw.toLowerCase() as ContractAddress);
}

/**
 * A representation's identity.
 *
 * `value` is the canonical string form, and is what the kernel receives as its
 * opaque `RepresentationId`. The structured fields exist so the registry can
 * validate and index without the kernel ever having to parse an address.
 */
export interface RepresentationId {
  readonly chainNamespace: ChainNamespace;
  readonly chainReference: string;
  /** `eip155:42161` — the kernel's chain vocabulary, and what a mandate allowlists. */
  readonly chain: ChainId;
  readonly assetNamespace: AssetNamespace;
  readonly contractAddress: ContractAddress;
  /** `eip155:42161/erc20:0x…` — canonical, lowercase, and an `Identifier` to the kernel. */
  readonly value: Identifier;
}

function buildId(
  chainNamespace: ChainNamespace,
  chainReference: string,
  assetNamespace: AssetNamespace,
  contractAddress: ContractAddress,
): Result<RepresentationId, RegistryReasonCodeName> {
  const chainString = `${chainNamespace}:${chainReference}`;
  const value = `${chainString}/${assetNamespace}:${contractAddress}`;
  // Re-parsed through the kernel's own identifier rules, so a representation id
  // the registry produces is one the kernel will accept without a second,
  // weaker validation path.
  const chain = parseIdentifier(chainString);
  if (!chain.ok) return err('REPRESENTATION_ID_MALFORMED');
  const identifier = parseIdentifier(value);
  if (!identifier.ok) return err('REPRESENTATION_ID_MALFORMED');
  return ok({
    chainNamespace,
    chainReference,
    chain: chain.value,
    assetNamespace,
    contractAddress,
    value: identifier.value,
  });
}

/**
 * Parse a representation identifier from its string form or its structured form.
 *
 * Total, and strict about shape: an identifier that does not have exactly one `/`
 * and exactly one `:` on each side is rejected rather than having a segment
 * discarded to make it parse.
 */
export function parseRepresentationId(raw: unknown): Result<RepresentationId, RegistryReasonCodeName> {
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as Record<string, unknown>;
    for (const k of Object.keys(r)) {
      if (!['chainNamespace', 'chainReference', 'chain', 'assetNamespace', 'contractAddress', 'value'].includes(k)) {
        return err('REPRESENTATION_ID_MALFORMED');
      }
    }
    const chainNamespace = r['chainNamespace'];
    const assetNamespace = r['assetNamespace'];
    const chainReference = r['chainReference'];
    if (chainNamespace !== ChainNamespace.EIP155) return err('REPRESENTATION_ID_MALFORMED');
    if (assetNamespace !== AssetNamespace.ERC20) return err('REPRESENTATION_ID_MALFORMED');
    if (typeof chainReference !== 'string' || !CHAIN_REFERENCE.test(chainReference)) {
      return err('REPRESENTATION_ID_MALFORMED');
    }
    const address = parseContractAddress(r['contractAddress']);
    if (!address.ok) return address;
    const built = buildId(ChainNamespace.EIP155, chainReference, AssetNamespace.ERC20, address.value);
    if (!built.ok) return built;
    // Parsed identifiers carry two derived fields. Accepting a parsed snapshot
    // is safe only when callers cannot contradict those derivations.
    if (r['chain'] !== undefined && r['chain'] !== built.value.chain) return err('REPRESENTATION_ID_MALFORMED');
    if (r['value'] !== undefined && r['value'] !== built.value.value) return err('REPRESENTATION_ID_MALFORMED');
    return built;
  }

  if (typeof raw !== 'string') return err('REPRESENTATION_ID_MALFORMED');
  const slashParts = raw.split('/');
  if (slashParts.length !== 2) return err('REPRESENTATION_ID_MALFORMED');
  const chainParts = (slashParts[0] as string).split(':');
  const assetParts = (slashParts[1] as string).split(':');
  if (chainParts.length !== 2 || assetParts.length !== 2) return err('REPRESENTATION_ID_MALFORMED');

  if (chainParts[0] !== ChainNamespace.EIP155) return err('REPRESENTATION_ID_MALFORMED');
  if (assetParts[0] !== AssetNamespace.ERC20) return err('REPRESENTATION_ID_MALFORMED');
  const chainReference = chainParts[1] as string;
  if (!CHAIN_REFERENCE.test(chainReference)) return err('REPRESENTATION_ID_MALFORMED');
  const address = parseContractAddress(assetParts[1]);
  if (!address.ok) return address;
  return buildId(ChainNamespace.EIP155, chainReference, AssetNamespace.ERC20, address.value);
}

export function representationIdEquals(a: RepresentationId, b: RepresentationId): boolean {
  return a.value === b.value;
}

/**
 * Sort order for representation identifiers: by encoded byte order, matching the
 * kernel's `compareIdentifierBytes` (length first, then content), so registry and
 * kernel orderings agree.
 */
export function compareRepresentationIds(a: RepresentationId, b: RepresentationId): number {
  if (a.value.length !== b.value.length) return a.value.length < b.value.length ? -1 : 1;
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}
