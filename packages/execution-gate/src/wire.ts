/**
 * The wire form of what the onchain gate is handed.
 *
 * `MandateExecutionGate.execute` takes a mandate and a candidate as Solidity
 * structs and re-encodes them itself. These types are those structs, field for
 * field — addresses instead of `PartyId`s, frozen wire codes instead of enum
 * names, and identifier sets in the order the caller supplies them. They are
 * not a new schema: `encodeGateMandate` writes exactly the MCE v2 bytes the
 * kernel's `encodeMandate` writes for the same object, and the gate hashes those
 * bytes.
 *
 * The one deliberate difference from the kernel encoder is that nothing here
 * sorts. The gate cannot sort without letting two calldata orderings share one
 * digest, so it encodes what it is given and refuses a non-canonical order. The
 * reference model reproduces that by handing these bytes to the kernel's
 * *decoder*, which enforces canonical order (see `model.ts`).
 */

import {
  ByteWriter,
  DomainTag,
  PARTY_KIND_EIP155_ADDRESS,
  type CanonicalMandate,
  type ExecutionCandidate,
} from '@mandate/kernel';

/** Lowercase `0x`-prefixed 20-byte address, as the gate's encoder spells it. */
export type Address = string;

export const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

/** Frozen wire codes, from `packages/kernel/src/encoding/codec.ts`. */
export const SIDE_CODE = { BUY: 1, SELL: 2 } as const;
export const SYNTHETIC_POLICY_CODE = { FORBIDDEN: 1, ALLOWED: 2 } as const;
export const HALT_POLICY_CODE = { FORBID_WHEN_HALTED: 1, ALLOW_WHEN_HALTED: 2 } as const;

/**
 * Solidity `CanonicalAsset`, `Amount` and `Price`.
 *
 * Plain strings rather than the kernel's branded identifiers: a wire value is
 * *unvalidated* by definition — the gate validates it, and so does the model.
 */
export interface GateAsset {
  readonly assetClass: string;
  readonly idScheme: string;
  readonly value: string;
}

export interface GateAmount {
  readonly unit: string;
  /** Solidity `uint8`; the kernel range is 0..38 and anything above is malformed. */
  readonly decimals: number;
  readonly atoms: bigint;
}

export interface GatePrice {
  readonly numeratorUnit: string;
  readonly denominatorUnit: string;
  readonly decimals: number;
  readonly atoms: bigint;
}

/** Solidity `Mandate`. Integers are `bigint`; codes are raw `uint8`/`uint16` values. */
export interface GateMandate {
  readonly version: bigint;
  readonly mandateId: string;
  readonly nonce: bigint;
  readonly principal: Address;
  readonly agent: Address;
  readonly canonicalAsset: GateAsset;
  readonly side: bigint;
  readonly maxNotional: GateAmount;
  readonly economicLimit: GateAmount;
  readonly maxDeviationBps: bigint;
  readonly syntheticPolicy: bigint;
  readonly allowedIssuers: readonly string[];
  readonly allowedChains: readonly string[];
  readonly allowedVenues: readonly string[];
  readonly requiredCorporateActionEpoch: bigint;
  readonly maxPriceAgeSeconds: bigint;
  readonly maxCorporateActionAgeSeconds: bigint;
  readonly haltPolicy: bigint;
  readonly createdAtUnixSeconds: bigint;
  readonly notBeforeUnixSeconds: bigint;
  readonly expiresAtUnixSeconds: bigint;
}

/** Solidity `Candidate`. */
export interface GateCandidate {
  readonly version: bigint;
  readonly representationId: string;
  readonly canonicalAsset: GateAsset;
  readonly issuer: string;
  readonly chain: string;
  readonly venue: string;
  readonly side: bigint;
  readonly agent: Address;
  readonly quantity: GateAmount;
  readonly executionPrice: GatePrice;
  readonly notional: GateAmount;
  readonly feeTotal: GateAmount;
  readonly evaluationStateId: string;
  readonly evaluationStateDigest: string;
  readonly registrySnapshotDigest: string;
  readonly corporateActionEpoch: bigint;
}

/** Solidity `ExecutionTerms`. */
export interface GateTerms {
  readonly recipient: Address;
  readonly fundingLimit: bigint;
  readonly deadline: bigint;
  /** Lowercase `0x` hex. */
  readonly executionData: string;
}

function writeAsset(w: ByteWriter, a: GateAsset): void {
  w.str(a.assetClass).str(a.idScheme).str(a.value);
}

function writeAmount(w: ByteWriter, a: GateAmount): void {
  w.str(a.unit).u8(a.decimals).u256(a.atoms);
}

function writeParty(w: ByteWriter, address: Address): void {
  w.str(PARTY_KIND_EIP155_ADDRESS).str(address);
}

/** `u16` count then each element, in the order given. */
function writeSetAsGiven(w: ByteWriter, values: readonly string[]): void {
  w.u16(values.length);
  for (const v of values) w.str(v);
}

function hexToBytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/**
 * MCE v2 bytes of a gate mandate, sets in the order given.
 *
 * Throws only where the Solidity type itself could not hold the value (a
 * `ByteWriter` range check), which means the caller built something that is not
 * a gate input at all. Structural validity is the decoder's question, not this
 * function's.
 */
