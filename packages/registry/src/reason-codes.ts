/**
 * The registry reason-code registry.
 *
 * One vocabulary, two registries. Reason codes are a public interface (design
 * section 10.3), and the worst outcome would be two overlapping vocabularies an
 * integrator has to reconcile. So:
 *
 * - where the kernel already has a code with exactly this meaning, the registry
 *   emits the *kernel's* code — `REPRESENTATION_UNKNOWN`, `ISSUER_NOT_ALLOWED`,
 *   `CHAIN_NOT_ALLOWED`, `SYNTHETIC_NOT_ALLOWED`, `REPRESENTATION_INACTIVE`,
 *   `REPRESENTATION_ASSET_MISMATCH`, `REPRESENTATION_METADATA_UNKNOWN`;
 * - causes that only exist at the registry layer get codes defined here, under
 *   their own `MND-REF-*` and `MND-REG-*` namespaces;
 * - `RegistryReasonCode` is the union of both, so an exclusion list carries
 *   either kind without a caller needing to know which registry it came from;
 * - a test asserts the two registries share no id and no name. That is what
 *   makes "one vocabulary" a checked property rather than an intention.
 *
 * The rules from the kernel's registry apply unchanged: ids and names are
 * permanent, one code per distinct cause, no generic `INVALID`, `humanMessage`
 * is safe to show an end user and leaks no internal structure.
 */

import { ALL_REASON_CODE_NAMES, reasonCode, type ReasonCodeDefinition, type ReasonCodeName } from '@mandate/kernel';

export const RegistryReasonFamily = {
  /** Turning a human reference into a canonical financial identity. */
  REF: 'REF',
  /** Registry state, representation identity, and mandate-constrained admissibility. */
  REG: 'REG',
} as const;
export type RegistryReasonFamily = (typeof RegistryReasonFamily)[keyof typeof RegistryReasonFamily];

/**
 * Registry pipeline stages, recorded per code so the registry doubles as a
 * coverage map in the same way the kernel's does. These are the registry's own
 * stages; the kernel's A–G check families describe verification, not resolution.
 */
export const RegistryEnforcementPoint = {
  R_REFERENCE_RESOLUTION: 'R_REFERENCE_RESOLUTION',
  S_REGISTRY_STATE: 'S_REGISTRY_STATE',
  T_REPRESENTATION_ADMISSIBILITY: 'T_REPRESENTATION_ADMISSIBILITY',
} as const;
export type RegistryEnforcementPoint =
  (typeof RegistryEnforcementPoint)[keyof typeof RegistryEnforcementPoint];

export interface RegistryReasonCodeDefinition {
  readonly id: string;
  readonly name: RegistryReasonCodeName;
  readonly family: RegistryReasonFamily;
  readonly enforcementPoint: RegistryEnforcementPoint;
  readonly developerMessage: string;
  readonly humanMessage: string;
}

const F = RegistryReasonFamily;
const E = RegistryEnforcementPoint;

