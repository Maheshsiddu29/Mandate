/**
 * The reason-code registry.
 *
 * Reason codes are a public interface (design section 10.3): they appear in
 * receipts, in integrator error handling and in audit records. They are data,
 * not strings built at a call site, so that a caller can map them without
 * parsing prose and so a human-readable layer can be replaced without touching
 * the verifier.
 *
 * Rules, enforced by `reason-codes.test.ts`:
 *
 * - `id` is stable and namespaced `MND-<FAMILY>-<NNN>`; `name` is the stable
 *   symbolic form. Both are permanent. A retired code stays retired and its id
 *   is never reused for a different meaning.
 * - one code per distinct cause. There is no generic `INVALID`.
 * - `developerMessage` states the condition precisely; `humanMessage` is safe
 *   to show an end user and leaks no internal structure.
 * - `enforcementPoint` records which check family (design section 10.2)
 *   produces it, so the registry doubles as a coverage map.
 */

export const ReasonFamily = {
  /** Structural: the inputs are not well-formed objects of the expected shape. */
  INPUT: 'INPUT',
  /** Authorization scope: who signed, whether it is live, whether it is spent. */
  AUTH: 'AUTH',
  /** Financial identity: is this the asset the mandate names. */
  ASSET: 'ASSET',
  /** Representation semantics: is this tokenized instance acceptable. */
  REPR: 'REPR',
  /** Economic bounds: notional, deviation, side. */
  ECON: 'ECON',
  /** Observed state: freshness, halts, corporate-action epoch. */
  STATE: 'STATE',
  /** Network and venue admissibility. */
  NET: 'NET',
  /** Trust-level violations in the supplied inputs. */
  TRUST: 'TRUST',
} as const;
export type ReasonFamily = (typeof ReasonFamily)[keyof typeof ReasonFamily];

/** Check family from design section 10.2, recorded per code as a coverage map. */
export const EnforcementPoint = {
  A_MANDATE_INTEGRITY: 'A_MANDATE_INTEGRITY',
  B_AUTHORIZATION_SCOPE: 'B_AUTHORIZATION_SCOPE',
  C_ASSET_IDENTITY: 'C_ASSET_IDENTITY',
  D_REPRESENTATION_SEMANTICS: 'D_REPRESENTATION_SEMANTICS',
  E_ECONOMIC_BOUNDS: 'E_ECONOMIC_BOUNDS',
  F_MARKET_AND_CORPORATE_ACTION_STATE: 'F_MARKET_AND_CORPORATE_ACTION_STATE',
  G_INTENT_FIDELITY: 'G_INTENT_FIDELITY',
} as const;
export type EnforcementPoint = (typeof EnforcementPoint)[keyof typeof EnforcementPoint];

export interface ReasonCodeDefinition {
  readonly id: string;
  readonly name: ReasonCodeName;
  readonly family: ReasonFamily;
  readonly enforcementPoint: EnforcementPoint;
  /** Precise statement of the condition, for developers and auditors. */
  readonly developerMessage: string;
  /** Safe to display to an end user. No internal identifiers, no addresses. */
  readonly humanMessage: string;
}

const F = ReasonFamily;
const E = EnforcementPoint;

