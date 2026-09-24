/**
 * Representation semantics: the vocabularies that describe what a tokenized
 * instrument actually is (design section 6.2).
 *
 * Two rules shaped these vocabularies.
 *
 * **No single boolean.** There is no `isRealStock`. A representation may pass
 * dividends through and carry no votes and offer no redemption; that is three
 * different facts about three different dimensions, and collapsing them into one
 * flag discards exactly the nuance Mandate exists to preserve. Rights are
 * therefore per-right, each with its own claim and its own provenance.
 *
 * **Nothing is inferred from a symbol.** A representation is not equity because
 * its ticker looks like an equity ticker. Every value here is asserted by a
 * source and carries that source's provenance, or it is `UNKNOWN` and fails
 * closed.
 */

import { err, ok, type Result } from '@mandate/kernel';
import type { RegistryReasonCodeName } from './reason-codes.ts';

/** What kind of claim on the underlying the token represents. */
export const InstrumentType = {
  BACKED_NOTE: 'BACKED_NOTE',
  DEPOSITARY_RECEIPT: 'DEPOSITARY_RECEIPT',
  FUND_SHARE: 'FUND_SHARE',
  SYNTHETIC_EXPOSURE: 'SYNTHETIC_EXPOSURE',
  DEBT_INSTRUMENT: 'DEBT_INSTRUMENT',
} as const;
export type InstrumentType = (typeof InstrumentType)[keyof typeof InstrumentType];

/**
 * What stands behind the token.
 *
 * Backing and synthetic status are separate questions, which is why this is one
 * vocabulary and not two booleans: `PARTIALLY_BACKED`, `COLLATERALIZED` and
 * `DEBT_LINKED` are *not* synthetic — there is something behind them — and they
 * also do not satisfy a requirement for fully backed exposure. A model that only
 * recorded "synthetic: yes/no" could not express that, and the gap would be
 * resolved in whichever direction the caller found convenient.
 */
export const BackingModel = {
  FULLY_BACKED: 'FULLY_BACKED',
  PARTIALLY_BACKED: 'PARTIALLY_BACKED',
  COLLATERALIZED: 'COLLATERALIZED',
  DEBT_LINKED: 'DEBT_LINKED',
  SYNTHETIC: 'SYNTHETIC',
  UNBACKED: 'UNBACKED',
} as const;
export type BackingModel = (typeof BackingModel)[keyof typeof BackingModel];

/**
 * Synthetic status, **derived** from the backing model rather than stored beside
 * it. Storing both invites them to disagree, and a registry with two fields that
 * can contradict each other about the headline MVP constraint is a registry with
 * a latent wrong answer in it.
 */
const SYNTHETIC_BACKING: ReadonlySet<BackingModel> = new Set<BackingModel>([
  BackingModel.SYNTHETIC,
  BackingModel.UNBACKED,
]);

export function isSyntheticBacking(backing: BackingModel): boolean {
  return SYNTHETIC_BACKING.has(backing);
}

/** Whether the holder can exchange the token for the underlying, and on whose terms. */
export const RedemptionModel = {
  NONE: 'NONE',
  QUALIFIED_HOLDERS_ONLY: 'QUALIFIED_HOLDERS_ONLY',
  OPEN_REDEMPTION: 'OPEN_REDEMPTION',
  ISSUER_DISCRETION: 'ISSUER_DISCRETION',
} as const;
export type RedemptionModel = (typeof RedemptionModel)[keyof typeof RedemptionModel];

/**
 * The rights dimensions Mandate models.
 *
 * Each is claimed independently. `dividendTreatment` is separate from
 * `economicExposure` because a token can track price while paying nothing, and a
 * principal who asked for dividend-bearing exposure has not been given it.
 */
export const RightKind = {
  ECONOMIC_EXPOSURE: 'ECONOMIC_EXPOSURE',
  DIVIDEND_TREATMENT: 'DIVIDEND_TREATMENT',
  VOTING_RIGHTS: 'VOTING_RIGHTS',
  REDEMPTION_RIGHTS: 'REDEMPTION_RIGHTS',
  BENEFICIAL_OWNERSHIP: 'BENEFICIAL_OWNERSHIP',
  TRANSFERABILITY: 'TRANSFERABILITY',
} as const;
export type RightKind = (typeof RightKind)[keyof typeof RightKind];

