# Reason-code registry

> **Generated from `packages/kernel/src/reason-codes.ts`. Do not edit by hand.**
> Run `npm run docs:generate` after changing the registry;
> `packages/kernel/test/docs.test.ts` fails if this file drifts.

Reason codes are a public interface: they appear in receipts, in integrator
error handling, in the demo and in audit records
([design §10.3](mandate-design.md#103-reason-codes)).

## Rules

- **Stable.** `id` and `name` are permanent. A retired code stays retired and
  its id is never reused for a different meaning.
- **One code per distinct cause.** There is no generic `INVALID`.
- **Two messages.** `humanMessage` is safe to show an end user and leaks no
  identifier, address or internal structure. `developerMessage` states the
  condition precisely.
- **Data, not strings built at a call site.** The verifier returns codes and
  machine-readable detail; rendering is a separate layer (`explain.ts`), so it
  can be replaced or localized without touching a safety decision.
- **Every code is reachable.** A test asserts each one is actually produced by
  some verification, so the registry cannot accumulate dead entries.

`enforcementPoint` names the check family from
[design §10.2](mandate-design.md#102-check-families) that produces the code,
so this table doubles as a coverage map.

**49 codes across 8 families.**

## INPUT — structural well-formedness

| ID | Name | Enforcement point | Condition |
| --- | --- | --- | --- |
| `MND-INPUT-001` | `MALFORMED_MANDATE` | A_MANDATE_INTEGRITY | The mandate is not a well-formed canonical mandate: a field is missing, of the wrong type, or outside its permitted range. |
| `MND-INPUT-002` | `UNSUPPORTED_MANDATE_VERSION` | A_MANDATE_INTEGRITY | The mandate declares a schema version this verifier does not implement. Unknown versions are never interpreted leniently. |
| `MND-INPUT-003` | `MALFORMED_CANDIDATE` | G_INTENT_FIDELITY | The execution candidate is not well-formed: a field is missing, of the wrong type, or outside its permitted range. |
| `MND-INPUT-004` | `MALFORMED_TRUSTED_STATE` | F_MARKET_AND_CORPORATE_ACTION_STATE | The supplied trusted state is not well-formed: a field is missing, of the wrong type, or outside its permitted range. |
| `MND-INPUT-005` | `MALFORMED_AUTHORIZATION` | A_MANDATE_INTEGRITY | The authorization envelope is not well-formed: signature length, signer format or domain fields are invalid. |
| `MND-INPUT-006` | `MALFORMED_IDENTIFIER` | A_MANDATE_INTEGRITY | An identifier string violates the canonical charset, length or shape rules (ADR 0002). Identifiers are never trimmed, case-folded or otherwise repaired. |
| `MND-INPUT-007` | `UNIT_MISMATCH` | E_ECONOMIC_BOUNDS | Two quantities that must share a unit or decimal scale do not. No implicit conversion is performed. |
| `MND-INPUT-008` | `VALUE_OUT_OF_RANGE` | E_ECONOMIC_BOUNDS | A numeric value is negative where unsigned, or exceeds the maximum this encoding supports. Arithmetic is never allowed to wrap. |
| `MND-INPUT-009` | `NOTIONAL_INCONSISTENT` | E_ECONOMIC_BOUNDS | The candidate declared notional does not equal quantity multiplied by execution price, rounded either down or up. The declared value is never substituted with the recomputed one. |
| `MND-INPUT-010` | `VERIFIER_INTERNAL_ERROR` | A_MANDATE_INTEGRITY | A check raised an unexpected error. This is a defect in the verifier, and it fails closed: an internal fault produces a rejection, never a pass. |
| `MND-INPUT-011` | `RESOURCE_LIMIT_EXCEEDED` | F_MARKET_AND_CORPORATE_ACTION_STATE | An externally sized collection exceeds its declared bound. Every counted collection the kernel encodes has a parse-time limit, so an oversized input is a typed rejection rather than an encoder assertion. |

## AUTH — authorization scope

| ID | Name | Enforcement point | Condition |
| --- | --- | --- | --- |
| `MND-AUTH-001` | `MANDATE_EXPIRED` | B_AUTHORIZATION_SCOPE | The evaluation time is at or after the mandate expiry. Expiry is inclusive of rejection: t >= expiresAt rejects. |
| `MND-AUTH-002` | `MANDATE_NOT_YET_ACTIVE` | B_AUTHORIZATION_SCOPE | The evaluation time is before the mandate notBefore time. |
| `MND-AUTH-003` | `SIGNATURE_INVALID` | A_MANDATE_INTEGRITY | The authorization signature does not verify against the mandate digest under the declared scheme and domain. |
| `MND-AUTH-004` | `SIGNER_UNAUTHORIZED` | B_AUTHORIZATION_SCOPE | The signature recovered a valid signer, but that signer is not the mandate principal. A valid signature is not authorization unless it is the right party. |
| `MND-AUTH-005` | `AGENT_UNAUTHORIZED` | B_AUTHORIZATION_SCOPE | The acting agent presented with the candidate is not the agent named in the mandate. |
| `MND-AUTH-006` | `MANDATE_ALREADY_CONSUMED` | B_AUTHORIZATION_SCOPE | Replay state reports this mandate digest as already consumed. A consumed authorization never executes again. |
| `MND-AUTH-007` | `REPLAY_STATE_UNKNOWN` | B_AUTHORIZATION_SCOPE | Replay state for this mandate digest could not be established. Unknown replay state fails closed; it is never treated as unused. |
| `MND-AUTH-008` | `AUTHORIZATION_SCHEME_UNSUPPORTED` | A_MANDATE_INTEGRITY | The authorization envelope declares a signature scheme this verifier does not implement. An unrecognized scheme rejects; it is never skipped. |
| `MND-AUTH-009` | `AUTHORIZATION_DOMAIN_MISMATCH` | A_MANDATE_INTEGRITY | The authorization envelope domain does not match the domain the caller requires. The verifier never accepts whatever domain an envelope claims. |
| `MND-AUTH-010` | `MANDATE_RESERVED` | B_AUTHORIZATION_SCOPE | Replay state reports this mandate digest as reserved by an in-flight execution attempt. A reserved mandate is not available to a second attempt. |
| `MND-AUTH-011` | `MANDATE_QUARANTINED` | B_AUTHORIZATION_SCOPE | A previous attempt reserved this authorization and its outcome was never established, so the authorization is quarantined pending reconciliation. It may already have executed; permitting a second attempt would risk executing the same trade twice. |

## ASSET — financial identity

| ID | Name | Enforcement point | Condition |
| --- | --- | --- | --- |
| `MND-ASSET-001` | `CANONICAL_ASSET_MISMATCH` | C_ASSET_IDENTITY | The candidate names a different canonical asset than the mandate authorizes. |
| `MND-ASSET-002` | `REPRESENTATION_ASSET_MISMATCH` | C_ASSET_IDENTITY | The trusted representation state maps this representation to a canonical asset other than the one the mandate authorizes. |
| `MND-ASSET-003` | `REPRESENTATION_UNKNOWN` | C_ASSET_IDENTITY | No trusted representation state was supplied for the representation the candidate names. An unregistered representation is never admissible. |

## REPR — representation semantics

| ID | Name | Enforcement point | Condition |
| --- | --- | --- | --- |
| `MND-REPR-001` | `ISSUER_NOT_ALLOWED` | D_REPRESENTATION_SEMANTICS | The representation issuer is not in the mandate allowed-issuer set. |
| `MND-REPR-002` | `SYNTHETIC_NOT_ALLOWED` | D_REPRESENTATION_SEMANTICS | The representation is synthetic and the mandate forbids synthetic exposure. |
| `MND-REPR-003` | `REPRESENTATION_INACTIVE` | D_REPRESENTATION_SEMANTICS | The representation operational state is not ACTIVE: it is paused, deprecated or in transition. |
| `MND-REPR-004` | `REPRESENTATION_METADATA_UNKNOWN` | D_REPRESENTATION_SEMANTICS | A representation metadata field the mandate constrains is UNKNOWN. UNKNOWN on a constrained field rejects; it is never read as a default permit. |
| `MND-REPR-005` | `REPRESENTATION_ATTRIBUTES_MISMATCH` | G_INTENT_FIDELITY | The issuer or chain the candidate declares differs from the trusted representation state for that representation. The candidate does not get to describe the representation. |
| `MND-REPR-006` | `REPRESENTATION_CHAIN_INCONSISTENT` | C_ASSET_IDENTITY | The chain segment of a representation identifier disagrees with the chain field carried beside it. The identifier is the canonical source of chain identity, so a disagreement means one of the two describes a different deployment and both fail closed. |

## ECON — economic bounds

| ID | Name | Enforcement point | Condition |
| --- | --- | --- | --- |
| `MND-ECON-001` | `MAX_NOTIONAL_EXCEEDED` | E_ECONOMIC_BOUNDS | The candidate notional exceeds the mandate maximum notional. |
| `MND-ECON-002` | `PRICE_DEVIATION_EXCEEDED` | E_ECONOMIC_BOUNDS | The execution price deviates from the trusted reference price by more than the mandate maximum, measured in basis points and rounded up. |
| `MND-ECON-003` | `SIDE_MISMATCH` | G_INTENT_FIDELITY | The candidate side is not the side the mandate authorizes. |
| `MND-ECON-004` | `TOTAL_DEBIT_EXCEEDED` | E_ECONOMIC_BOUNDS | On a BUY, notional plus the candidate fee total exceeds the mandate economic limit, which a BUY mandate carries as a maximum total debit. Fees are part of what the principal spends, so they are inside the bound rather than beside it. |
| `MND-ECON-005` | `TOTAL_CREDIT_BELOW_MINIMUM` | E_ECONOMIC_BOUNDS | On a SELL, notional minus the candidate fee total is below the mandate economic limit, which a SELL mandate carries as a minimum total credit. A sale whose fees erode the proceeds past the principal floor is refused however good the execution price was. |
| `MND-ECON-006` | `FEES_EXCEED_NOTIONAL` | E_ECONOMIC_BOUNDS | On a SELL, the candidate fee total is greater than or equal to the notional, so the trade is a net debit rather than a credit. There is no defensible minimum credit to compare against, so it fails closed before the comparison. |

## STATE — observed market and corporate-action state

| ID | Name | Enforcement point | Condition |
| --- | --- | --- | --- |
| `MND-STATE-001` | `PRICE_STATE_STALE` | F_MARKET_AND_CORPORATE_ACTION_STATE | The reference price observation is older than the mandate market-data freshness bound at the evaluation time. |
| `MND-STATE-002` | `CORPORATE_ACTION_STATE_CHANGED` | F_MARKET_AND_CORPORATE_ACTION_STATE | The observed corporate-action epoch is ahead of the epoch the mandate was authorized under. Recovery is reauthorization; the mandate is never rescaled automatically. |
| `MND-STATE-003` | `CORPORATE_ACTION_STATE_INCONSISTENT` | F_MARKET_AND_CORPORATE_ACTION_STATE | The observed corporate-action epoch is behind the epoch the mandate was authorized under. The epoch source is inconsistent with the authorization and fails closed. |
| `MND-STATE-004` | `TRADING_HALTED` | F_MARKET_AND_CORPORATE_ACTION_STATE | The underlying is halted and the mandate halt policy forbids execution while halted. |
| `MND-STATE-005` | `MARKET_STATE_UNKNOWN` | F_MARKET_AND_CORPORATE_ACTION_STATE | A market state field the verifier requires is UNKNOWN: the halt status or the reference price could not be established. |
| `MND-STATE-006` | `CANDIDATE_STATE_MISMATCH` | G_INTENT_FIDELITY | The corporate-action epoch the candidate was constructed against differs from the observed epoch. The candidate was built against a different world than the one being verified. |
| `MND-STATE-007` | `CORPORATE_ACTION_STATE_UNKNOWN` | F_MARKET_AND_CORPORATE_ACTION_STATE | The corporate-action epoch for this asset could not be established. An unknown epoch fails closed; it is never assumed to match the authorization. |
| `MND-STATE-008` | `CORPORATE_ACTION_STATE_STALE` | F_MARKET_AND_CORPORATE_ACTION_STATE | The corporate-action observation is older than the mandate corporate-action freshness bound at the evaluation time. A fresh epoch feed is itself state that can go stale. |

## NET — network and venue

| ID | Name | Enforcement point | Condition |
| --- | --- | --- | --- |
| `MND-NET-001` | `CHAIN_NOT_ALLOWED` | C_ASSET_IDENTITY | The candidate chain is not in the mandate allowed-chain set. |
| `MND-NET-002` | `VENUE_NOT_ALLOWED` | G_INTENT_FIDELITY | The candidate venue is not in the mandate allowed-venue set. |

## TRUST — trust-level violations

| ID | Name | Enforcement point | Condition |
| --- | --- | --- | --- |
| `MND-TRUST-001` | `UNTRUSTED_REQUIRED_STATE` | F_MARKET_AND_CORPORATE_ACTION_STATE | A required state input carries an ADVISORY or UNTRUSTED provenance. Advisory and untrusted sources can never satisfy an authoritative or verified input. |
| `MND-TRUST-002` | `TRUSTED_STATE_MISSING` | F_MARKET_AND_CORPORATE_ACTION_STATE | A required trusted state input was not supplied at all. Absent trusted state fails closed. |

## User-facing wording

What an end user sees for each code. Produced by `explain()`, never by the
verifier itself.

| Name | Message |
| --- | --- |
| `AGENT_UNAUTHORIZED` | This trade was proposed by an agent that is not authorized here. |
| `AUTHORIZATION_DOMAIN_MISMATCH` | This approval was issued for a different application or network. |
| `AUTHORIZATION_SCHEME_UNSUPPORTED` | The approval method used for this authorization is not supported. |
| `CANDIDATE_STATE_MISMATCH` | The proposed trade was prepared against outdated information. |
| `CANONICAL_ASSET_MISMATCH` | The selected asset does not match your authorization. |
| `CHAIN_NOT_ALLOWED` | This trade would execute on a network your authorization does not permit. |
| `CORPORATE_ACTION_STATE_CHANGED` | A corporate action has changed this asset since you approved. Approve again to continue. |
| `CORPORATE_ACTION_STATE_INCONSISTENT` | Corporate action information for this asset was inconsistent. |
| `CORPORATE_ACTION_STATE_STALE` | Corporate action information for this asset was too old to trade against. |
| `CORPORATE_ACTION_STATE_UNKNOWN` | Corporate action information for this asset was unavailable. |
| `FEES_EXCEED_NOTIONAL` | The fees on this sale would consume the entire proceeds. |
| `ISSUER_NOT_ALLOWED` | This token comes from an issuer your authorization does not permit. |
| `MALFORMED_AUTHORIZATION` | The approval attached to this authorization could not be read. |
| `MALFORMED_CANDIDATE` | The proposed trade could not be read and was not executed. |
| `MALFORMED_IDENTIFIER` | An identifier in this request was not valid. |
| `MALFORMED_MANDATE` | This authorization could not be read and was not used. |
| `MALFORMED_TRUSTED_STATE` | Market information was unusable, so the trade was not executed. |
| `MANDATE_ALREADY_CONSUMED` | This authorization has already been used. |
| `MANDATE_EXPIRED` | This authorization has expired. Approve the trade again to continue. |
| `MANDATE_NOT_YET_ACTIVE` | This authorization is not active yet. |
| `MANDATE_QUARANTINED` | A previous attempt on this authorization is still unresolved, so it cannot be used again yet. |
| `MANDATE_RESERVED` | This authorization is already being used by another trade in progress. |
| `MARKET_STATE_UNKNOWN` | Market information for this asset was unavailable. |
| `MAX_NOTIONAL_EXCEEDED` | This trade is larger than the amount you authorized. |
| `NOTIONAL_INCONSISTENT` | The quantity, price and total of this trade did not agree. |
| `PRICE_DEVIATION_EXCEEDED` | The price moved further from the reference than your authorization allows. |
| `PRICE_STATE_STALE` | Price information was too old to trade against. |
| `REPLAY_STATE_UNKNOWN` | This authorization could not be checked against previous use. |
| `REPRESENTATION_ASSET_MISMATCH` | The selected token does not represent the asset you authorized. |
| `REPRESENTATION_ATTRIBUTES_MISMATCH` | The details of the proposed trade did not match the token it names. |
| `REPRESENTATION_CHAIN_INCONSISTENT` | The network named for this token did not match the token itself. |
| `REPRESENTATION_INACTIVE` | Trading in this token is currently suspended. |
| `REPRESENTATION_METADATA_UNKNOWN` | Required information about this token was unavailable. |
| `REPRESENTATION_UNKNOWN` | The selected token is not recognized and was not traded. |
| `RESOURCE_LIMIT_EXCEEDED` | This request was larger than the system accepts and was not used. |
| `SIDE_MISMATCH` | This trade is in the opposite direction to your authorization. |
| `SIGNATURE_INVALID` | The approval for this authorization was not valid. |
| `SIGNER_UNAUTHORIZED` | This authorization was approved by someone who does not own the account. |
| `SYNTHETIC_NOT_ALLOWED` | This token is synthetic exposure, which your authorization does not allow. |
| `TOTAL_CREDIT_BELOW_MINIMUM` | After fees, this sale would return less than you authorized. |
| `TOTAL_DEBIT_EXCEEDED` | The full cost of this trade, including fees, is more than you authorized. |
| `TRADING_HALTED` | Trading in this asset is halted. |
| `TRUSTED_STATE_MISSING` | Information required to check this trade was not available. |
| `UNIT_MISMATCH` | The amounts in this request were expressed in incompatible units. |
| `UNSUPPORTED_MANDATE_VERSION` | This authorization uses a newer format than this system supports. |
| `UNTRUSTED_REQUIRED_STATE` | Information required to check this trade came from a source that is not trusted for it. |
| `VALUE_OUT_OF_RANGE` | A value in this request was outside the supported range. |
| `VENUE_NOT_ALLOWED` | This trade would execute at a venue your authorization does not permit. |
| `VERIFIER_INTERNAL_ERROR` | This trade could not be checked and was not executed. |