const DEFINITIONS = [
  // --- REF: human reference to canonical financial identity ----------------
  {
    id: 'MND-REF-001',
    name: 'REFERENCE_MALFORMED',
    family: F.REF,
    enforcementPoint: E.R_REFERENCE_RESOLUTION,
    developerMessage: 'The supplied reference is not a well-formed reference: it is empty, contains non-ASCII or control characters, exceeds the length bound, or is an exchange-qualified form with an empty or excess segment. References are never repaired.',
    humanMessage: 'That is not something this system can look up.',
  },
  {
    id: 'MND-REF-002',
    name: 'REFERENCE_AMBIGUOUS',
    family: F.REF,
    enforcementPoint: E.R_REFERENCE_RESOLUTION,
    developerMessage: 'The reference matched more than one canonical asset. Every candidate is reported and none is chosen: a tie-break would be a guess about financial identity.',
    humanMessage: 'That name or symbol matches more than one asset. Please be more specific.',
  },
  {
    id: 'MND-REF-003',
    name: 'REFERENCE_UNKNOWN',
    family: F.REF,
    enforcementPoint: E.R_REFERENCE_RESOLUTION,
    developerMessage: 'The reference matched no canonical asset in this registry snapshot. An unmatched reference is never resolved by similarity.',
    humanMessage: 'That asset is not one this system recognizes.',
  },
  {
    id: 'MND-REF-004',
    name: 'ASSET_IDENTIFIER_INVALID',
    family: F.REF,
    enforcementPoint: E.R_REFERENCE_RESOLUTION,
    developerMessage: 'A canonical asset identifier value is not valid under its declared scheme: wrong length, disallowed character, reserved prefix, or a check digit that does not verify. A single-character typo must not become a different canonical asset.',
    humanMessage: 'An asset identifier in this request was not valid.',
  },
  {
    id: 'MND-REF-005',
    name: 'ASSET_IDENTIFIER_SCHEME_UNSUPPORTED',
    family: F.REF,
    enforcementPoint: E.R_REFERENCE_RESOLUTION,
    developerMessage: 'The identifier scheme is not one this registry implements. An unrecognized scheme rejects; its value is never stored unvalidated.',
    humanMessage: 'That kind of asset identifier is not supported.',
  },
  {
    id: 'MND-REF-006',
    name: 'ASSET_CLASS_UNSUPPORTED',
    family: F.REF,
    enforcementPoint: E.R_REFERENCE_RESOLUTION,
    developerMessage: 'The asset class is not one this registry implements. The class is part of canonical identity, so an unrecognized class rejects rather than creating an asset whose applicable semantics are unknown.',
    humanMessage: 'That kind of asset is not supported.',
  },

  // --- REG: registry state and representation admissibility ----------------
  {
    id: 'MND-REG-001',
    name: 'SNAPSHOT_MALFORMED',
    family: F.REG,
    enforcementPoint: E.S_REGISTRY_STATE,
    developerMessage: 'The registry snapshot is not well-formed: a field is missing, of the wrong type, outside its range, or a duplicate asset, representation, listing or alias entry was supplied. Duplicates reject rather than being collapsed.',
    humanMessage: 'The asset registry could not be read, so nothing was traded.',
  },
  {
    id: 'MND-REG-015',
    name: 'SNAPSHOT_RESOURCE_LIMIT_EXCEEDED',
    family: F.REG,
    enforcementPoint: E.S_REGISTRY_STATE,
    developerMessage: 'A counted collection in the snapshot exceeds its declared bound. Every collection the registry encoder writes as a u16 count has a matching parse-time limit, so an oversized snapshot is a typed rejection rather than an encoder assertion during digest computation.',
    humanMessage: 'This registry snapshot was larger than the system accepts and was not used.',
  },
  {
    id: 'MND-REG-002',
    name: 'REPRESENTATION_ID_MALFORMED',
    family: F.REG,
    enforcementPoint: E.S_REGISTRY_STATE,
    developerMessage: 'A representation identifier is not a well-formed chain-plus-contract identifier: unknown namespace, malformed chain reference, or a contract address that is neither already canonical lowercase nor a verifying EIP-55 checksum. A failing checksum rejects and is never repaired.',
    humanMessage: 'A token identifier in this request was not valid.',
  },
  {
    id: 'MND-REG-003',
    name: 'CANONICAL_ASSET_UNKNOWN',
    family: F.REG,
    enforcementPoint: E.S_REGISTRY_STATE,
    developerMessage: 'The canonical asset is not present in this registry snapshot. A representation whose underlying is not a registered asset is never admissible.',
    humanMessage: 'That asset is not one this system recognizes.',
  },
  {
    id: 'MND-REG-004',
    name: 'CANONICAL_ASSET_INACTIVE',
    family: F.REG,
    enforcementPoint: E.S_REGISTRY_STATE,
    developerMessage: 'The canonical asset status is not ACTIVE: it is delisted, superseded, or could not be established. A non-active asset resolves for audit but yields no admissible representation.',
    humanMessage: 'This asset is no longer available to trade.',
  },
  {
    id: 'MND-REG-005',
    name: 'REPRESENTATION_METADATA_CONFLICT',
    family: F.REG,
    enforcementPoint: E.T_REPRESENTATION_ADMISSIBILITY,
    developerMessage: 'Two or more claims at or above the trust floor disagree about a representation property the requirements constrain. A conflict fails closed unconditionally: it is never resolved by recency, trust precedence or source count.',
    humanMessage: 'Information about this token disagreed between sources, so it was not used.',
  },
  {
    id: 'MND-REG-006',
    name: 'TRUST_REQUIREMENT_NOT_MET',
    family: F.REG,
    enforcementPoint: E.T_REPRESENTATION_ADMISSIBILITY,
    developerMessage: 'Every claim about a constrained representation property is below the required trust floor. Advisory and untrusted data can never establish a property that gates an execution.',
    humanMessage: 'Information about this token did not come from a source trusted for it.',
  },
  {
    id: 'MND-REG-007',
    name: 'REPRESENTATION_METADATA_STALE',
    family: F.REG,
    enforcementPoint: E.T_REPRESENTATION_ADMISSIBILITY,
    developerMessage: 'Claims about a constrained representation property exist at or above the trust floor, but every one is older than the maximum claim age supplied with the requirements. A stale claim cannot establish a property and cannot create a conflict.',
    humanMessage: 'Information about this token was too old to rely on.',
  },
  {
    id: 'MND-REG-008',
    name: 'BACKING_REQUIREMENT_NOT_MET',
    family: F.REG,
    enforcementPoint: E.T_REPRESENTATION_ADMISSIBILITY,
    developerMessage: 'The representation backing model is not in the set the requirements permit. Backing is checked separately from synthetic status: partially backed, collateralized and debt-linked instruments are not synthetic but do not satisfy a full-backing requirement.',
    humanMessage: 'This token is not backed in the way your authorization requires.',
  },
  {
    id: 'MND-REG-009',
    name: 'INSTRUMENT_TYPE_NOT_ALLOWED',
    family: F.REG,
    enforcementPoint: E.T_REPRESENTATION_ADMISSIBILITY,
    developerMessage: 'The representation instrument type is not in the set the requirements permit.',
    humanMessage: 'This token is not a kind of instrument your authorization permits.',
  },
  {
    id: 'MND-REG-010',
    name: 'RIGHTS_REQUIREMENT_NOT_MET',
    family: F.REG,
    enforcementPoint: E.T_REPRESENTATION_ADMISSIBILITY,
    developerMessage: 'A holder right the requirements demand is not present on this representation. Rights are per-right claims: absence of a required right rejects, and so does an unestablished one.',
    humanMessage: 'This token does not carry a holder right your authorization requires.',
  },
  {
    id: 'MND-REG-011',
    name: 'REDEMPTION_REQUIREMENT_NOT_MET',
    family: F.REG,
    enforcementPoint: E.T_REPRESENTATION_ADMISSIBILITY,
    developerMessage: 'The representation redemption model is not in the set the requirements permit.',
    humanMessage: 'This token cannot be redeemed on terms your authorization requires.',
  },
  {
    id: 'MND-REG-012',
    name: 'SETTLEMENT_MODEL_NOT_ALLOWED',
    family: F.REG,
    enforcementPoint: E.T_REPRESENTATION_ADMISSIBILITY,
    developerMessage: 'The representation settlement model is not in the set the requirements permit.',
    humanMessage: 'This token settles in a way your authorization does not permit.',
  },
  {
    id: 'MND-REG-013',
    name: 'CORPORATE_ACTION_MODEL_NOT_ALLOWED',
    family: F.REG,
    enforcementPoint: E.T_REPRESENTATION_ADMISSIBILITY,
    developerMessage: 'The way this representation applies corporate actions is not in the set the requirements permit. This describes the representation semantics and is a different check from the verifier corporate-action epoch, which is the execution-time safety mechanism.',
    humanMessage: 'This token handles corporate actions in a way your authorization does not permit.',
  },
  {
    id: 'MND-REG-014',
    name: 'JURISDICTION_NOT_ELIGIBLE',
    family: F.REG,
    enforcementPoint: E.T_REPRESENTATION_ADMISSIBILITY,
    developerMessage: 'The holder jurisdiction supplied with the requirements is prohibited for this representation, or is not among the jurisdictions the representation declares permitted. An undeclared jurisdiction is not permitted.',
    humanMessage: 'This token is not available to holders in your jurisdiction.',
  },
] as const;

