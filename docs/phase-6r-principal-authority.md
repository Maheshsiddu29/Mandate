# Phase 6R principal-authority matrix

**Status:** Phase 6R implementation specification. The settlement path remains a
labelled fixture, not a live venue or real-market integration.

The principal signs MCE v2. The agent signs Candidate V3 and the execution
terms. An agent signature authenticates the agent's choices; it does not make
those choices principal-authorized. The execution gate therefore has to prove
that every static candidate choice in its declared scope is a subset of the
principal's signed mandate.

| Field or constraint | Principal-signed | Agent-selected | Immutable market-derived | Onchain enforcement after Phase 6R | Offchain-only | State kind | Phase 6 fixture | Future real-market requirement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Principal | Yes | No | No | Signature signer and settlement recipient must equal the signed principal | No | Static | Supported | Same |
| Authorized agent/session | Yes | Candidate and execution are signed by it | No | Candidate agent and execution signer must equal the signed agent | No | Static | Supported, EOA only | ERC-1271 requires a later explicit decision |
| Canonical asset | Yes | Candidate repeats it | Market pins asset identity | Candidate, mandate, and market hashes must agree | No | Static | Supported | Same, plus reviewed registry evidence |
| Side | Yes | Candidate repeats it | No | Exact equality | No | Static | Supported | Same |
| Permitted representation | No separate MCE v2 allowlist | Selects `representationId` | Address is resolved only through the immutable market table | Supported market, canonical asset, issuer, venue, chain, unit and synthetic policy jointly constrain selection | Representation preference is not separately expressible by MCE v2 | Static | Supported within the fixture table | A new principal field would require a later schema decision; Phase 6R does not add one |
| Issuer restrictions | Yes | Candidate repeats issuer | Market pins issuer | Candidate must equal market; market issuer must be allowed | No | Static | Supported | Same, with reviewed registry evidence |
| Chain restrictions | Yes | Candidate repeats chain | Deployment pins chain ID | Candidate must name deployment chain and mandate must allow it | No | Static | Supported | Same |
| Venue restrictions | Yes | Candidate repeats venue | Market pins adapter and venue identifier | Candidate must equal market; market venue must be allowed | No | Static | Supported | Venue code/proxy trust must be recorded at deployment |
| Product/synthetic restriction | Yes | Representation selection determines product | Market pins synthetic flag | Synthetic market refused when forbidden | Non-synthetic product taxonomy is not present in MCE v2 | Static | Supported for the binary synthetic policy | Richer product policy needs an explicit later schema and registry decision |
| Quantity semantics | Candidate quantity is not separately principal-signed | Yes | Market pins unit and token decimals | Quantity must use the pinned unit/scale; price/notional must agree; successful BUY credit and SELL debit must equal it | Principal has no independent exact-quantity field | Static execution fact | Supported as exact Candidate V3 FILL_OR_KILL | Same; multiplier changes require authenticated state |
| `maxNotional` | Yes | Candidate declares notional **and chooses its precision** | Market pins settlement unit and fixture price | The true quantity × pinned fixture price, rendered at the principal's signed `maxNotional.decimals` and rounded up, must be at or below the signed atoms; the declared notional must be too. Candidate precision cannot move this bound (Phase 6R.1, M-1) | No | Static arithmetic | Supported | Same, against an authenticated inclusion-time price |
| Execution price and declared notional | No, except through signed constraints | Yes | Quantity unit, settlement unit, and the engineered fixture price are pinned; the constructor proves the fixture venue settles at that same economic price | Candidate price must equal the immutable fixture price by exact scaled comparison; quantity × price must equal declared notional within the kernel's exact floor/ceil one-atom band | Real-market reference-price comparison remains offchain | Static fixture fact plus dynamic real-market comparison | Supported only at the fixture's construction-time price | Authenticated reference price and freshness required at inclusion |
| Fee total and economic limit | Economic limit is signed; fee total is agent-selected | Yes | Settlement unit and funding decimals are pinned | Candidate notional ± fee total must satisfy the signed limit; measured BUY debit and SELL credit must also satisfy it | No for the declared and measured limits | Static arithmetic and settlement fact | Supported | Same |
| Currency/unit | `maxNotional` and economic-limit unit are signed | Candidate supplies price, notional, and fee units | Market pins quantity and settlement units | All economic numerator/notional/fee/mandate units must equal the pinned settlement unit; price denominator must equal quantity unit | No | Static | Supported | Same |
| Validity window | Yes | Agent adds a deadline | No | `notBefore` inclusive, expiry exclusive, deadline inclusive | No | Chain-time dynamic | Supported | Same, subject to chain timestamp bounds |
| Nonce/replay | Yes | No | No | Full mandate digest, including nonce, is single-use | Offchain reservation remains advisory | Static plus canonical-chain state | Supported | Same with finality-aware reconciliation |
| Corporate-action epoch | Required epoch is signed; candidate declares observed epoch | Yes | No authenticated source in fixture | Committed by signatures but deliberately not compared onchain | Kernel handoff verification | Dynamic | Excluded from fixture guarantee | Inclusion-time authoritative source or attestation required |
| Price deviation/freshness | Bounds are signed | Candidate declares execution price and state provenance | No authenticated source in fixture | Units and arithmetic only; no reference-price or age assertion | Kernel handoff verification | Dynamic | Excluded from fixture guarantee | Inclusion-time authoritative source or attestation required |
| Halt and operational state | Halt policy and freshness bounds are signed | Candidate commits provenance | No authenticated source in fixture | Not asserted | Kernel handoff verification | Dynamic | Excluded from fixture guarantee | Inclusion-time authoritative source or attestation required |
| Registry snapshot | Mandate does not carry the snapshot; Candidate V3 commits it | Yes | No onchain registry root in fixture | Digest is authenticated but not compared | Kernel compares handoff trusted state | Dynamic/structural | Excluded from fixture guarantee | Inclusion-time authoritative root or attestation required |

