/**
 * The canonical mandate: a bounded, machine-readable financial authorization
 * (design section 7).
 *
 * Four rules shape this type and none of them is negotiable for convenience:
 *
 * - **No contract addresses.** A mandate names a canonical asset, never a
 *   token. If it named a token, a compromised authoring path could redirect
 *   funds while producing a perfectly valid mandate (design section 7.4,
 *   rule 4).
 * - **No free text.** Nothing here requires the verifier to interpret prose.
 * - **Allowlists are closed.** An empty allowlist permits nothing. It is never
 *   read as "unconstrained", so adding a field cannot widen the authority of a
 *   mandate signed before the field existed.
 * - **Bounded validity is mandatory.** There is no "until revoked" mandate,
 *   because there is no revocation infrastructure to make one safe.
 *
 * The field set is the Phase 1 / MVP set from design section 7.3. Fields marked
 * long-term there are deliberately absent: every field below has a verifier
 * check that reads it.
 */

import { type Result, ok, err } from './result.ts';
import type { ReasonCodeName } from './reason-codes.ts';
import {
  parseIdentifier,
  parseCanonicalAssetId,
  type CanonicalAssetId,
  type ChainId,
  type Identifier,
  type IssuerId,
  type VenueId,
} from './identifiers.ts';
import { parseAmount, type Amount } from './units.ts';
import { parseBigInt, parseDurationSeconds, parseUnixSeconds, type UnixSeconds } from './time.ts';
import { parseBytes32, type Bytes32 } from './bytes.ts';
import { compareIdentifierBytes } from './encoding/writer.ts';

export const MANDATE_SCHEMA_VERSION = 1;

export const Side = { BUY: 'BUY', SELL: 'SELL' } as const;
export type Side = (typeof Side)[keyof typeof Side];

export const SyntheticPolicy = {
  /** Synthetic exposure is refused. The headline MVP constraint. */
  FORBIDDEN: 'FORBIDDEN',
  ALLOWED: 'ALLOWED',
} as const;
export type SyntheticPolicy = (typeof SyntheticPolicy)[keyof typeof SyntheticPolicy];

export const HaltPolicy = {
  FORBID_WHEN_HALTED: 'FORBID_WHEN_HALTED',
  ALLOW_WHEN_HALTED: 'ALLOW_WHEN_HALTED',
} as const;
export type HaltPolicy = (typeof HaltPolicy)[keyof typeof HaltPolicy];

/**
 * A party, in a scheme-neutral form.
 *
 * `kind` names the identity scheme (`eip155-address` for the Phase 1 EVM path);
 * `value` is that scheme's identifier. Keeping it neutral is what lets the
 * mandate digest stay chain-agnostic while the authorization envelope stays
 * EVM-specific (ADR 0001). Nothing outside the authorization layer interprets
 * `kind`.
 */
export interface PartyId {
  readonly kind: Identifier;
  readonly value: Identifier;
}

export const PARTY_KIND_EIP155_ADDRESS = 'eip155-address';

export function parsePartyId(raw: unknown, code: ReasonCodeName): Result<PartyId, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err(code);
  const r = raw as Record<string, unknown>;
  const kind = parseIdentifier(r['kind']);
  if (!kind.ok) return kind;
  const value = parseIdentifier(r['value']);
  if (!value.ok) return value;
  // A scheme the kernel knows gets its shape enforced here rather than only at
  // signature time, so a malformed address is a structural rejection.
  if (kind.value === PARTY_KIND_EIP155_ADDRESS && !/^0x[0-9a-f]{40}$/.test(value.value)) {
    return err('MALFORMED_IDENTIFIER');
  }
  return ok({ kind: kind.value, value: value.value });
}

export function partyIdEquals(a: PartyId, b: PartyId): boolean {
  return a.kind === b.kind && a.value === b.value;
}

export interface CanonicalMandate {
  readonly version: number;
  /** Opaque 32-byte caller-chosen identifier. Not the replay key; see docs/replay-semantics.md. */
  readonly mandateId: Bytes32;
  readonly nonce: bigint;

