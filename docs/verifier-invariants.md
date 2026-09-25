# Verifier invariants

What the Phase 1 kernel guarantees, and how each guarantee is established.

> **Status: Phase 5R.1, implemented.** Everything below is enforced by
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
| V-2 | **Total over parsed, plain values.** Every value `JSON.parse` can produce — plus the kernel's own value types — yields a receipt; nothing throws to signal a financial outcome. | `verify` takes `unknown` and parses at the boundary. 400 generated junk inputs, 200 JSON-round-tripped payloads, a 16×16 junk matrix and 200 partially-valid inputs all produce receipts. **Corrected in Phase 5R:** the claim was false at the encoding boundary — an unbounded collection made `trustedStateDigest` throw a `u16` range assertion, so a refusal produced no receipt at all. Every collection the encoders count is now bounded by its parser, tested below, at and above each limit, and the digest step is guarded so an internal invariant failure rejects with `VERIFIER_INTERNAL_ERROR` rather than escaping. **Scoped in Phase 5R.1** — see V-9 | TEST, PROPERTY |
| V-3 | **Deterministic.** Same inputs, same receipt, including the receipt digest. | Repeated verification is deep-equal; the corpus pins 57 receipts byte-for-byte | TEST |
| V-4 | **Fail-closed.** No path returns PASS when a constraint could not be established. `UNKNOWN` is a value that rejects. | Every `UNKNOWN` and every absent trusted input has a test asserting REJECT | TEST |
| V-5 | **Model-free.** No inference client is reachable, directly or transitively. | `structure.test.ts` scans import specifiers and asserts the runtime dependency set is exactly `@noble/hashes` and `@noble/curves`, whose own trees are verified dependency-free | CODE |
| V-6 | **Explaining.** A rejection names every violated constraint, not the first. | A four-violation case asserts all four; a property asserts that adding an independent violation masks none of the existing ones | TEST, PROPERTY |
| V-7 | **Order-independent.** The verdict does not depend on check order. | Checks are independent functions unioned and then sorted by reason-code id. 25 shuffled orders on a fixed world, plus 40 shuffled orders over generated worlds, all produce an identical receipt digest | TEST, PROPERTY |
| V-8 | **Reproducible from the receipt.** | The receipt carries digests of every input the verdict was computed over; the corpus is the executable form of this claim | TEST |
| V-9 | **The totality scope is stated, and failure outside it is one-directional.** Totality covers parsed, plain values, which is the scope of every external input in the system: a network response, a file, a provider quote, an adapter's translation. It is *not* a claim about a hostile host object — a `Proxy` with throwing traps, or a getter with a side effect, can make any JavaScript function fail. | A defence would mean serializing every input before parsing it, paid on every call, to close a hole that requires the caller to already be executing arbitrary code in the verifier's process. What is guaranteed outside the scope is the *direction*: a hostile object may make `verify` throw and must never make it return PASS, which is asserted. Before Phase 5R.1 the claim was stated unscoped (finding N-6) | TEST, PROPERTY |

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
| V-17 | **The signed economic bound is enforced here, and is symmetric.** BUY bounds notional plus fees against a maximum total debit; SELL bounds notional minus fees against a minimum total credit. | `checkEconomicLimit`, the only enforcement point. Boundary vectors at and one atom past each bound, both sides ([ADR 0014](adr/0014-symmetric-signed-economic-authorization.md)) | TEST |
| V-18 | Fee arithmetic takes no rounding decision. | `addAmounts` and `subtractAmounts` lift the coarser scale by a power of ten, which is exact. Only a unit mismatch, an overflow and a negative result can fail, and all three reject. A tolerance here would be a gap a fee could hide in | TEST |
| V-19 | A SELL whose fees reach the notional fails closed before any comparison. | `FEES_EXCEED_NOTIONAL`: a net debit has no defensible minimum credit to compare against | TEST |

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
| V-38 | **The chain a representation identifier carries is reconciled with the chain field beside it.** | `checkRepresentationChain`, on the candidate and on every trusted-state entry. `chainSegmentOf` reads only the half before the first `/`; the contract half is never touched, so V-37 is unchanged. Added in Phase 5R after a mainnet contract passed under an Arbitrum-only mandate | TEST |
| V-39 | **A candidate's state commitments are layered by the kind of fact each one carries** ([ADR 0017](adr/0017-layered-candidate-state-commitments.md)). | Three kinds, three rules. *Provenance* — `evaluationStateId` and `evaluationStateDigest` — is committed for audit and never compared, because the verifier sees one instant per call and cannot know whether it is the evaluation or the handoff. *Structural authority* — `registrySnapshotDigest` — is committed **and** compared for equality. *Dynamic facts* are not committed as values at all; they are re-evaluated by the check that owns each one. Phase 5R bound the whole state digest instead, which made every honest handoff against fresh state fail `CANDIDATE_STATE_MISMATCH` (finding N-1) | TEST, PROPERTY |
| V-39a | **A fresh trusted state that still satisfies every predicate verifies.** | A world re-observed later — new snapshot label, newer provenance on every input, a reference price moved inside the mandate bound — passes, and the whole-state digest is completely different. This was impossible before Phase 5R.1 and is the property that makes the handoff re-verification load-bearing rather than tautological | TEST |
| V-39b | **A fresh trusted state carrying a material change rejects for that change.** | Halt → `TRADING_HALTED`, inactive representation → `REPRESENTATION_INACTIVE`, moved price → `PRICE_DEVIATION_EXCEEDED`, advanced epoch → `CORPORATE_ACTION_STATE_CHANGED`, stale observation → `PRICE_STATE_STALE`, expiry → `MANDATE_EXPIRED`, consumption → `MANDATE_ALREADY_CONSUMED`. Each asserted by reason code, not by "no route was selected" — the weaker assertion was satisfied by the N-1 defect itself (finding N-2) | TEST |
| V-39c | **The registry snapshot does not change under a candidate.** | A registry snapshot is structural, not an observation: a different one can retire a representation, reassign an issuer or move a contract. `REGISTRY_SNAPSHOT_MISMATCH` on disagreement, `REGISTRY_SNAPSHOT_UNKNOWN` when the state declares none — absent provenance is not agreement. Enforced by the kernel against the candidate's commitment and by the router at both the evaluation and handoff stages, where a change is a routing-level refusal demanding a reroute, because the admissible *set* was computed against the old snapshot (finding N-8) | TEST |
| V-39d | **No security-relevant execution field escapes commitment.** | Every field of `CANDIDATE_FIELDS` changes the candidate digest, with no two mutations colliding, and the test is driven off the exported field list — so a field added without a mutation case fails rather than passing silently. The hierarchy above it is signed mandate digest → candidate digest → routing candidate digest → routing receipt digest, with the evaluation and handoff worlds committed separately | TEST |