const DEFINITIONS = [
  // --- INPUT: structural well-formedness -----------------------------------
  {
    id: 'MND-INPUT-001',
    name: 'MALFORMED_MANDATE',
    family: F.INPUT,
    enforcementPoint: E.A_MANDATE_INTEGRITY,
    developerMessage: 'The mandate is not a well-formed canonical mandate: a field is missing, of the wrong type, or outside its permitted range.',
    humanMessage: 'This authorization could not be read and was not used.',
  },
  {
    id: 'MND-INPUT-002',
    name: 'UNSUPPORTED_MANDATE_VERSION',
    family: F.INPUT,
    enforcementPoint: E.A_MANDATE_INTEGRITY,
    developerMessage: 'The mandate declares a schema version this verifier does not implement. Unknown versions are never interpreted leniently.',
    humanMessage: 'This authorization uses a newer format than this system supports.',
  },
  {
    id: 'MND-INPUT-003',
    name: 'MALFORMED_CANDIDATE',
    family: F.INPUT,
    enforcementPoint: E.G_INTENT_FIDELITY,
    developerMessage: 'The execution candidate is not well-formed: a field is missing, of the wrong type, or outside its permitted range.',
    humanMessage: 'The proposed trade could not be read and was not executed.',
  },
  {
    id: 'MND-INPUT-004',
    name: 'MALFORMED_TRUSTED_STATE',
    family: F.INPUT,
    enforcementPoint: E.F_MARKET_AND_CORPORATE_ACTION_STATE,
    developerMessage: 'The supplied trusted state is not well-formed: a field is missing, of the wrong type, or outside its permitted range.',
    humanMessage: 'Market information was unusable, so the trade was not executed.',
  },
  {
    id: 'MND-INPUT-005',
    name: 'MALFORMED_AUTHORIZATION',
    family: F.INPUT,
    enforcementPoint: E.A_MANDATE_INTEGRITY,
    developerMessage: 'The authorization envelope is not well-formed: signature length, signer format or domain fields are invalid.',
    humanMessage: 'The approval attached to this authorization could not be read.',
  },
  {
    id: 'MND-INPUT-006',
    name: 'MALFORMED_IDENTIFIER',
    family: F.INPUT,
    enforcementPoint: E.A_MANDATE_INTEGRITY,
    developerMessage: 'An identifier string violates the canonical charset, length or shape rules (ADR 0002). Identifiers are never trimmed, case-folded or otherwise repaired.',
    humanMessage: 'An identifier in this request was not valid.',
  },
  {
    id: 'MND-INPUT-007',
    name: 'UNIT_MISMATCH',
    family: F.INPUT,
    enforcementPoint: E.E_ECONOMIC_BOUNDS,
    developerMessage: 'Two quantities that must share a unit or decimal scale do not. No implicit conversion is performed.',
    humanMessage: 'The amounts in this request were expressed in incompatible units.',
  },
  {
    id: 'MND-INPUT-008',
    name: 'VALUE_OUT_OF_RANGE',
    family: F.INPUT,
    enforcementPoint: E.E_ECONOMIC_BOUNDS,
    developerMessage: 'A numeric value is negative where unsigned, or exceeds the maximum this encoding supports. Arithmetic is never allowed to wrap.',
    humanMessage: 'A value in this request was outside the supported range.',
  },
  {
    id: 'MND-INPUT-009',
    name: 'NOTIONAL_INCONSISTENT',
    family: F.INPUT,
    enforcementPoint: E.E_ECONOMIC_BOUNDS,
    developerMessage: 'The candidate declared notional does not equal quantity multiplied by execution price, rounded either down or up. The declared value is never substituted with the recomputed one.',
    humanMessage: 'The quantity, price and total of this trade did not agree.',
  },
  {
    id: 'MND-INPUT-010',
    name: 'VERIFIER_INTERNAL_ERROR',
    family: F.INPUT,
    enforcementPoint: E.A_MANDATE_INTEGRITY,
    developerMessage: 'A check raised an unexpected error. This is a defect in the verifier, and it fails closed: an internal fault produces a rejection, never a pass.',
    humanMessage: 'This trade could not be checked and was not executed.',
  },

  // --- AUTH: authorization scope -------------------------------------------
  {
    id: 'MND-AUTH-001',
    name: 'MANDATE_EXPIRED',
    family: F.AUTH,
    enforcementPoint: E.B_AUTHORIZATION_SCOPE,
    developerMessage: 'The evaluation time is at or after the mandate expiry. Expiry is inclusive of rejection: t >= expiresAt rejects.',
    humanMessage: 'This authorization has expired. Approve the trade again to continue.',
  },
  {
    id: 'MND-AUTH-002',
    name: 'MANDATE_NOT_YET_ACTIVE',
    family: F.AUTH,
    enforcementPoint: E.B_AUTHORIZATION_SCOPE,
    developerMessage: 'The evaluation time is before the mandate notBefore time.',
    humanMessage: 'This authorization is not active yet.',
  },
  {
    id: 'MND-AUTH-003',
    name: 'SIGNATURE_INVALID',
    family: F.AUTH,
    enforcementPoint: E.A_MANDATE_INTEGRITY,
    developerMessage: 'The authorization signature does not verify against the mandate digest under the declared scheme and domain.',
    humanMessage: 'The approval for this authorization was not valid.',
  },
  {
    id: 'MND-AUTH-004',
    name: 'SIGNER_UNAUTHORIZED',
    family: F.AUTH,
    enforcementPoint: E.B_AUTHORIZATION_SCOPE,
    developerMessage: 'The signature recovered a valid signer, but that signer is not the mandate principal. A valid signature is not authorization unless it is the right party.',
    humanMessage: 'This authorization was approved by someone who does not own the account.',
  },
  {
    id: 'MND-AUTH-005',
    name: 'AGENT_UNAUTHORIZED',
    family: F.AUTH,
    enforcementPoint: E.B_AUTHORIZATION_SCOPE,
    developerMessage: 'The acting agent presented with the candidate is not the agent named in the mandate.',
    humanMessage: 'This trade was proposed by an agent that is not authorized here.',
  },
  {
    id: 'MND-AUTH-006',
    name: 'MANDATE_ALREADY_CONSUMED',
    family: F.AUTH,
    enforcementPoint: E.B_AUTHORIZATION_SCOPE,
    developerMessage: 'Replay state reports this mandate digest as already consumed. A consumed authorization never executes again.',
    humanMessage: 'This authorization has already been used.',
  },
  {
    id: 'MND-AUTH-010',
    name: 'MANDATE_RESERVED',
    family: F.AUTH,
    enforcementPoint: E.B_AUTHORIZATION_SCOPE,
    developerMessage: 'Replay state reports this mandate digest as reserved by an in-flight execution attempt. A reserved mandate is not available to a second attempt.',
    humanMessage: 'This authorization is already being used by another trade in progress.',
  },
  {
    id: 'MND-AUTH-007',
    name: 'REPLAY_STATE_UNKNOWN',
    family: F.AUTH,
    enforcementPoint: E.B_AUTHORIZATION_SCOPE,
    developerMessage: 'Replay state for this mandate digest could not be established. Unknown replay state fails closed; it is never treated as unused.',
    humanMessage: 'This authorization could not be checked against previous use.',
  },
  {
    id: 'MND-AUTH-008',
    name: 'AUTHORIZATION_SCHEME_UNSUPPORTED',
    family: F.AUTH,
    enforcementPoint: E.A_MANDATE_INTEGRITY,
    developerMessage: 'The authorization envelope declares a signature scheme this verifier does not implement. An unrecognized scheme rejects; it is never skipped.',
    humanMessage: 'The approval method used for this authorization is not supported.',
  },
  {
    id: 'MND-AUTH-009',
    name: 'AUTHORIZATION_DOMAIN_MISMATCH',
    family: F.AUTH,
    enforcementPoint: E.A_MANDATE_INTEGRITY,
    developerMessage: 'The authorization envelope domain does not match the domain the caller requires. The verifier never accepts whatever domain an envelope claims.',
    humanMessage: 'This approval was issued for a different application or network.',
  },

  // --- ASSET: financial identity -------------------------------------------
  {
    id: 'MND-ASSET-001',
    name: 'CANONICAL_ASSET_MISMATCH',
    family: F.ASSET,
    enforcementPoint: E.C_ASSET_IDENTITY,
    developerMessage: 'The candidate names a different canonical asset than the mandate authorizes.',
    humanMessage: 'The selected asset does not match your authorization.',
  },
  {
    id: 'MND-ASSET-002',
    name: 'REPRESENTATION_ASSET_MISMATCH',
    family: F.ASSET,
    enforcementPoint: E.C_ASSET_IDENTITY,
    developerMessage: 'The trusted representation state maps this representation to a canonical asset other than the one the mandate authorizes.',
    humanMessage: 'The selected token does not represent the asset you authorized.',
  },
  {
    id: 'MND-ASSET-003',
    name: 'REPRESENTATION_UNKNOWN',
    family: F.ASSET,
    enforcementPoint: E.C_ASSET_IDENTITY,
    developerMessage: 'No trusted representation state was supplied for the representation the candidate names. An unregistered representation is never admissible.',
    humanMessage: 'The selected token is not recognized and was not traded.',
  },

  // --- REPR: representation semantics --------------------------------------
  {
    id: 'MND-REPR-001',
    name: 'ISSUER_NOT_ALLOWED',
    family: F.REPR,
    enforcementPoint: E.D_REPRESENTATION_SEMANTICS,
    developerMessage: 'The representation issuer is not in the mandate allowed-issuer set.',
    humanMessage: 'This token comes from an issuer your authorization does not permit.',
  },
  {
    id: 'MND-REPR-002',
    name: 'SYNTHETIC_NOT_ALLOWED',
    family: F.REPR,
    enforcementPoint: E.D_REPRESENTATION_SEMANTICS,
    developerMessage: 'The representation is synthetic and the mandate forbids synthetic exposure.',
    humanMessage: 'This token is synthetic exposure, which your authorization does not allow.',
  },
  {
    id: 'MND-REPR-003',
    name: 'REPRESENTATION_INACTIVE',
    family: F.REPR,
    enforcementPoint: E.D_REPRESENTATION_SEMANTICS,
    developerMessage: 'The representation operational state is not ACTIVE: it is paused, deprecated or in transition.',
    humanMessage: 'Trading in this token is currently suspended.',
  },
  {
    id: 'MND-REPR-004',
    name: 'REPRESENTATION_METADATA_UNKNOWN',
    family: F.REPR,
    enforcementPoint: E.D_REPRESENTATION_SEMANTICS,
    developerMessage: 'A representation metadata field the mandate constrains is UNKNOWN. UNKNOWN on a constrained field rejects; it is never read as a default permit.',
    humanMessage: 'Required information about this token was unavailable.',
  },
  {
    id: 'MND-REPR-005',
    name: 'REPRESENTATION_ATTRIBUTES_MISMATCH',
    family: F.REPR,
    enforcementPoint: E.G_INTENT_FIDELITY,
    developerMessage: 'The issuer or chain the candidate declares differs from the trusted representation state for that representation. The candidate does not get to describe the representation.',
    humanMessage: 'The details of the proposed trade did not match the token it names.',
  },

  // --- ECON: economic bounds -----------------------------------------------
  {
    id: 'MND-ECON-001',
    name: 'MAX_NOTIONAL_EXCEEDED',
    family: F.ECON,
    enforcementPoint: E.E_ECONOMIC_BOUNDS,
    developerMessage: 'The candidate notional exceeds the mandate maximum notional.',
    humanMessage: 'This trade is larger than the amount you authorized.',
  },
  {
    id: 'MND-ECON-002',
    name: 'PRICE_DEVIATION_EXCEEDED',
    family: F.ECON,
    enforcementPoint: E.E_ECONOMIC_BOUNDS,
    developerMessage: 'The execution price deviates from the trusted reference price by more than the mandate maximum, measured in basis points and rounded up.',
    humanMessage: 'The price moved further from the reference than your authorization allows.',
  },
  {
    id: 'MND-ECON-003',
    name: 'SIDE_MISMATCH',
    family: F.ECON,
    enforcementPoint: E.G_INTENT_FIDELITY,
    developerMessage: 'The candidate side is not the side the mandate authorizes.',
    humanMessage: 'This trade is in the opposite direction to your authorization.',
  },

  // --- STATE: observed market and corporate-action state -------------------
  {
    id: 'MND-STATE-001',
    name: 'PRICE_STATE_STALE',
    family: F.STATE,
    enforcementPoint: E.F_MARKET_AND_CORPORATE_ACTION_STATE,
    developerMessage: 'The reference price observation is older than the mandate market-data freshness bound at the evaluation time.',
    humanMessage: 'Price information was too old to trade against.',
  },
  {
    id: 'MND-STATE-002',
    name: 'CORPORATE_ACTION_STATE_CHANGED',
    family: F.STATE,
    enforcementPoint: E.F_MARKET_AND_CORPORATE_ACTION_STATE,
    developerMessage: 'The observed corporate-action epoch is ahead of the epoch the mandate was authorized under. Recovery is reauthorization; the mandate is never rescaled automatically.',
    humanMessage: 'A corporate action has changed this asset since you approved. Approve again to continue.',
  },
  {
    id: 'MND-STATE-003',
    name: 'CORPORATE_ACTION_STATE_INCONSISTENT',
    family: F.STATE,
    enforcementPoint: E.F_MARKET_AND_CORPORATE_ACTION_STATE,
    developerMessage: 'The observed corporate-action epoch is behind the epoch the mandate was authorized under. The epoch source is inconsistent with the authorization and fails closed.',
    humanMessage: 'Corporate action information for this asset was inconsistent.',
  },
  {
    id: 'MND-STATE-004',
    name: 'TRADING_HALTED',
    family: F.STATE,
    enforcementPoint: E.F_MARKET_AND_CORPORATE_ACTION_STATE,
    developerMessage: 'The underlying is halted and the mandate halt policy forbids execution while halted.',
    humanMessage: 'Trading in this asset is halted.',
  },
  {
    id: 'MND-STATE-005',
    name: 'MARKET_STATE_UNKNOWN',
    family: F.STATE,
    enforcementPoint: E.F_MARKET_AND_CORPORATE_ACTION_STATE,
    developerMessage: 'A market state field the verifier requires is UNKNOWN: the halt status or the reference price could not be established.',
    humanMessage: 'Market information for this asset was unavailable.',
  },
  {
    id: 'MND-STATE-007',
    name: 'CORPORATE_ACTION_STATE_UNKNOWN',
    family: F.STATE,
    enforcementPoint: E.F_MARKET_AND_CORPORATE_ACTION_STATE,
    developerMessage: 'The corporate-action epoch for this asset could not be established. An unknown epoch fails closed; it is never assumed to match the authorization.',
    humanMessage: 'Corporate action information for this asset was unavailable.',
  },
  {
    id: 'MND-STATE-008',
    name: 'CORPORATE_ACTION_STATE_STALE',
    family: F.STATE,
    enforcementPoint: E.F_MARKET_AND_CORPORATE_ACTION_STATE,
    developerMessage: 'The corporate-action observation is older than the mandate corporate-action freshness bound at the evaluation time. A fresh epoch feed is itself state that can go stale.',
    humanMessage: 'Corporate action information for this asset was too old to trade against.',
  },
  {
    id: 'MND-STATE-006',
    name: 'CANDIDATE_STATE_MISMATCH',
    family: F.STATE,
    enforcementPoint: E.G_INTENT_FIDELITY,
    developerMessage: 'The corporate-action epoch the candidate was constructed against differs from the observed epoch. The candidate was built against a different world than the one being verified.',
    humanMessage: 'The proposed trade was prepared against outdated information.',
  },

  // --- NET: network and venue ----------------------------------------------
  {
    id: 'MND-NET-001',
    name: 'CHAIN_NOT_ALLOWED',
    family: F.NET,
    enforcementPoint: E.C_ASSET_IDENTITY,
    developerMessage: 'The candidate chain is not in the mandate allowed-chain set.',
    humanMessage: 'This trade would execute on a network your authorization does not permit.',
  },
  {
    id: 'MND-NET-002',
    name: 'VENUE_NOT_ALLOWED',
    family: F.NET,
    enforcementPoint: E.G_INTENT_FIDELITY,
    developerMessage: 'The candidate venue is not in the mandate allowed-venue set.',
    humanMessage: 'This trade would execute at a venue your authorization does not permit.',
  },

  // --- TRUST: trust-level violations ---------------------------------------
  {
    id: 'MND-TRUST-001',
    name: 'UNTRUSTED_REQUIRED_STATE',
    family: F.TRUST,
    enforcementPoint: E.F_MARKET_AND_CORPORATE_ACTION_STATE,
    developerMessage: 'A required state input carries an ADVISORY or UNTRUSTED provenance. Advisory and untrusted sources can never satisfy an authoritative or verified input.',
    humanMessage: 'Information required to check this trade came from a source that is not trusted for it.',
  },
  {
    id: 'MND-TRUST-002',
    name: 'TRUSTED_STATE_MISSING',
    family: F.TRUST,
    enforcementPoint: E.F_MARKET_AND_CORPORATE_ACTION_STATE,
    developerMessage: 'A required trusted state input was not supplied at all. Absent trusted state fails closed.',
    humanMessage: 'Information required to check this trade was not available.',
  },
] as const;

export type ReasonCodeName = (typeof DEFINITIONS)[number]['name'];

export const REASON_CODES: readonly ReasonCodeDefinition[] = DEFINITIONS;

const BY_NAME = new Map<string, ReasonCodeDefinition>(REASON_CODES.map((d) => [d.name, d]));
const BY_ID = new Map<string, ReasonCodeDefinition>(REASON_CODES.map((d) => [d.id, d]));

export function reasonCode(name: ReasonCodeName): ReasonCodeDefinition {
  const d = BY_NAME.get(name);
  // Unreachable: `name` is constrained to the registry's own union.
  if (d === undefined) throw new Error(`unknown reason code name: ${name}`);
  return d;
}

export function reasonCodeById(id: string): ReasonCodeDefinition | undefined {
  return BY_ID.get(id);
}

/** Every name in the registry. Used by the coverage test. */
export const ALL_REASON_CODE_NAMES: readonly ReasonCodeName[] = DEFINITIONS.map((d) => d.name);
