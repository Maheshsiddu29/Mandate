# Registry reason-code registry

> **Generated from `packages/registry/src/reason-codes.ts`. Do not edit by hand.**
> Run `npm run docs:generate` after changing the registry;
> `packages/registry/test/docs.test.ts` fails if this file drifts.

Registry-layer causes: turning a human reference into a canonical financial
identity, and deciding whether a tokenized representation may satisfy a mandate.

## One vocabulary, two registries

The kernel already names many of the causes a registry decision produces, and
two overlapping vocabularies would be worse than one longer one. So:

- where the kernel has a code with exactly this meaning, the registry emits
  **the kernel's** code. Those live in [reason-codes.md](reason-codes.md) and are
  listed below under [Reused kernel codes](#reused-kernel-codes).
- causes that exist only at the registry layer get the codes in this document,
  under their own `MND-REF-*` and `MND-REG-*` namespaces.
- a test asserts the two registries share no id and no name, so "one vocabulary"
  is a checked property rather than an intention.

The same rules apply as in the kernel's registry: ids and names are permanent,
one code per distinct cause, no generic `INVALID`, and `humanMessage` is safe to
show an end user.

`enforcementPoint` names the registry pipeline stage that produces the code, so
this table doubles as a coverage map. The stages are the registry's own; the
kernel's A–G families describe verification, not resolution.

**20 registry codes across 2 families**, plus the reused kernel codes below.

## REF — human reference to canonical financial identity

| ID | Name | Enforcement point | Condition |
| --- | --- | --- | --- |
| `MND-REF-001` | `REFERENCE_MALFORMED` | R_REFERENCE_RESOLUTION | The supplied reference is not a well-formed reference: it is empty, contains non-ASCII or control characters, exceeds the length bound, or is an exchange-qualified form with an empty or excess segment. References are never repaired. |
| `MND-REF-002` | `REFERENCE_AMBIGUOUS` | R_REFERENCE_RESOLUTION | The reference matched more than one canonical asset. Every candidate is reported and none is chosen: a tie-break would be a guess about financial identity. |
| `MND-REF-003` | `REFERENCE_UNKNOWN` | R_REFERENCE_RESOLUTION | The reference matched no canonical asset in this registry snapshot. An unmatched reference is never resolved by similarity. |
| `MND-REF-004` | `ASSET_IDENTIFIER_INVALID` | R_REFERENCE_RESOLUTION | A canonical asset identifier value is not valid under its declared scheme: wrong length, disallowed character, reserved prefix, or a check digit that does not verify. A single-character typo must not become a different canonical asset. |
| `MND-REF-005` | `ASSET_IDENTIFIER_SCHEME_UNSUPPORTED` | R_REFERENCE_RESOLUTION | The identifier scheme is not one this registry implements. An unrecognized scheme rejects; its value is never stored unvalidated. |
| `MND-REF-006` | `ASSET_CLASS_UNSUPPORTED` | R_REFERENCE_RESOLUTION | The asset class is not one this registry implements. The class is part of canonical identity, so an unrecognized class rejects rather than creating an asset whose applicable semantics are unknown. |

## REG — registry state and representation admissibility

| ID | Name | Enforcement point | Condition |
| --- | --- | --- | --- |
| `MND-REG-001` | `SNAPSHOT_MALFORMED` | S_REGISTRY_STATE | The registry snapshot is not well-formed: a field is missing, of the wrong type, outside its range, or a duplicate asset, representation, listing or alias entry was supplied. Duplicates reject rather than being collapsed. |
| `MND-REG-002` | `REPRESENTATION_ID_MALFORMED` | S_REGISTRY_STATE | A representation identifier is not a well-formed chain-plus-contract identifier: unknown namespace, malformed chain reference, or a contract address that is neither already canonical lowercase nor a verifying EIP-55 checksum. A failing checksum rejects and is never repaired. |
| `MND-REG-003` | `CANONICAL_ASSET_UNKNOWN` | S_REGISTRY_STATE | The canonical asset is not present in this registry snapshot. A representation whose underlying is not a registered asset is never admissible. |
| `MND-REG-004` | `CANONICAL_ASSET_INACTIVE` | S_REGISTRY_STATE | The canonical asset status is not ACTIVE: it is delisted, superseded, or could not be established. A non-active asset resolves for audit but yields no admissible representation. |
| `MND-REG-005` | `REPRESENTATION_METADATA_CONFLICT` | T_REPRESENTATION_ADMISSIBILITY | Two or more claims at or above the trust floor disagree about a representation property the requirements constrain. A conflict fails closed unconditionally: it is never resolved by recency, trust precedence or source count. |
| `MND-REG-006` | `TRUST_REQUIREMENT_NOT_MET` | T_REPRESENTATION_ADMISSIBILITY | Every claim about a constrained representation property is below the required trust floor. Advisory and untrusted data can never establish a property that gates an execution. |
| `MND-REG-007` | `REPRESENTATION_METADATA_STALE` | T_REPRESENTATION_ADMISSIBILITY | Claims about a constrained representation property exist at or above the trust floor, but every one is older than the maximum claim age supplied with the requirements. A stale claim cannot establish a property and cannot create a conflict. |
| `MND-REG-008` | `BACKING_REQUIREMENT_NOT_MET` | T_REPRESENTATION_ADMISSIBILITY | The representation backing model is not in the set the requirements permit. Backing is checked separately from synthetic status: partially backed, collateralized and debt-linked instruments are not synthetic but do not satisfy a full-backing requirement. |
| `MND-REG-009` | `INSTRUMENT_TYPE_NOT_ALLOWED` | T_REPRESENTATION_ADMISSIBILITY | The representation instrument type is not in the set the requirements permit. |
| `MND-REG-010` | `RIGHTS_REQUIREMENT_NOT_MET` | T_REPRESENTATION_ADMISSIBILITY | A holder right the requirements demand is not present on this representation. Rights are per-right claims: absence of a required right rejects, and so does an unestablished one. |
| `MND-REG-011` | `REDEMPTION_REQUIREMENT_NOT_MET` | T_REPRESENTATION_ADMISSIBILITY | The representation redemption model is not in the set the requirements permit. |
| `MND-REG-012` | `SETTLEMENT_MODEL_NOT_ALLOWED` | T_REPRESENTATION_ADMISSIBILITY | The representation settlement model is not in the set the requirements permit. |
| `MND-REG-013` | `CORPORATE_ACTION_MODEL_NOT_ALLOWED` | T_REPRESENTATION_ADMISSIBILITY | The way this representation applies corporate actions is not in the set the requirements permit. This describes the representation semantics and is a different check from the verifier corporate-action epoch, which is the execution-time safety mechanism. |
| `MND-REG-014` | `JURISDICTION_NOT_ELIGIBLE` | T_REPRESENTATION_ADMISSIBILITY | The holder jurisdiction supplied with the requirements is prohibited for this representation, or is not among the jurisdictions the representation declares permitted. An undeclared jurisdiction is not permitted. |

## Reused kernel codes

Emitted by registry decisions with their kernel meaning unchanged. Defined in
[reason-codes.md](reason-codes.md).

| Name | Registry meaning |
| --- | --- |
| `REPRESENTATION_UNKNOWN` | The representation is not in this registry snapshot. An unregistered contract is never admissible, whatever its ticker, symbol or token metadata claims. |
| `REPRESENTATION_ASSET_MISMATCH` | The representation establishes a different canonical underlying than the requirements name. |
| `ISSUER_NOT_ALLOWED` | The established issuer is not in the permitted issuer set. |
| `CHAIN_NOT_ALLOWED` | The representation chain, read from its identity, is not in the permitted chain set. |
| `SYNTHETIC_NOT_ALLOWED` | The established backing model is synthetic and the mandate forbids synthetic exposure. |
| `REPRESENTATION_INACTIVE` | The established operational status is not ACTIVE. |
| `REPRESENTATION_METADATA_UNKNOWN` | A constrained property has no claims at all. Distinct from a property whose only claims are below the trust floor, which is TRUST_REQUIREMENT_NOT_MET. |

## User-facing wording

What an end user sees for each registry code. A registry decision returns codes
and machine-readable detail, never a rendered string.

| Name | Message |
| --- | --- |
| `ASSET_CLASS_UNSUPPORTED` | That kind of asset is not supported. |
| `ASSET_IDENTIFIER_INVALID` | An asset identifier in this request was not valid. |
| `ASSET_IDENTIFIER_SCHEME_UNSUPPORTED` | That kind of asset identifier is not supported. |
| `BACKING_REQUIREMENT_NOT_MET` | This token is not backed in the way your authorization requires. |
| `CANONICAL_ASSET_INACTIVE` | This asset is no longer available to trade. |
| `CANONICAL_ASSET_UNKNOWN` | That asset is not one this system recognizes. |
| `CORPORATE_ACTION_MODEL_NOT_ALLOWED` | This token handles corporate actions in a way your authorization does not permit. |
| `INSTRUMENT_TYPE_NOT_ALLOWED` | This token is not a kind of instrument your authorization permits. |
| `JURISDICTION_NOT_ELIGIBLE` | This token is not available to holders in your jurisdiction. |
| `REDEMPTION_REQUIREMENT_NOT_MET` | This token cannot be redeemed on terms your authorization requires. |
| `REFERENCE_AMBIGUOUS` | That name or symbol matches more than one asset. Please be more specific. |
| `REFERENCE_MALFORMED` | That is not something this system can look up. |
| `REFERENCE_UNKNOWN` | That asset is not one this system recognizes. |
| `REPRESENTATION_ID_MALFORMED` | A token identifier in this request was not valid. |
| `REPRESENTATION_METADATA_CONFLICT` | Information about this token disagreed between sources, so it was not used. |
| `REPRESENTATION_METADATA_STALE` | Information about this token was too old to rely on. |
| `RIGHTS_REQUIREMENT_NOT_MET` | This token does not carry a holder right your authorization requires. |
| `SETTLEMENT_MODEL_NOT_ALLOWED` | This token settles in a way your authorization does not permit. |
| `SNAPSHOT_MALFORMED` | The asset registry could not be read, so nothing was traded. |
| `TRUST_REQUIREMENT_NOT_MET` | Information about this token did not come from a source trusted for it. |