/**
 * How a right is provided.
 *
 * `PRICE_ADJUSTED` is the value that makes this an enumeration rather than a
 * boolean: a dividend reflected as a price adjustment is not a dividend paid, and
 * a principal who required cash distributions has not received what they asked
 * for. `ABSENT` and an unestablished right are different states, and both refuse
 * where the right is required.
 */
export const RightState = {
  PRESENT: 'PRESENT',
  /** Provided economically by adjusting the token's value rather than by payment. */
  PRICE_ADJUSTED: 'PRICE_ADJUSTED',
  /** Present but restricted — allowlists, lockups, qualified holders only. */
  RESTRICTED: 'RESTRICTED',
  ABSENT: 'ABSENT',
} as const;
export type RightState = (typeof RightState)[keyof typeof RightState];

/**
 * How this representation applies corporate actions.
 *
 * This describes representation *semantics*. It is not the verifier's
 * corporate-action epoch, which is the execution-time safety mechanism for
 * whether the world changed since the authorization. Phase 2 ingests no live
 * corporate actions; keeping the two concerns in separate components is what
 * stops a metadata field being mistaken for a freshness guarantee.
 */
export const CorporateActionModel = {
  SUPPLY_REBASE: 'SUPPLY_REBASE',
  ON_CHAIN_MULTIPLIER: 'ON_CHAIN_MULTIPLIER',
  ISSUER_ACCOUNTING_ADJUSTMENT: 'ISSUER_ACCOUNTING_ADJUSTMENT',
  CASH_DISTRIBUTION: 'CASH_DISTRIBUTION',
  /** The representation does not pass the action through at all. */
  NOT_APPLIED: 'NOT_APPLIED',
} as const;
export type CorporateActionModel = (typeof CorporateActionModel)[keyof typeof CorporateActionModel];

export const SettlementModel = {
  ATOMIC_ON_CHAIN: 'ATOMIC_ON_CHAIN',
  DEFERRED: 'DEFERRED',
  ISSUER_CONFIRMED: 'ISSUER_CONFIRMED',
} as const;
export type SettlementModel = (typeof SettlementModel)[keyof typeof SettlementModel];

/**
 * Operational state of the representation itself.
 *
 * Mirrors the kernel's `OperationalState` minus its `UNKNOWN` member: here,
 * "unknown" is the absence of an established claim, so it is a property of the
 * claim set rather than a value inside the vocabulary. Encoding it twice would
 * allow a record that is explicitly-unknown and also unestablished, which are not
 * two different things.
 */
export const RepresentationOperationalStatus = {
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  TRANSITION: 'TRANSITION',
  DEPRECATED: 'DEPRECATED',
} as const;
export type RepresentationOperationalStatus =
  (typeof RepresentationOperationalStatus)[keyof typeof RepresentationOperationalStatus];

/** ISO 3166-1 alpha-2, upper-case. Jurisdictions are codes, never free text. */
const JURISDICTION_SHAPE = /^[A-Z]{2}$/;
declare const JurisdictionBrand: unique symbol;
export type Jurisdiction = string & { readonly [JurisdictionBrand]: true };

export function parseJurisdiction(raw: unknown): Result<Jurisdiction, RegistryReasonCodeName> {
  if (typeof raw !== 'string' || !JURISDICTION_SHAPE.test(raw)) return err('SNAPSHOT_MALFORMED');
  return ok(raw as Jurisdiction);
}

/**
 * Where a representation may be held.
 *
 * `permitted` is an allowlist and is closed: an undeclared jurisdiction is not
 * permitted, following the mandate schema's rule that permissions are allowlists
 * and an unspecified value is not authorized (design section 7.4, rule 2).
 * `prohibited` is recorded separately because an explicit prohibition is a
 * stronger and differently-sourced statement than an omission.
 */
export interface EligibilityProfile {
  readonly permitted: readonly Jurisdiction[];
  readonly prohibited: readonly Jurisdiction[];
}

export function parseEnumFromVocabulary<T extends string>(
  raw: unknown,
  values: Record<string, T>,
): Result<T, RegistryReasonCodeName> {
  if (typeof raw !== 'string' || !Object.prototype.hasOwnProperty.call(values, raw)) {
    return err('SNAPSHOT_MALFORMED');
  }
  return ok(values[raw] as T);
}

/** Enum values are their own comparison keys; structured values need a real one. */
export function identityKey(value: string): string {
  return value;
}