export function encodeGateMandate(m: GateMandate): Uint8Array {
  const w = new ByteWriter();
  w.tag(DomainTag.MANDATE).u16(m.version);
  w.bytes32(hexToBytes32(m.mandateId));
  w.u64(m.nonce);
  writeParty(w, m.principal);
  writeParty(w, m.agent);
  writeAsset(w, m.canonicalAsset);
  w.u8(m.side);
  writeAmount(w, m.maxNotional);
  writeAmount(w, m.economicLimit);
  w.u16(m.maxDeviationBps);
  w.u8(m.syntheticPolicy);
  writeSetAsGiven(w, m.allowedIssuers);
  writeSetAsGiven(w, m.allowedChains);
  writeSetAsGiven(w, m.allowedVenues);
  w.u64(m.requiredCorporateActionEpoch);
  w.u32(m.maxPriceAgeSeconds);
  w.u32(m.maxCorporateActionAgeSeconds);
  w.u8(m.haltPolicy);
  w.i64(m.createdAtUnixSeconds);
  w.i64(m.notBeforeUnixSeconds);
  w.i64(m.expiresAtUnixSeconds);
  return w.finish();
}

/** Candidate V3 bytes of a gate candidate. */
export function encodeGateCandidate(c: GateCandidate): Uint8Array {
  const w = new ByteWriter();
  w.tag(DomainTag.CANDIDATE).u16(c.version);
  w.str(c.representationId);
  writeAsset(w, c.canonicalAsset);
  w.str(c.issuer).str(c.chain).str(c.venue);
  w.u8(c.side);
  writeParty(w, c.agent);
  writeAmount(w, c.quantity);
  w.str(c.executionPrice.numeratorUnit).str(c.executionPrice.denominatorUnit).u8(c.executionPrice.decimals).u256(c.executionPrice.atoms);
  writeAmount(w, c.notional);
  writeAmount(w, c.feeTotal);
  w.str(c.evaluationStateId);
  w.bytes32(hexToBytes32(c.evaluationStateDigest));
  w.bytes32(hexToBytes32(c.registrySnapshotDigest));
  w.u64(c.corporateActionEpoch);
  return w.finish();
}

/**
 * The gate form of a parsed kernel mandate, for a pipeline about to submit.
 *
 * Returns `undefined` for a mandate the gate cannot express: one whose principal
 * or agent is not an `eip155-address` party. Such a mandate can be verified
 * offchain but never executed through the gate, and saying so here is better
 * than failing a signature check onchain.
 */
export function toGateMandate(m: CanonicalMandate): GateMandate | undefined {
  if (m.principal.kind !== PARTY_KIND_EIP155_ADDRESS || m.agent.kind !== PARTY_KIND_EIP155_ADDRESS) return undefined;
  return {
    version: BigInt(m.version),
    mandateId: m.mandateId,
    nonce: m.nonce,
    principal: m.principal.value,
    agent: m.agent.value,
    canonicalAsset: m.canonicalAsset,
    side: BigInt(SIDE_CODE[m.side]),
    maxNotional: m.maxNotional,
    economicLimit: m.economicLimit,
    maxDeviationBps: m.maxDeviationBps,
    syntheticPolicy: BigInt(SYNTHETIC_POLICY_CODE[m.syntheticPolicy]),
    // A parsed mandate's sets are already in canonical encoded order.
    allowedIssuers: m.allowedIssuers,
    allowedChains: m.allowedChains,
    allowedVenues: m.allowedVenues,
    requiredCorporateActionEpoch: m.requiredCorporateActionEpoch,
    maxPriceAgeSeconds: m.maxPriceAgeSeconds,
    maxCorporateActionAgeSeconds: m.maxCorporateActionAgeSeconds,
    haltPolicy: BigInt(HALT_POLICY_CODE[m.haltPolicy]),
    createdAtUnixSeconds: m.createdAtUnixSeconds,
    notBeforeUnixSeconds: m.notBeforeUnixSeconds,
    expiresAtUnixSeconds: m.expiresAtUnixSeconds,
  };
}

/** The gate form of a parsed kernel candidate; `undefined` if its agent is not an EVM address. */
export function toGateCandidate(c: ExecutionCandidate): GateCandidate | undefined {
  if (c.agent.kind !== PARTY_KIND_EIP155_ADDRESS) return undefined;
  return {
    version: BigInt(c.version),
    representationId: c.representationId,
    canonicalAsset: c.canonicalAsset,
    issuer: c.issuer,
    chain: c.chain,
    venue: c.venue,
    side: BigInt(SIDE_CODE[c.side]),
    agent: c.agent.value,
    quantity: c.quantity,
    executionPrice: c.executionPrice,
    notional: c.notional,
    feeTotal: c.feeTotal,
    evaluationStateId: c.evaluationStateId,
    evaluationStateDigest: c.evaluationStateDigest,
    registrySnapshotDigest: c.registrySnapshotDigest,
    corporateActionEpoch: c.corporateActionEpoch,
  };
}