  readonly principal: PartyId;
  readonly agent: PartyId;

  readonly canonicalAsset: CanonicalAssetId;
  readonly side: Side;

  readonly maxNotional: Amount;
  readonly maxDeviationBps: bigint;

  readonly syntheticPolicy: SyntheticPolicy;
  readonly allowedIssuers: readonly IssuerId[];
  readonly allowedChains: readonly ChainId[];
  readonly allowedVenues: readonly VenueId[];

  readonly requiredCorporateActionEpoch: bigint;
  readonly maxPriceAgeSeconds: bigint;
  readonly haltPolicy: HaltPolicy;

  readonly createdAtUnixSeconds: UnixSeconds;
  readonly notBeforeUnixSeconds: UnixSeconds;
  readonly expiresAtUnixSeconds: UnixSeconds;
}

export const UINT16_MAX = 2n ** 16n - 1n;
export const UINT64_MAX = 2n ** 64n - 1n;
export const MAX_SET_SIZE = 1024;

function parseIdentifierSet(raw: unknown, code: ReasonCodeName): Result<readonly Identifier[], ReasonCodeName> {
  if (!Array.isArray(raw)) return err(code);
  if (raw.length > MAX_SET_SIZE) return err('VALUE_OUT_OF_RANGE');
  const out: Identifier[] = [];
  for (const entry of raw) {
    const id = parseIdentifier(entry);
    if (!id.ok) return id;
    out.push(id.value);
  }
  // Duplicates reject rather than collapse: a caller that submitted one did not
  // build the object it believed it built, and silently repairing it hides that.
  if (new Set(out).size !== out.length) return err(code);
  // Sorted at parse time, by the same rule the encoder uses, so the encoding is
  // canonical regardless of authoring order and a round-trip preserves order.
  out.sort(compareIdentifierBytes);
  return ok(out);
}

function parseBoundedUint(raw: unknown, max: bigint, code: ReasonCodeName): Result<bigint, ReasonCodeName> {
  const v = parseBigInt(raw);
  if (v === undefined) return err(code);
  if (v < 0n || v > max) return err('VALUE_OUT_OF_RANGE');
  return ok(v);
}

function parseEnum<T extends string>(raw: unknown, values: Record<string, T>, code: ReasonCodeName): Result<T, ReasonCodeName> {
  if (typeof raw !== 'string' || !Object.prototype.hasOwnProperty.call(values, raw)) return err(code);
  return ok(values[raw] as T);
}

/**
 * Strict structural parse. Total: every input yields a `Result`, never a throw.
 *
 * Unknown top-level keys reject. A verifier that ignored an unrecognized field
 * would let a caller attach meaning the verifier does not enforce, which is the
 * same failure as interpreting an unknown version leniently.
 */