## 5. Corporate actions and replay

| # | Property | How | Status |
| --- | --- | --- | --- |
| V-40 | An epoch ahead of the authorization rejects; the mandate is never rescaled (INV-9). | `CORPORATE_ACTION_STATE_CHANGED`. Recovery is reauthorization | TEST |
| V-41 | An epoch behind the authorization is inconsistent, not merely changed. | Distinct code, because an epoch feed running behind is a different fault | TEST |
| V-42 | An epoch feed is itself state that can go stale. | Corporate-action freshness is checked separately from the epoch value | TEST |
| V-43 | A candidate built against a different epoch rejects. | `CANDIDATE_STATE_MISMATCH`, which since Phase 5R.1 means only this and nothing else. A candidate built against a different *registry snapshot* is V-39c | TEST |
| V-44 | A consumed, reserved, quarantined or unknown authorization never executes (INV-12). | Four distinct codes; a replay record about another mandate is unknown, not unused | TEST |
| V-46 | **The passage of time never restores an authorization.** | A lapsed reservation quarantines; only `RECONCILE` leaves that state ([ADR 0015](adr/0015-replay-quarantine-and-reconciliation.md)). A test walks the whole transition vocabulary, plus the retired names, against a quarantined record | TEST, PROPERTY |
| V-47 | **Neither does an unsubstantiated command.** Every transition out of `RESERVED` or `QUARANTINED` requires a validated `ExecutionObservation` — outcome, observation time, source and reference — and the accepted observation is recorded on the resulting record, so a restore with no evidence behind it is visible afterwards. | `RELEASE` and `COMMIT` are removed: each was the assertion `RECONCILE` now makes, minus the evidence ([ADR 0018](adr/0018-observed-execution-outcomes.md)). It is a validated assertion, not a proof — confirming that a reference settled needs chain observation, which is Phase 6 (finding N-5) | TEST |
| V-48 | **No replay branch defaults to a favourable outcome, and none returns `undefined`.** | `RECONCILE` accepted only `SETTLED` by exact match and treated *everything else* as FAILED, so `'settled'`, `'UNKNOWN'`, `0`, `''`, `{}` and `undefined` all restored a quarantined authorization (finding N-3); and `applyTransition` switched on a caller-controlled string with no default, returning `undefined` for an unrecognized transition (finding N-4). Every caller-controlled field is now parsed before a branch is taken, the switch is exhaustive with a `never` guard, and the retired transition names are exported as data so their refusal is tested. TypeScript unions are erased at run time, which is the whole reason both defects existed | TEST |
| V-49 | **Every replay error is reachable.** | `ReplayError.KEY_MISMATCH` could not fire — nothing compared a record's key against anything — so it asserted an invariant that was not enforced (finding N-7). It is removed; key reconciliation belongs to the Phase 6 persistence layer that does the lookup. A test now asserts every member of the error set is produced by some call | TEST |
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
| V-56 | Jev independence as an end-to-end claim. Phase 1 establishes the structural half — no inference client is reachable — but there is no pipeline yet to test adversarially (INV-3). | **Established in Phase 5**, re-measured in Phase 5R |
| V-57 | That the evaluation instant is honest. The kernel accepts the instant it is given, which is what makes a verdict reproducible. The router enforces that the handoff instant is not earlier than the evaluation instant, but a caller that rewinds both consistently defeats every age bound and no off-chain component can detect it. | Execution gate, Phase 6 (INV-10) |
| V-58 | That a quarantined authorization is ever reconciled. Reconciliation needs chain observation. Its absence fails closed — the authorization stays unavailable — but liveness depends on it existing. | Phase 6 |
| V-59 | That a `RECONCILE`'s observation is *true*. The observation is validated for completeness, attribution and shape, and recorded; it is not verified against a chain. Whatever performs it is as trusted as the replay store (V-47). | Phase 6 |
| V-60 | That a candidate built against one registry snapshot is safe against a different one. There is no cross-snapshot compatibility proof; a changed snapshot fails closed and the caller reroutes (V-39c). | Later phase, if a proof is wanted |