export type RegistryReasonCodeName = (typeof DEFINITIONS)[number]['name'];

/**
 * Either registry's codes. A registry decision carries this union, so a caller
 * handles one vocabulary regardless of which layer produced a given exclusion.
 */
export type RegistryReasonCode = ReasonCodeName | RegistryReasonCodeName;

export const REGISTRY_REASON_CODES: readonly RegistryReasonCodeDefinition[] = DEFINITIONS;

const BY_NAME = new Map<string, RegistryReasonCodeDefinition>(REGISTRY_REASON_CODES.map((d) => [d.name, d]));
const BY_ID = new Map<string, RegistryReasonCodeDefinition>(REGISTRY_REASON_CODES.map((d) => [d.id, d]));
const KERNEL_NAMES = new Set<string>(ALL_REASON_CODE_NAMES);

export function registryReasonCode(name: RegistryReasonCodeName): RegistryReasonCodeDefinition {
  const d = BY_NAME.get(name);
  // Unreachable: `name` is constrained to this registry's own union.
  if (d === undefined) throw new Error(`unknown registry reason code name: ${name}`);
  return d;
}

export function registryReasonCodeById(id: string): RegistryReasonCodeDefinition | undefined {
  return BY_ID.get(id);
}

export function isKernelReasonCode(name: RegistryReasonCode): name is ReasonCodeName {
  return KERNEL_NAMES.has(name);
}

/**
 * Look up a code from either registry.
 *
 * `id`, `developerMessage` and `humanMessage` are common to both shapes;
 * `family` and `enforcementPoint` are stringly-typed here because the two
 * registries name their own stages and merging the enums would force one
 * layer's vocabulary onto the other.
 */
export interface AnyReasonCodeDefinition {
  readonly id: string;
  readonly name: RegistryReasonCode;
  readonly family: string;
  readonly enforcementPoint: string;
  readonly developerMessage: string;
  readonly humanMessage: string;
  readonly registry: 'kernel' | 'registry';
}

export function anyReasonCode(name: RegistryReasonCode): AnyReasonCodeDefinition {
  if (isKernelReasonCode(name)) {
    const d: ReasonCodeDefinition = reasonCode(name);
    return { ...d, registry: 'kernel' };
  }
  return { ...registryReasonCode(name), registry: 'registry' };
}

/** Every name in this registry. Used by the coverage test. */
export const ALL_REGISTRY_REASON_CODE_NAMES: readonly RegistryReasonCodeName[] = DEFINITIONS.map((d) => d.name);
