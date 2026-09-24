# Verifier invariants

What the Phase 1 kernel guarantees, and how each guarantee is established.

> **Status: Phase 1, implemented.** Everything below is enforced by
> `packages/kernel` and covered by its test suite. Product-level invariants
> INV-1…INV-18 are in
> [mandate-design.md §16](mandate-design.md#16-major-invariants); this document
> maps the ones Phase 1 touches onto the code and the tests that establish them.

Status column: **CODE** — a structural property of the package, checked by a
test that reads the sources or the dependency tree. **TEST** — established by
behavioural tests. **PROPERTY** — established over generated inputs.
**DEFERRED** — belongs to a later phase; named here so it is not assumed.

## 1. The verifier's contract

| # | Property | How | Status |
| --- | --- | --- | --- |
| V-1 | **Pure.** No network, filesystem, clock, randomness or environment. Time is a parameter. | `structure.test.ts` scans every kernel source for forbidden imports and for `Date.now`, `new Date`, `Math.random`, `process.env`, `fetch(`, timers | CODE |
| V-2 | **Total.** Every input yields a receipt; nothing throws to signal a financial outcome. | `verify` takes `unknown` and parses at the boundary. 400 generated junk inputs, a 16×16 junk matrix, and 200 partially-valid inputs all produce receipts | TEST, PROPERTY |
| V-3 | **Deterministic.** Same inputs, same receipt, including the receipt digest. | Repeated verification is deep-equal; the corpus pins 57 receipts byte-for-byte | TEST |
| V-4 | **Fail-closed.** No path returns PASS when a constraint could not be established. `UNKNOWN` is a value that rejects. | Every `UNKNOWN` and every absent trusted input has a test asserting REJECT | TEST |
| V-5 | **Model-free.** No inference client is reachable, directly or transitively. | `structure.test.ts` scans import specifiers and asserts the runtime dependency set is exactly `@noble/hashes` and `@noble/curves`, whose own trees are verified dependency-free | CODE |
| V-6 | **Explaining.** A rejection names every violated constraint, not the first. | A four-violation case asserts all four; a property asserts that adding an independent violation masks none of the existing ones | TEST, PROPERTY |
| V-7 | **Order-independent.** The verdict does not depend on check order. | Checks are independent functions unioned and then sorted by reason-code id. 25 shuffled orders on a fixed world, plus 40 shuffled orders over generated worlds, all produce an identical receipt digest | TEST, PROPERTY |
| V-8 | **Reproducible from the receipt.** | The receipt carries digests of every input the verdict was computed over; the corpus is the executable form of this claim | TEST |

## 2. Units and arithmetic

| # | Property | How | Status |
| --- | --- | --- | --- |
| V-10 | A quantity without a unit and a decimal scale is not representable (INV-18). | `Amount` and `Price` carry them; `Price` is a ratio of two *named* units, so a shares/dollars transposition cannot type-check | CODE |
| V-11 | No floating point participates in a safety decision (INV-16). | All arithmetic is `bigint`. `structure.test.ts` rejects float literals, `parseFloat` and `Math` arithmetic anywhere in the kernel | CODE |
| V-12 | A `number` is never accepted where an integer value is meant. | `parseBigInt` accepts a `bigint` or a decimal string and nothing else, so the safe/unsafe boundary does not depend on magnitude | TEST |
| V-13 | Comparison across differing decimal scales loses no precision. | `compareAmounts` cross-multiplies instead of rescaling either side | TEST |
| V-14 | Deviation is never understated. | `deviationBps` rounds up | TEST |
| V-15 | Arithmetic never wraps. | Every parser bounds its value; a value one past the `uint256` maximum is `VALUE_OUT_OF_RANGE`, pinned by a corpus vector | TEST |
| V-16 | A declared notional that disagrees with quantity × price rejects. | Accepted only if it equals the product rounded down or up — a one-atom band, which still catches a 10× error or a decimal transposition | TEST |

## 3. Encoding, digests and authorization

| # | Property | How | Status |
| --- | --- | --- | --- |
| V-20 | One semantic mandate has exactly one encoding. | Sets sorted by encoded bytes with duplicates rejected; ASCII-only identifiers; fixed-width integers; trailing bytes rejected. `encode(decode(b)) == b` over every corpus vector | TEST, PROPERTY |
| V-21 | Any change to any signed field changes the digest. | All 21 mandate fields mutated individually, with no two mutations colliding | TEST |
| V-22 | Distinct mandates do not share a digest. | Injectivity over 300 generated mandates | PROPERTY |
| V-23 | A digest over one object type cannot be replayed as another. | Per-object-type domain tags; a candidate encoding never decodes as a mandate | TEST |
| V-24 | The mandate digest is chain-agnostic. | The EIP-712 domain lives in the envelope. One digest signed under two chain IDs produces two signatures over one unchanged digest | TEST |
| V-25 | An unknown schema version rejects rather than being parsed leniently. | `UNSUPPORTED_MANDATE_VERSION`, distinct from malformed | TEST |
| V-26 | A signature is not authorization. | Recovery and principal identity are separate checks with separate codes: `SIGNATURE_INVALID` against `SIGNER_UNAUTHORIZED` | TEST |
| V-27 | One authorization cannot be presented in two forms. | High-`s` signatures rejected under EIP-2; only canonical `v ∈ {27, 28}` accepted | TEST |
| V-28 | A signature for one application or network cannot authorize under another. | The expected domain is caller-supplied and required; the envelope's claim is never taken | TEST |
| V-29 | An unrecognized authorization scheme rejects rather than being skipped. | `AUTHORIZATION_SCHEME_UNSUPPORTED` | TEST |

## 4. Trust, state and time

| # | Property | How | Status |
| --- | --- | --- | --- |
| V-30 | Advisory or untrusted provenance never satisfies a required input (INV-4). | Refused at parse time *and* re-asserted at run time, because neither a parser nor a TypeScript brand survives on a hand-built object reaching an internal entry point | TEST |
| V-31 | Every observed value carries provenance and an observation time (INV-17). | `Observed<T>` is the only shape trusted state accepts | CODE |
| V-32 | Absent required trusted state fails closed. | `TRUSTED_STATE_MISSING` for each of market, corporate-action and replay | TEST |
| V-33 | Freshness is enforced against the evaluation instant, on both sides of the bound. | Ages 59, 60 and 61 against a 60-second bound | TEST |
| V-34 | An observation from the future fails closed. | Freshness cannot be established, so it is `MARKET_STATE_UNKNOWN` rather than maximally fresh | TEST |
| V-35 | Validity-window boundaries are exact and expiry is exclusive. | `expiresAt − 1` passes, `expiresAt` and `expiresAt + 1` reject; `notBefore − 1` rejects, `notBefore` passes | TEST |
| V-36 | Ageing state never restores eligibility. | Monotonicity over an increasing age sequence | PROPERTY |
| V-37 | An address used in execution originates only from trusted state (INV-7). | The candidate's `representationId` resolves through trusted state or it is `REPRESENTATION_UNKNOWN`; the kernel never parses an address out of an identifier | TEST |

## 5. Corporate actions and replay

| # | Property | How | Status |
| --- | --- | --- | --- |
| V-40 | An epoch ahead of the authorization rejects; the mandate is never rescaled (INV-9). | `CORPORATE_ACTION_STATE_CHANGED`. Recovery is reauthorization | TEST |
| V-41 | An epoch behind the authorization is inconsistent, not merely changed. | Distinct code, because an epoch feed running behind is a different fault | TEST |
| V-42 | An epoch feed is itself state that can go stale. | Corporate-action freshness is checked separately from the epoch value | TEST |
| V-43 | A candidate built against a different epoch or snapshot rejects. | `CANDIDATE_STATE_MISMATCH` | TEST |
| V-44 | A consumed, reserved or unknown authorization never executes (INV-12). | Three distinct codes; a replay record about another mandate is unknown, not unused | TEST |
| V-45 | Replay rules are pure; the store is outside the kernel. | `applyTransition` is a pure state transition. See [replay-semantics.md](replay-semantics.md) | CODE |

## 6. Explicitly not guaranteed by Phase 1

Named so nothing downstream assumes them.

| # | Not guaranteed | Whose job |
| --- | --- | --- |
| V-50 | That the submitted transaction is the verified one (INV-13). | Execution gate, Phase 6 |
| V-51 | That an authorization reflects what a human meant. | Nobody. Mandate enforces the mandate, not the intention behind it ([design §17.6](mandate-design.md#176-honest-statement-of-limits)) |
| V-52 | That trusted state is *true*. The kernel checks provenance, freshness and internal consistency, not accuracy. | Adapters, Phase 3; registry curation, Phase 2 |
| V-53 | That the replay store applies transitions atomically. A read-then-write store with no compare-and-swap permits a double reserve the kernel cannot detect. | Integrator. Stated in [replay-semantics.md §8](replay-semantics.md#8-what-the-kernel-does-not-do) |
| V-54 | Anything about partial fills. | Settlement abstraction, `FUTURE` |
| V-55 | That two independent implementations agree. The corpus is the *mechanism*; only one implementation exists today. | Phase 6, when the on-chain gate becomes the second |
| V-56 | Jev independence as an end-to-end claim. Phase 1 establishes the structural half — no inference client is reachable — but there is no pipeline yet to test adversarially (INV-3). | Phase 5 |