export function parseMandate(raw: unknown): Result<CanonicalMandate, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_MANDATE');
  const r = raw as Record<string, unknown>;

  const version = r['version'];
  if (typeof version !== 'number' || !Number.isInteger(version)) return err('MALFORMED_MANDATE');
  if (version !== MANDATE_SCHEMA_VERSION) return err('UNSUPPORTED_MANDATE_VERSION');

  const known = new Set<string>(MANDATE_FIELDS);
  for (const key of Object.keys(r)) if (!known.has(key)) return err('MALFORMED_MANDATE');

  const mandateId = parseBytes32(r['mandateId'], 'MALFORMED_MANDATE');
  if (!mandateId.ok) return mandateId;
  const nonce = parseBoundedUint(r['nonce'], UINT64_MAX, 'MALFORMED_MANDATE');
  if (!nonce.ok) return nonce;
  const principal = parsePartyId(r['principal'], 'MALFORMED_MANDATE');
  if (!principal.ok) return principal;
  const agent = parsePartyId(r['agent'], 'MALFORMED_MANDATE');
  if (!agent.ok) return agent;
  const canonicalAsset = parseCanonicalAssetId(r['canonicalAsset']);
  if (!canonicalAsset.ok) return canonicalAsset;
  const side = parseEnum(r['side'], Side, 'MALFORMED_MANDATE');
  if (!side.ok) return side;
  const maxNotional = parseAmount(r['maxNotional']);
  if (!maxNotional.ok) return maxNotional;
  const maxDeviationBps = parseBoundedUint(r['maxDeviationBps'], UINT16_MAX, 'MALFORMED_MANDATE');
  if (!maxDeviationBps.ok) return maxDeviationBps;
  const syntheticPolicy = parseEnum(r['syntheticPolicy'], SyntheticPolicy, 'MALFORMED_MANDATE');
  if (!syntheticPolicy.ok) return syntheticPolicy;
  const allowedIssuers = parseIdentifierSet(r['allowedIssuers'], 'MALFORMED_MANDATE');
  if (!allowedIssuers.ok) return allowedIssuers;
  const allowedChains = parseIdentifierSet(r['allowedChains'], 'MALFORMED_MANDATE');
  if (!allowedChains.ok) return allowedChains;
  const allowedVenues = parseIdentifierSet(r['allowedVenues'], 'MALFORMED_MANDATE');
  if (!allowedVenues.ok) return allowedVenues;
  const requiredCorporateActionEpoch = parseBoundedUint(r['requiredCorporateActionEpoch'], UINT64_MAX, 'MALFORMED_MANDATE');
  if (!requiredCorporateActionEpoch.ok) return requiredCorporateActionEpoch;
  const maxPriceAgeSeconds = parseDurationSeconds(r['maxPriceAgeSeconds'], 'MALFORMED_MANDATE');
  if (!maxPriceAgeSeconds.ok) return maxPriceAgeSeconds;
  const haltPolicy = parseEnum(r['haltPolicy'], HaltPolicy, 'MALFORMED_MANDATE');
  if (!haltPolicy.ok) return haltPolicy;
  const createdAt = parseUnixSeconds(r['createdAtUnixSeconds'], 'MALFORMED_MANDATE');
  if (!createdAt.ok) return createdAt;
  const notBefore = parseUnixSeconds(r['notBeforeUnixSeconds'], 'MALFORMED_MANDATE');
  if (!notBefore.ok) return notBefore;
  const expiresAt = parseUnixSeconds(r['expiresAtUnixSeconds'], 'MALFORMED_MANDATE');
  if (!expiresAt.ok) return expiresAt;

  // A validity window that is empty or inverted is not a mandate that merely
  // never passes; it is a malformed authorization, and saying so is more useful
  // than reporting MANDATE_EXPIRED at every evaluation time.
  if (notBefore.value >= expiresAt.value) return err('MALFORMED_MANDATE');

  return ok({
    version,
    mandateId: mandateId.value,
    nonce: nonce.value,
    principal: principal.value,
    agent: agent.value,
    canonicalAsset: canonicalAsset.value,
    side: side.value,
    maxNotional: maxNotional.value,
    maxDeviationBps: maxDeviationBps.value,
    syntheticPolicy: syntheticPolicy.value,
    allowedIssuers: allowedIssuers.value,
    allowedChains: allowedChains.value,
    allowedVenues: allowedVenues.value,
    requiredCorporateActionEpoch: requiredCorporateActionEpoch.value,
    maxPriceAgeSeconds: maxPriceAgeSeconds.value,
    haltPolicy: haltPolicy.value,
    createdAtUnixSeconds: createdAt.value,
    notBeforeUnixSeconds: notBefore.value,
    expiresAtUnixSeconds: expiresAt.value,
  });
}

export const MANDATE_FIELDS = [
  'version',
  'mandateId',
  'nonce',
  'principal',
  'agent',
  'canonicalAsset',
  'side',
  'maxNotional',
  'maxDeviationBps',
  'syntheticPolicy',
  'allowedIssuers',
  'allowedChains',
  'allowedVenues',
  'requiredCorporateActionEpoch',
  'maxPriceAgeSeconds',
  'haltPolicy',
  'createdAtUnixSeconds',
  'notBeforeUnixSeconds',
  'expiresAtUnixSeconds',
] as const;