## Declared Phase 6R overlap with the kernel

The actual kernel is authoritative for the frozen semantics. Phase 6R declares
the following kernel rejection families to be onchain responsibilities:

| Kernel reason | Gate responsibility |
| --- | --- |
| `AGENT_MISMATCH`, `SIDE_MISMATCH`, `CANONICAL_ASSET_MISMATCH` | `ONCHAIN_ENFORCED` |
| issuer, chain, venue, representation, synthetic-policy and quantity-unit violations | `ONCHAIN_ENFORCED` through the immutable fixture market |
| `UNIT_MISMATCH` in quantity/price/notional/fee comparisons | `ONCHAIN_ENFORCED` |
| `NOTIONAL_INCONSISTENT`, `MAX_NOTIONAL_EXCEEDED` | `ONCHAIN_ENFORCED` |
| `TOTAL_DEBIT_EXCEEDED`, `TOTAL_CREDIT_BELOW_MINIMUM`, `FEES_EXCEED_NOTIONAL` | `ONCHAIN_ENFORCED`, then independently checked against measured settlement deltas |
| fixture-price mismatch | `ONCHAIN_ENFORCED` for the engineered fixed-price fixture |
| real-market reference-price deviation/freshness, halt/operational state, corporate-action epoch/freshness, registry snapshot | `OFFCHAIN_DYNAMIC_FIXTURE_ONLY`; `FUTURE_REAL_MARKET_ATTESTATION_REQUIRED` |
| parser-only, replay-reservation, advisory-ranking and reconciliation-policy reasons | `NOT_APPLICABLE_TO_GATE` |

## Real-market stop condition

The Phase 6 gate may be configured only for `FIXTURE` markets. A future
`REAL_MARKET` configuration is prohibited until the gate can authenticate an
inclusion-time state source binding the gate, chain, representation, registry
snapshot, halt and operational status, corporate-action epoch, multiplier,
reference price, observation time and expiry. Phase 6R does not fabricate that
source.
