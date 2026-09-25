# Production architecture pressure test

An adversarial review of the Mandate system as built through the end of Phase 5,
conducted on the assumption that it will eventually protect and route real-money
tokenized-asset transactions.

> **Status: review document, 2026-09-25. Findings remediated in Phase 5R.**
> This is an internal engineering pressure test, not a third-party audit. It
> reviews the repository at commit `d9c2580` plus the three evidence commits it
> produced. It did **not** open Phase 6 and changed no production code.
>
> Claims in prior phase documents were not taken on trust. Every property
> asserted below as verified was re-derived from the implementation, and the ones
> that failed were pinned as executable tests in
> `packages/{kernel,router,jev}/test/pressure-test-findings.test.ts`.
>
> **The body of this report is preserved as written.** Phase 5R remediated the
> findings; it did not revise the history. The remediation status of every
> finding is in [§24](#24-remediation-status-phase-5r), and the defect-pinning
> tests have been inverted into regression tests in place, so no test in this
> repository now passes because a vulnerability was retained. Where this document
> says a thing is broken, read it as *was broken at `d9c2580`*.

---

## 1. Executive assessment

The decision layer is unusually well built. The separation that matters —
canonical financial identity from token representation, admissibility from
quality, advice from authority — is real in the code and not merely asserted in
the documents. The advisory layer's independence property is the strongest thing
in the repository: it was re-measured directly during this review and it holds
exactly as claimed. The encoding is canonical, the arithmetic is exact, the
refusals are explained, and the registry's claim model gets the non-obvious rule
right (a sub-floor claim can neither establish a value nor create a conflict).

Three things are nevertheless wrong in ways that matter, and one of them is a
documented safety property that the code does not implement.

1. **`RECLAIM` reopens a live authorization.** `replay-semantics.md` §6 says an
   attempt whose outcome was never established leaves the mandate unavailable,
   and that the reservation is clamped to the mandate's expiry "so nothing is
   held past the point where the authorization is dead anyway". The clamp is
   one-directional. Any caller-chosen reservation shorter than the mandate's
   remaining validity returns the authorization to `UNUSED` while a submitted
   transaction may still settle — which is precisely the double execution that
   `RELEASE` is forbidden from causing. This is the most serious finding in the
   review and it is a small fix.

2. **The all-in economic bound is enforced outside the authoritative layer, and
   is in no digest.** `ExecutionCandidate` carries no fee field, `encodeCandidate`
   commits to none, and the kernel's `maxNotional` check bounds the notional
   alone. The kernel — described throughout as the only component that
   authorizes — passes a route whose fees are twice the mandate cap. The router
   catches it. Nothing an on-chain gate reconstructs from `candidateDigest` can.
   A related gap is that a SELL mandate cannot bound its own proceeds at all: a
   sale netting one atom is admissible.

3. **The time-of-check/time-of-use window between closing the candidate set and
   handing off is closed only by an optional parameter, and the deterministic
   path cannot close it at all.** `selectEvaluated` re-verifies against the same
   state object it evaluated over, making the check a tautology;
   `selectWithJev`'s `handoffState` defaults to the same. Both `decide.ts` and
   `security-review.md` describe the re-verification as unconditional.

Alongside these, `verify()` and `route()` throw rather than returning a verdict
when an externally-sized collection crosses the `u16` encoding width. No PASS is
produced, so nothing unsafe is authorized — but totality (V-2) and
"every refusal is explainable from its receipt" (INV-11) are both stated
invariants, and both are false at the boundary.

**Answer to the primary question.** Within Phase 5 there is no path by which
unauthorized intent, an invalid representation, manipulated route data, model
output, replayed authorization or malformed external input produces a candidate
the kernel calls safe. Every such path was traced and each is closed. There
*are* two paths by which an execution candidate could be treated as *within
authority* when it is not, and both are economic rather than identity-based:
fees outside the kernel's view (F-2) and unbounded fee erosion on a SELL (F-4).
And there is one path — `RECLAIM` (F-1) — by which an already-spent
authorization becomes spendable again. None of these depends on an adversary;
ordinary operation reaches them.

**Verdict: ARCHITECTURE SOUND WITH REQUIRED REMEDIATIONS.** Phases 1–5 need no
redesign. They need one mandate schema addition, which must land before Phase 6
freezes the digest an on-chain gate re-asserts, plus four bounded fixes.

---

## 2. Method, and what was not verified

| Dimension | How it was reviewed |
| --- | --- |
| Authority boundaries, cryptographic binding, versioning | Read every field's origin, parser, check and encoder in `kernel`, `registry`, `router`, `jev` |
| TOCTOU, replay, concurrency | Traced each transition; executed probes for the reservation window, the handoff window and the clock |
| Jev independence | Re-measured with a choosing transport against the deterministic baseline |
| Determinism | Executed: representation ordering, object key ordering, allowlist authoring order, repeat evaluation |
| Resource exhaustion | Located every counted collection and compared its parser's bound to its encoder's width |
| Dependency failure | Read both network clients and every status/throw path; classified each outcome |
| Economic correctness | Executed probes for fee visibility, SELL erosion, deviation symmetry, zero quantity |
| Test-coverage adequacy | Enumerated the representation and mutation diversity of every committed corpus |

**Not verified, and not claimed.** No live Robinhood or TypeSafe call was made.
No Solidity exists, so no differential test between an off-chain and an on-chain
decision was possible — the corpus is the mechanism for that and the second
implementation does not exist yet. Concurrency was reasoned about and not raced:
there is no store to race against. Chain reorgs were reasoned about only, for
the same reason. Whether trusted state is *true* is out of scope here as it is
in the kernel (V-52).

---

## 3. System trust boundary diagram

```
╔══════════════════════════════════════════════════════════════════════════════╗
║ OUTSIDE THE BOUNDARY — hostile by assumption                                 ║
║                                                                              ║
║  principal's wallet     route providers      Robinhood REST / RPC            ║
║  (signs; key is the     (untrusted quotes)   Chainlink feeds                 ║
║   root of authority)                          TypeSafe Jev (untrusted model) ║
╚════════╤═══════════════════════╤══════════════════════╤═══════════╤══════════╝
         │ signature             │ unknown              │ unknown   │ a string
         │                       │                      │           │
╔════════▼═══════════════════════▼══════════════════════▼═══════════▼══════════╗
║ INSIDE — the trusted computing base                                          ║
║                                                                              ║
║  ┌──────────────────────────────────────────────────────────────────────┐    ║
║  │ ORCHESTRATOR  (not a package; the integrator's process)              │    ║
║  │ supplies: clock, trustedState, stateId, handoffState,                │◀───╫── F-9
║  │           reservationSeconds, expectedDomain, registry snapshot      │    ║   F-1
║  │ FULLY TRUSTED AND UNCONSTRAINED. The weakest boundary in the system. │    ║   F-5
║  └────────┬──────────────────────────────┬──────────────────────────────┘    ║
║           │                              │                                   ║
║  ┌────────▼─────────┐   ┌────────────────▼──────────┐   ┌────────────────┐   ║
║  │ adapter-robinhood│   │ registry                  │   │ router         │   ║
║  │ strict parsing,  │──▶│ identity, claims, trust   │◀──│ candidates,    │   ║
║  │ provenance       │   │ floor, conflict-fails-    │   │ costs, ranking │   ║
║  │ (network)        │   │ closed, snapshot digest   │   │ (pure)         │   ║
║  └──────────────────┘   └────────────┬──────────────┘   └───────┬────────┘   ║
║                                      │                          │            ║
║                         ╔════════════▼══════════════════════════▼═════════╗  ║
║                         ║ KERNEL — the only authority                     ║  ║
║                         ║ pure · total · fail-closed · model-free         ║  ║
║                         ║ verify() -> PASS | REJECT + reason codes        ║  ║
║                         ╚════════════════════════╤═══════════════════════╝  ║
║                                                  │ PASS only                 ║
║  ┌───────────────────────────────────────────────▼───────────────────────┐   ║
║  │ jev  advisory. Receives a 12-field projection. Returns one string,    │   ║
║  │      used only as a key into a local array. Re-verified after.        │   ║
║  └───────────────────────────────────────────────┬───────────────────────┘   ║
╚══════════════════════════════════════════════════╤═══════════════════════════╝
                                                   │ execution handoff
                          ┌────────────────────────▼────────────────────────┐
                          │ PHASE 6 — DOES NOT EXIST                        │
                          │ transaction construction, on-chain gate,        │
                          │ atomic replay, chain-sourced time               │
                          └─────────────────────────────────────────────────┘
```

The diagram's point: the orchestrator is inside the boundary and is the only
component inside it that is neither pure, nor bounded, nor tested. Every arrow
labelled with a finding enters there.

---

## 4. Trusted computing base

Reduced to the minimum that must be correct for a Phase 5 decision to mean what
it says.

| Component | If compromised, it could cause | Trust necessary? |
| --- | --- | --- |
| **Principal's signing key** | Anything. It is the root of authority. | Irreducible |
| **`packages/kernel`** | Any unsafe execution. It is the only authority. | Irreducible. Correctly minimized: 2 audited crypto deps, no I/O, no clock, no model, structurally enforced |
| **`@noble/hashes`, `@noble/curves`** | Digest or signature forgery | Irreducible given EVM keccak/secp256k1. Verified dependency-free |
| **Registry curation** | An attacker-controlled contract admitted as a legitimate representation, under a valid mandate | Irreducible. This is the highest-leverage non-key asset in the system and has no change-control mechanism in Phase 5 |
| **Orchestrator: clock** | Every freshness bound, expiry and not-before defeated by rewinding (**F-9**, executed) | **Reducible.** Phase 6 must anchor safety-critical time on chain (INV-10) |
| **Orchestrator: trusted-state builder** | A representation described with the wrong chain (**F-6**), a state whose `stateId` lies about its content (**F-8**), a stale state presented at handoff (**F-5**) | **Reducible.** Each is a check the kernel could perform and does not |
| **Orchestrator: `reservationSeconds`** | Double execution (**F-1**) | **Reducible.** One-line clamp |
| **Trusted cost source** | Understated fees within the router's bound; combined with F-2, unbounded cost at the kernel | Reducible only by Phase 6 on-chain cost assertion |
| **`packages/registry` code** | Wrong admissibility. Pure, bounded, no I/O | Necessary, well minimized |
| **`packages/router` code** | Wrong ranking; **and today, the only enforcement of the all-in cost bound (F-2)** | Should be unnecessary for safety. F-2 is what makes it load-bearing |
| **`packages/adapter-robinhood`** | False market, halt or corporate-action state | Necessary; provenance-labelled and strictly parsed |
| **`packages/jev` / TypeSafe** | Execution *quality* within mandate bounds, and outcome availability (**F-13**) | **Not trusted for safety, and verified not to be** |

**Unnecessary trust identified.** Four items above are marked reducible and are
reducible with checks the kernel is already structured to perform. The kernel's
design principle is that it trusts none of its callers and re-derives every
claim; F-6, F-8, F-1 and F-5 are each a place where it accepts a caller's word
for something it could establish itself.

---

## 5. Complete authority map

Origin · trust class · where validated · can an untrusted source override it ·
can it change between verification and execution · is it in a commitment.

| Field | Origin | Trust | Validated in | Overridable? | Mutable pre-execution? | In a digest? |
| --- | --- | --- | --- | --- | --- | --- |
| `principal` | signed mandate | Authoritative | `checkSignature` recovers and compares | No | No | mandate |
| `agent` | signed mandate | Authoritative | `checkAgent` vs candidate | No | No | mandate |
| `canonicalAsset` | signed mandate | Authoritative | `checkCanonicalAsset`, `checkRepresentation`, registry | No | No | mandate, candidate, state |
| `side` | signed mandate | Authoritative | `checkSide`; router `validateIdentity` | No | No | mandate, candidate |
| `maxNotional` | signed mandate | Authoritative | `checkMaxNotional` (notional only) | No | No | mandate |
| `maxDeviationBps` | signed mandate | Authoritative | `checkPriceDeviation` | No | No | mandate |
| `allowedIssuers/Chains/Venues` | signed mandate | Authoritative | `checkChain`, `checkVenue`, `checkRepresentation`, registry | No | No | mandate |
| `requiredCorporateActionEpoch` | signed mandate | Authoritative | `checkCorporateAction` | No | No | mandate |
| `maxPriceAgeSeconds`, `maxCorporateActionAgeSeconds` | signed mandate | Authoritative | freshness checks | No | No | mandate |
| `notBefore`, `expiresAt` | signed mandate | Authoritative | `checkValidityWindow` | No | No | mandate |
| **`representationId`** | registry only | Verified | resolved through trusted state; unregistered ⇒ `REPRESENTATION_UNKNOWN` | No | Registry can change between snapshots | candidate, state, routing candidate |
| **contract address** | inside `representationId` | Verified | EIP-55 checked and lower-cased in the registry; **kernel never parses it** | No | No | candidate (as part of the id string) |
| **chain** | mandate allowlist + candidate claim + state | Verified | `checkChain` against the *field*; **never against the chain inside the id (F-6)** | **Yes, by a defective state builder** | No | candidate, state |
| `issuer` | registry claim set | Verified | trust floor, conflict-fails-closed, `checkRepresentation` | No | Between snapshots | state, candidate |
| `synthetic` | derived from `backing` claim | Verified | `checkRepresentation`; derived, never its own claim | No | Between snapshots | state |
| `operationalState` | registry claim set | Verified | `checkRepresentation` | No | Between snapshots — **not re-read at handoff by default (F-5)** | state |
| `venue` | provider claim | Untrusted → checked | `checkVenue` against the allowlist; steps must agree | No | No | candidate |
| `quantity` | caller's `requestedQuantity` | Verified | router requires exact equality; `notionalBounds` | No | No | candidate |
| `executionPrice` | provider quote | Untrusted → checked | `checkPriceDeviation` vs reference; `notionalBounds` | No | Reference can move (**F-5**) | candidate |
| `notional` | provider quote | Untrusted → checked | `checkNotionalConsistency`, `checkMaxNotional` | No | No | candidate |
| **fees** | provider quote **and** trusted cost state | Verified (must match exactly) | router only: `UNTRUSTED_COST_MISMATCH`, `TOTAL_COST_EXCEEDS_MANDATE`. **Kernel never sees them (F-2)** | No | No | routing candidate **only — not `candidateDigest`** |
| `referencePrice` | adapter / Chainlink | Verified | `parseObserved` refuses advisory; freshness; asset match | No | **Yes (F-5)** | state |
| `haltStatus` | adapter | Verified | `checkHalt`; `UNKNOWN` rejects | No | **Yes (F-5)** | state |
| `corporateActionEpoch` | adapter, reconciled on-chain | Verified | `checkCorporateAction` three ways + candidate match | No | **Yes (F-5)** | state, candidate |
| **`stateId` / `referenceStateId`** | **orchestrator, free choice** | Verified by assertion | `checkStateBinding` compares names only (**F-8**) | **Yes** | n/a | state, candidate |
| **clock `nowUnixSeconds`** | **orchestrator, unconstrained** | nothing validates it (**F-9**) | — | **Yes** | receipt records it | receipt |
| `replay.status` | orchestrator's store | Verified | `checkReplay`; digest must match this mandate | No | **Yes — and `RECLAIM` moves it backwards (F-1)** | state |
| `expectedDomain` | deployment config | Authoritative | required; envelope's own claim never taken | No | No | signing hash |
| Jev `choice` | external model | **Advisory** | exact `indexOf` into a local array | **No — verified** | n/a | Jev receipt |
| Jev `confidence`, `probabilities` | external model | Advisory | bounded parse; no threshold ships | No | n/a | Jev receipt |

**Values with ambiguous authority.** Three.

- **Fees.** Verified-class data, enforced in a non-authoritative component, absent
  from the authoritative commitment. Neither the kernel nor a future gate can
  bound them. (F-2)
- **`stateId`.** Named as the binding between a candidate and the state it was
  built from, but freely chosen by the caller and compared only by string
  equality. It has the *form* of a commitment and none of the force. (F-8)
- **The chain.** Present twice — as a field and inside the representation
  identifier — and reconciled in the registry but not in the kernel. Two sources
  of one security-critical value, with the authoritative layer reading the weaker
  one. (F-6)

---

## 6. Data lifecycle

```
intent
  │ human or agent. Not represented in any type: the system enforces the
  │ mandate, never the intention behind it (V-51).
  ▼
mandate construction ── MCE v1, flat, length-explicit, ASCII identifiers only,
  │                     allowlists closed and sorted at parse time, no contract
  │                     address, no free text, bounded validity mandatory
  ▼
authorization ───────── EIP-712 over MandateAuthorization(bytes32 mandateDigest)
  │                     alone. Domain in the envelope, never in the digest, so
  │                     the digest stays chain-agnostic. Low-s enforced, v∈{27,28}.
  ▼
canonical asset resolution ── closed scheme vocabulary, check digits,
  │                           AMBIGUOUS never tie-broken
  ▼
representation discovery ──── by canonical asset; evaluated by identifier, never
  │                           by a caller-supplied record
  ▼
provenance / trust resolution ── claim sets against a VERIFIED floor; conflict
  │                              fails closed; a sub-floor claim can neither
  │                              establish nor conflict
  ▼
market state ─────── Observed<T>: provenance + observation time, always
  ▼
corporate-action state ── latest effective multiplier event reconciled with a
  │                       fixed-block uiMultiplier() read; epoch is an integer
  ▼
admissibility ────── registry EXCLUDED/ADMISSIBLE, all reasons collected
  ▼
deterministic verification ── 17 independent checks, unioned, sorted, deduped
  ▼
route construction ── strict provider parse (256 routes, 8 steps, exact-match
  │                   trusted costs, unknown cost is never zero)
  ▼
route ranking ─────── lexicographic: economic value, deviation, quote age,
  │                   step count, candidate digest. One implementation only.
  ▼
[optional] Jev ────── 12-field projection out; one string back; exact array
  │                   lookup; any failure selects index 0
  ▼
candidate recovery ── closedSet[index]; out-of-range refuses the evaluation
  ▼
fresh re-verification ── ⚠ against the evaluation-time state unless the caller
  │                       supplies handoffState (F-5)
  ▼
execution handoff ─── a RoutingCandidate and receipts. Nothing is submitted.
  ▼
[Phase 6] execution boundary ── does not exist
  ▼
receipts ─────────── VerificationReceipt, RoutingReceipt, JevDecisionReceipt,
                     JevAssistedSelectionReceipt. In memory. Not signed, not
                     persisted, not surfaced.
```

---

## 7. Failure-domain analysis

| Domain | Blast radius | Contained by | Escapes? |
| --- | --- | --- | --- |
| Kernel logic | Everything | Purity, totality, 17 independent checks, 57-vector corpus | **Partially: totality escapes at the u16 boundary (F-3)** |
| Encoding | Digests, signatures, replay keys | Canonical MCE, round-trip both directions, frozen wire codes, domain tags | No |
| Registry curation | Which contracts are executable | Trust floor, conflict-fails-closed, identifier-based evaluation | Yes, by design: a compromised curator is a compromised system |
| Route provider | Candidate economics and identity claims | Strict parse, registry cross-check, exact trusted-cost match, kernel verification | No for identity. **Yes for fees, via F-2's blind spot** |
| Trusted cost source | Fee totals | Exact match against the provider's quote | Yes: two sources agreeing on a wrong number is indistinguishable from correctness |
| Adapter | Market, halt, corporate-action state | Provenance, freshness, asset match, tri-state UNKNOWN | Accuracy is out of scope (V-52) |
| Jev / TypeSafe | Ordering within an admissible set | Closed set, index-only answer, re-verification | No for safety. **Yes for availability (F-13)** |
| Orchestrator | Clock, state identity, handoff state, reservation length | **Nothing** | **Yes — F-1, F-5, F-8, F-9** |
| Replay store | Double execution | Kernel makes the second transition invalid; only an atomic store makes it observable | Yes, by design (V-53), **and by F-1 even with an atomic store** |

---

## 8. TOCTOU analysis

Each window, with what can change in it and whether it is caught.

| Window | What can change | Caught? | Finding |
| --- | --- | --- | --- |
| Mandate signing → routing | Expiry, not-before | **Yes.** `checkValidityWindow`, exact boundaries, expiry exclusive | — |
| Mandate signing → routing | Corporate-action epoch | **Yes.** `CORPORATE_ACTION_STATE_CHANGED`; never rescaled — recovery is reauthorization | — |
| Mandate signing → routing | Authorization revocation | **No mechanism exists.** There is no revocation infrastructure, which is why bounded validity is mandatory. Correct and documented | — |
| Registry evaluation → kernel verification | Representation semantics | **Partially.** Both read "the same" facts from two independent inputs — the registry snapshot and the trusted state — with no binding between them. The router cross-checks issuer, chain and canonical asset; it does not cross-check `synthetic` or `operationalState` | **F-7** |
| Route ranking → selection | Nothing: both operate on one frozen array | Not applicable | — |
| Set construction → selection | Price, halt, epoch, representation status | **No.** `selectEvaluated` re-verifies against the identical state object. `FINAL_REVERIFICATION_FAILED` is unreachable via `route()` (executed) | **F-5** |
| Jev request → response | Price, halt, epoch, expiry | **Only if the caller supplies `handoffState`.** The default re-verifies against the evaluation state. The mechanism exists and works (executed); it is opt-in | **F-5** |
| Final verification → submission | Everything | **Not applicable — no submission exists.** This is the whole of Phase 6 and INV-13 | Phase 6 |
| Submission → confirmation | Reorg, mempool delay, replacement | **Not applicable.** Reasoned about only | Phase 6 |
| Reservation → outcome observed | Reservation expiry | **Inverted.** `RECLAIM` makes a live authorization spendable again while its transaction may still settle (executed) | **F-1** |
| Any → any | The clock itself | **No.** Rewinding the handoff clock turns `PRICE_STATE_STALE` into a pass (executed) | **F-9** |

**Remaining gaps, stated plainly.** The pre-execution decision layer has one
unclosed TOCTOU window of its own (set construction → handoff, F-5) and one
inverted control (F-1). Everything downstream of the handoff is Phase 6 and is
correctly scoped there. `maxPriceAgeSeconds` bounds the age of an *observation*,
not the age of the *decision*: nothing bounds how long a PASS remains usable.

---

## 9. Dependency-failure matrix

`FAIL CLOSED` · `DETERMINISTIC FALLBACK` · `DEGRADED BUT SAFE` · `UNSAFE` · `UNKNOWN`

| Dependency | Failure | Classification | Mechanism |
| --- | --- | --- | --- |
| Robinhood REST | unavailable / DNS / connection | FAIL CLOSED | `HTTP_ERROR`; no state ⇒ `TRUSTED_STATE_MISSING` |
| Robinhood REST | timeout | FAIL CLOSED | `AbortController`, 10 s default, `TIMEOUT` |
| Robinhood REST | 404 on an asset | FAIL CLOSED | `ASSET_NOT_FOUND`, distinct from a generic error |
| Robinhood REST | 429 | FAIL CLOSED | `RATE_LIMITED`, distinct code |
| Robinhood REST | undocumented status | FAIL CLOSED | any non-ok ⇒ `HTTP_ERROR` |
| Robinhood REST | malformed / non-JSON | FAIL CLOSED | `MALFORMED_RESPONSE` |
| Robinhood REST | schema change (new field) | DEGRADED BUT SAFE | strict per-field parse; an unreadable field yields no value, not a default |
| Robinhood REST | stale but well-formed | FAIL CLOSED | `PRICE_STATE_STALE` against the mandate's own bound |
| Robinhood REST | valid-looking malicious data | **UNSAFE** | Accuracy is out of scope (V-52). Identity is cross-checked against ISIN, UID and an audited mapping; a *price* lie within the deviation bound is undetectable |
| Robinhood REST | unexpectedly large body | **UNKNOWN** | `await response.json()` with no size bound (**F-11**) |
| RPC | unavailable / timeout | FAIL CLOSED | same paths |
| RPC | wrong chain | FAIL CLOSED | `assertMainnetChain` compares the chain id, never a hostname |
| RPC | JSON-RPC error or partial | FAIL CLOSED | `RPC_ERROR`; requires `jsonrpc:2.0`, `id:1`, `result` present, `error` absent |
| RPC | contract has no code | FAIL CLOSED | `CONTRACT_CODE_MISSING` |
| RPC | reorg | **UNKNOWN** | Reads are at a fixed block; nothing revisits a decision after a reorg. Phase 6 |
| Chainlink | unavailable | DETERMINISTIC FALLBACK | a second price surface; absence yields no reference ⇒ `MARKET_STATE_UNKNOWN` |
| Chainlink | disagrees with REST | FAIL CLOSED | `cross-surface` reports MISMATCH; a conflicting claim set fails closed |
| Chainlink | stale round | FAIL CLOSED | `updatedAt` carried as provenance; freshness applies |
| TypeSafe Jev | unavailable / 5xx | DETERMINISTIC FALLBACK | `SERVICE_UNAVAILABLE` ⇒ index 0 |
| TypeSafe Jev | 401/403 | DETERMINISTIC FALLBACK | `AUTH_FAILED` |
| TypeSafe Jev | 404 / 422 / 429 | DETERMINISTIC FALLBACK | `NOT_FOUND` / `REQUEST_REJECTED` / `RATE_LIMITED` |
| TypeSafe Jev | undocumented status | DETERMINISTIC FALLBACK | `UNEXPECTED_STATUS`; body discarded |
| TypeSafe Jev | slow | DETERMINISTIC FALLBACK | own deadline via `Promise.race`, independent of the transport |
| TypeSafe Jev | never settles | DETERMINISTIC FALLBACK | `withDeadline` resolves; timer always cleared |
| TypeSafe Jev | transport throws | DETERMINISTIC FALLBACK | `TRANSPORT_EXCEPTION` |
| TypeSafe Jev | invalid JSON | DETERMINISTIC FALLBACK | `INVALID_JSON` |
| TypeSafe Jev | schema mismatch | DETERMINISTIC FALLBACK | `SCHEMA_MISMATCH`; unknown fields tolerated, read fields never |
| TypeSafe Jev | out-of-set choice | DETERMINISTIC FALLBACK | `CHOICE_OUT_OF_SET`; exact `indexOf`, no normalization |
| TypeSafe Jev | abstains | DEGRADED BUT SAFE | first-class `ABSTAIN`, distinct from failure |
| TypeSafe Jev | non-deterministic | DEGRADED BUT SAFE | ordering only; verified |
| TypeSafe Jev | malicious | DEGRADED BUT SAFE for safety; **availability is influenced (F-13)** | closed set; a chosen candidate failing handoff ends the decision without retrying index 0 |
| TypeSafe Jev | huge body | **UNKNOWN** | no size bound (**F-11**) |
| Replay store | unavailable | FAIL CLOSED | `REPLAY_STATE_UNKNOWN` |
| Replay store | non-atomic | **UNSAFE** | documented (V-53); the kernel cannot detect a double reserve |
| Replay store | reservation expires unresolved | **UNSAFE** | **F-1** |
| Registry snapshot | absent / malformed | FAIL CLOSED | `SNAPSHOT_MALFORMED` |
| Registry snapshot | > 65 535 claims on a property | **UNKNOWN** | `registrySnapshotDigest` throws (**F-3**, executed) |
| Orchestrator clock | wrong or rewound | **UNSAFE** | nothing checks it (**F-9**, executed) |

Two `UNSAFE` classifications are pre-existing and documented (provider accuracy,
non-atomic store). Two are findings of this review (F-1, F-9). Three `UNKNOWN`
classifications are unbounded-input defects (F-3, F-11) and reorgs.

---

## 10. Replay and concurrency analysis

The replay key is the mandate digest, and that choice is right: it covers the
nonce, so two mandates differing only in nonce are independently spendable;
changing any term produces a different key, so an amended mandate cannot ride a
spent record; and it is stable across authorization schemes.

| Case | Current behaviour | Safe? |
| --- | --- | --- |
| Duplicate request, same mandate | Second sees `RESERVED` ⇒ `MANDATE_RESERVED` | Yes, given an atomic store |
| Two concurrent attempts | Both may verify; only one may `RESERVE` | Yes **only** with compare-and-swap. Documented (V-53); no store exists |
| Process crash after PASS, before `RESERVE` | Nothing reserved; mandate stays `UNUSED` | Yes |
| Process crash after `RESERVE`, before submit | Stays `RESERVED` until the reservation expires | Yes — until `RECLAIM` |
| Process crash after submit, outcome unknown | `RELEASE` is forbidden. `RECLAIM` **is** permitted once the reservation expires, and returns `UNUSED` while the mandate is still live | **No — F-1** |
| Retry after observed failure | `RELEASE` ⇒ `UNUSED` | Yes; requires a real observation |
| Retry after observed settlement | `COMMIT` ⇒ `CONSUMED`, terminal | Yes |
| Reservation race | Kernel invalidates the second transition; only the store makes it observable | Partially — store is the boundary |
| Restart recovery | Nothing persists. Every record is caller-supplied | **Not addressed.** No store exists |
| Nonce collision | Impossible across principals: the digest covers the principal | Yes |
| Cross-chain replay | Mandate digest is chain-agnostic; `allowedChains` constrains execution; the EIP-712 domain constrains where a signature is accepted. **But the chain inside `representationId` is unchecked (F-6)**, so the layer that will actually address a contract is not bound to the allowlisted chain | **Partially — F-6** |
| Cross-contract replay | `representationId` is in `candidateDigest`; domain tags prevent reading one object as another | Yes off-chain. On-chain enforcement is Phase 6 |
| Replay after a corporate action | Epoch mismatch rejects in both directions, with distinct codes | Yes |
| Replay of a Jev choice from another evaluation | Choice ids are positional (`route_000`), so a captured choice is "valid" in a later set — but it is only an index into that set's own members | Yes |

**What must eventually be atomic on chain versus what may stay off chain.**

| Must be atomic on chain | May remain off chain |
| --- | --- |
| Consumption of the mandate digest (nonce/bitmap) | Candidate construction |
| The commitment the execution is bound to — including fees, once F-2 is fixed | Ranking and advisory selection |
| Safety-critical time (`block.timestamp`), so F-9 is closed by construction | Provenance labelling and normalization |
| The mapping from `representationId` to the token actually called | Registry curation, so long as its snapshot digest is committed |
| The reference price and epoch the execution asserts | Receipt rendering and audit surfacing |

---

## 11. Jev independence analysis

This is the part of the architecture that holds up best, and it was re-measured
rather than accepted. With a transport that deliberately chooses a non-preferred
member: the closed-set digest is byte-identical with and without advice, the
choice does change which member is handed off, the handoff is a member of the
deterministic admissible set, and it carries a kernel `PASS`.

| Jev must not be able to | Why it cannot | Verified |
| --- | --- | --- |
| Add a candidate | It is consulted only after `evaluateRoutes` closes the set; its answer is an index; `selectEvaluated` refuses any index outside `admissible` | Yes |
| Alter quantity, side, asset, representation, contract, chain, price or fees | No field of any response is read as a value. `parse.ts` produces a `string`, a `number` in [0,1] and token counts, and nothing else. There is no deserialization into a domain object | Yes |
| Expand permissions | It receives a 12-field projection built field by field, never a spread; no constraint value is in the payload, so none can be echoed back | Yes |
| Bypass verification | The handoff re-verification is unconditional in the sense that it always runs. **Its input state is not (F-5)** | Partially |
| Authorize execution | `Decision` comes only from the kernel; the Jev receipt is not read by any check | Yes |

| Jev behaviour | Outcome |
| --- | --- |
| Correct | Selects a member; re-verified; handed off |
| Incorrect | Selects a worse member of an already-valid set; ranking quality degrades, safety does not |
| Malicious | 17 hostile behaviours in `adversarial.test.ts`; a returned candidate object, an attacker address, an altered amount and an inverted side all land as either `CHOICE_OUT_OF_SET` or `SCHEMA_MISMATCH` |
| Unavailable | `SERVICE_UNAVAILABLE` ⇒ index 0 |
| Very slow / hanging | Own deadline, independent of the transport; does not block |
| Non-deterministic | Affects ordering only; the closed set is unchanged |
| Undocumented response | `SCHEMA_MISMATCH` ⇒ index 0 |

**Two honest qualifications.**

1. **Mandate safety is invariant. Mandate *availability* is not.** A Jev-chosen
   candidate that fails handoff re-verification yields `NO_VALID_ROUTE` with no
   re-attempt of index 0, although ADR 0013 says every failure selects index 0.
   The permitted set is unchanged, so INV-3 as worded holds; the outcome is
   model-influenced. (**F-13**)

2. **Every Phase 5 corpus world contains exactly one representation.** All six
   `mainnet-routing` vectors resolve one `representationId`, and the sole
   adversarial mutation across them is a cheapest route from an unapproved
   *issuer*. The Jev evaluation corpus is built the same way: candidates differ
   in fees and quote age, never in representation, chain or venue. So
   "zero unsafe handoffs in all five modes" is true and is measured over a world
   in which representation substitution — the thing INV-14 is about and the
   reason this system exists — cannot occur. (**F-10**)

---

## 12. Cryptographic binding analysis

| Digest | Commits to | Does **not** commit to |
| --- | --- | --- |
| `mandateDigest` | Every one of the 21 mandate fields. Injective over 300 generated mandates; all 21 fields individually mutated without collision | The EIP-712 domain, deliberately (keeps it chain-agnostic) |
| EIP-712 signing hash | `mandateDigest` + domain (name, version, chainId, verifyingContract) | Nothing about the candidate, state or execution — correct: it authorizes terms, not an action |
| `candidateDigest` (kernel) | representationId (and therefore chain + contract, as an opaque string), canonical asset, issuer, chain, venue, side, agent, quantity, executionPrice, notional, referenceStateId, epoch | **Fees. Route steps. Provider. Quote age. Reference price. Trusted cost source.** |
| `trustedStateDigest` | All representations (sorted by id), market, corporate action, replay, each with provenance and observation time | Is never compared to anything: `checkStateBinding` compares `stateId` strings instead (**F-8**) |
| `routingCandidateDigest` | `kernelCandidateDigest` + routeId, provider, providerClass, fillPolicy, quote and reference observation times, reference price, trusted cost source and time, **all four fee components**, and every route step | Is a router artifact. Nothing signs it; nothing on chain will read it unless Phase 6 is built to |
| `registrySnapshotDigest` | Schema version, snapshot id, creation time, data class, source versions, all assets, all representations with all claims and provenance | Is recorded in the routing receipt but never required to match the trusted state (**F-7**) |
| `receiptDigest` | Verifier version, the three input digests, evaluation instant, decision, every violation with sorted detail | Is a commitment, not a signature |
| `routingReceiptDigest` | Router version, mandate/registry/market digests, requested quantity, every outcome, the ranked digests, the selection, the final receipt digest | Not signed, not persisted |
| `closedChoiceSetDigest`, `jevDecisionReceiptDigest`, `jevSelectionReceiptDigest` | The closed set and the advisory decision, bound to the routing receipt | No verifier reads any of them — correct by design |

**Substitution opportunities.**

| Target | Bound by | Substitutable? |
| --- | --- | --- |
| mandate | `mandateDigest`, signed | No |
| asset, representation, contract, side, quantity, venue | `candidateDigest` | No off-chain; on-chain is Phase 6 |
| chain | `candidateDigest` carries both the field and the id — **which may disagree** | **Yes (F-6)** |
| price | `candidateDigest` | No |
| **fees** | routing digest only; **absent from `candidateDigest`** | **Yes, at the kernel and at any future gate (F-2)** |
| state | `trustedStateDigest` exists but is never compared; `stateId` is | **Yes (F-8)** |
| corporate-action epoch | `candidateDigest` + `trustedStateDigest`, cross-checked | No |
| router result | `routingReceiptDigest` | Unsigned, in memory |
| Jev result | Jev receipts | Advisory; nothing reads it |
| **execution parameters** | **nothing** | **Wholly unbound — this is Phase 6** |

**What remains unbound before Phase 6.** Everything between the handoff and the
chain. There is no transaction, so there is nothing binding calldata, recipient,
allowance, gas, slippage or deadline to the verified candidate. That is correctly
scoped; the finding here is narrower and more urgent: **`candidateDigest` is
already missing the fee commitment**, so building the gate against today's digest
would bake F-2 into the on-chain layer.

---

## 13. Versioning analysis

| Version | Value | Behaviour on mismatch | Risk |
| --- | --- | --- | --- |
| `MANDATE_SCHEMA_VERSION` | 1 | `UNSUPPORTED_MANDATE_VERSION`, distinct from malformed | **Exactly one version is accepted.** There is no acceptance window, so a bump invalidates every outstanding signed mandate at once (**F-12**) |
| `CANDIDATE_SCHEMA_VERSION` | 1 | `MALFORMED_CANDIDATE` | Low: candidates are ephemeral |
| `STATE_SCHEMA_VERSION` | 1 | `MALFORMED_TRUSTED_STATE` | Low |
| `REGISTRY_SCHEMA_VERSION` | 1 | `SNAPSHOT_MALFORMED` | Low, and correctly decoupled: registry evolution cannot change a mandate digest (ADR 0007) |
| `VERIFIER_VERSION` | `mandate-kernel/1` | In the receipt digest | Good: a verdict is attributable to a verifier |
| `ROUTER_VERSION`, receipt versions | `mandate-router/1`, 1 | In their digests | Good |
| Jev integration / question / receipt versions | recorded in the Jev receipt | — | Good |
| MCE wire codes | frozen, written out explicitly | — | **Strong.** Reordering a `const` object cannot change a signed digest, and a test asserts every enum member has a code and every code maps back |
| Contract version | n/a | n/a | Phase 6 |

**An old signed mandate meeting newer software.** Today: accepted, because the
version is still 1 and unknown fields reject. After a bump to 2: **rejected**,
because `parseMandate` requires exact equality. That is fail-closed and therefore
safe, but it is a hard cutover — every mandate a principal signed before the bump
becomes unusable with no migration path. For infrastructure that intends to hold
standing authorizations this needs a deliberate policy (accept a set of versions,
each with its own frozen parser and encoder, and never re-encode across
versions). Downgrade is not possible: an older verifier rejects a v2 mandate, and
because the digest covers the version, a v2 mandate cannot be presented as v1.

---

## 14. Resource exhaustion analysis

| Externally controlled value | Bound | Adequate? |
| --- | --- | --- |
| Candidate count | 256 (`MAX_ROUTE_CANDIDATES`) | Yes |
| Route steps | 8 (`MAX_ROUTE_STEPS`), and non-empty | Yes |
| Mandate allowlist sizes | 1024 (`MAX_SET_SIZE`) | Yes — and `u16` can hold it |
| Identifier length | 128 | Yes |
| String length at the encoder | 1024 bytes | Yes |
| Amount / price atoms | `uint256`; decimals ≤ 38 | Yes |
| Epoch, nonce | `uint64` | Yes |
| Timestamps | `int64`; durations `uint32` | Yes |
| Registry snapshot assets, representations | 65 535 (`MAX_SNAPSHOT_ENTRIES`) | Yes — deliberately matched to the `u16` width |
| **Trusted-state representations** | **none** | **No.** `u16` at the encoder; `verify()` and `route()` throw past it (**F-3**) |
| **Claims per registry property** | **none** | **No.** `u16` at the encoder; `registrySnapshotDigest` throws past it (**F-3**) |
| **`sourceVersions`, asset aliases, asset listings** | **none** | **No.** Same class, same `u16` encoders |
| Jev probability entries | 256; keys 64 chars | Yes |
| Jev model / choice strings | 128 / 64 chars, printable ASCII only | Yes |
| Jev token counts | 100 000 000 | Yes |
| **HTTP response body size** | **none, either client** | **No (F-11).** `await response.json()` buffers whatever arrives. The fetch timeout bounds a *slow* body, not a fast large one |
| Nested JSON depth | none | Acceptable: `JSON.parse` is the only recursion and every parser is flat and key-allowlisted |
| Concurrent requests | none | Out of scope for pure packages; correctly noted as an API-layer concern |
| Hashing cost | bounded by the above | Yes, except where a bound is missing |
| Receipt size | violations bounded by 17 checks; details are short machine strings | Yes |
| Jev payload size | 254 views × 12 bounded fields | Yes |

**Answer to "does every externally controlled collection have a deliberate
bound?"** No. Four collections are bounded only by the encoder that will throw on
them, and one — HTTP response bodies — is unbounded outright. The pattern is
telling: the registry author chose `MAX_SNAPSHOT_ENTRIES = 65_535` precisely to
match the `u16` width, so the rule was understood; it was applied in one place
and missed in four.

---

## 15. Recovery analysis

| After | Current behaviour | Acceptable in production? |
| --- | --- | --- |
| Process crash | Nothing persists. All receipts, evaluations and replay records are in memory or caller-supplied | **No.** A crash between reserve and submit loses the knowledge that anything was attempted |
| Machine restart | Same | **No** |
| Deployment | A new `VERIFIER_VERSION` changes every receipt digest; no in-flight state exists to migrate | Acceptable today; becomes a version-skew problem once receipts are stored |
| RPC outage | Fails closed; no state, no decision | Yes |
| Database corruption | **There is no database.** The replay store — the one piece of state whose corruption causes double execution — does not exist | **Not addressed** |
| External service outage | Robinhood fails closed; Jev falls back deterministically | Yes |
| Transaction outcome unknown | `RELEASE` is correctly forbidden; `RECLAIM` incorrectly permitted (**F-1**) | **No** |
| Chain reorg | Reads are at a fixed block; nothing revisits a decision | **Not addressed.** Phase 6 |

**Where in-memory or caller-supplied state is unacceptable in production.**
Three places, in order: the replay store (double execution), the receipt trail (a
refusal that leaves no record is not auditable, and INV-11 promises it is), and
the clock (F-9). The first two need a store with compare-and-swap and durable
append; the third needs the chain.

---

## 16. Observability requirements

Signals a production operator needs, with what must not be emitted alongside
them. No monitoring stack is proposed here.

| Signal | Why | Privacy constraint |
| --- | --- | --- |
| Verification rejects by reason code | The reason codes *are* the product; a shift in distribution is the earliest signal of a data-source or curation problem | Code and count only. Never principal, agent, asset, quantity or price |
| PASS rate, and PASS-to-handoff conversion | Distinguishes "we refuse a lot" from "we refuse everything" | Aggregate |
| Stale-state rate, split price vs corporate-action | Distinguishes a slow feed from a broken one | Age distributions, not values |
| Observation-from-the-future count | A broken clock or source, and F-9's only visible symptom | Count |
| Registry conflict count by property | A conflict is a curator action item, not an incident | Property name and representation id. The disagreeing *values* are already in the exclusion detail and are curation data, not order data |
| Provider failure rate by provider and class | Which provider to drop | Provider id |
| Trusted-cost mismatch rate | The strongest signal of a compromised or drifting fee source | Route and component, never the amounts |
| Jev fallback frequency **by reason** | A permanently broken integration is invisible by design; the counters are the only evidence | Reason code and count |
| Jev latency distribution | Sizing the deadline | Milliseconds |
| Jev timeout rate, abstention rate, out-of-set rate | Abstention is healthy; out-of-set is a schema or vendor change | Counts |
| Jev disagreement-with-baseline rate | Whether advice is doing anything, and whether it turned hostile | Count |
| Handoff rejection rate | Directly measures the TOCTOU window and would have surfaced F-5's default | Count and reason |
| Replay conflict rate (`RESERVED`, `ALREADY_CONSUMED`) | Concurrency pressure; a non-atomic store shows up here first | Counts |
| **`RECLAIM` count** | Every `RECLAIM` is a potential double execution until F-1 is fixed. **This should page, not graph** | Count and mandate digest |
| No-route frequency by dominant reason | Distinguishes market conditions from a defect | Counts |
| Execution-handoff failures | Phase 6 | — |
| Version skew: verifier, router, registry schema, snapshot digest | A receipt is only reproducible against the versions that produced it | Versions and digests |
| Totality violations (a throw from `verify`/`route`) | F-3 has no receipt, so it is invisible unless the caller logs the throw | Exception class only |

**Privacy implications.** A receipt already contains digests and machine codes
rather than free text or secrets, so the receipt is close to emittable as-is. The
exceptions are the violation `detail` values, which include quantities, prices,
bounds and deviations: those are order information and must stay out of shared
telemetry even though they are not secrets. The Jev payload is the other
disclosure point and is already minimized deliberately — the all-in cost and
deviation are exact integers, so consulting Jev discloses the economics of a
pending order to a third party. That is inherent in asking and is documented.

---

## 17. Failure scenarios

Thirty-four, adversarial and ordinary. "Passes" means the architecture as built
produces the safe behaviour.

| # | Initiating condition | Components | Current behaviour | Expected safe behaviour | Passes | Severity if not | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Agent proposes a contract the registry never listed | registry, kernel | `REPRESENTATION_UNKNOWN`; evaluation is by identifier so no invented record can be scored | Refuse | **Yes** | — | — |
| 2 | Model hallucinates a contract address | jev, kernel | No response field is read as a value; `CHOICE_OUT_OF_SET` | Refuse, fall back | **Yes** | — | — |
| 3 | Provider offers a counterfeit token whose symbol matches | registry | Symbol is display-only; the underlying is a claim needing a VERIFIED source | Refuse | **Yes** | — | — |
| 4 | Two sources disagree about the underlying | registry | `CONFLICT`, unconditional, no most-recent-wins | Refuse | **Yes** | — | — |
| 5 | Attacker injects an advisory claim to deny service | registry | Sub-floor claims cannot create a conflict | Ignore | **Yes** | — | — |
| 6 | Synthetic representation under `FORBIDDEN` | registry, kernel | `SYNTHETIC_NOT_ALLOWED`; synthetic is derived from backing, never its own claim | Refuse | **Yes** | — | — |
| 7 | Ticker resolves to two assets | registry | `AMBIGUOUS`, never tie-broken | Refuse | **Yes** | — | — |
| 8 | Split occurs between signing and routing | adapter, kernel | `CORPORATE_ACTION_STATE_CHANGED`; never rescaled | Refuse; require reauthorization | **Yes** | — | — |
| 9 | Corporate-action feed runs behind | kernel | `CORPORATE_ACTION_STATE_INCONSISTENT`, a distinct code | Refuse | **Yes** | — | — |
| 10 | Epoch feed is current-looking but an hour old | kernel | `CORPORATE_ACTION_STATE_STALE` | Refuse | **Yes** | — | — |
| 11 | Trading halts before routing | adapter, kernel | `TRADING_HALTED` under `FORBID_WHEN_HALTED` | Refuse | **Yes** | — | — |
| 12 | Halt status cannot be established | kernel | `MARKET_STATE_UNKNOWN`; `UNKNOWN` is a value that rejects | Refuse | **Yes** | — | — |
| 13 | Price feed is 61 s old against a 60 s bound | kernel | `PRICE_STATE_STALE` | Refuse | **Yes** | — | — |
| 14 | Price observation timestamped in the future | kernel | `MARKET_STATE_UNKNOWN`, not "maximally fresh" | Refuse | **Yes** | — | — |
| 15 | Mandate expires during evaluation | kernel | `MANDATE_EXPIRED`, expiry exclusive | Refuse | **Yes** | — | — |
| 16 | Signature valid but signer is not the principal | kernel | `SIGNER_UNAUTHORIZED`, distinct from `SIGNATURE_INVALID` | Refuse | **Yes** | — | — |
| 17 | Signature replayed from another deployment | kernel | `AUTHORIZATION_DOMAIN_MISMATCH`; the envelope's own domain is never taken | Refuse | **Yes** | — | — |
| 18 | High-`s` malleable twin submitted | kernel | `SIGNATURE_INVALID` under EIP-2 | Refuse | **Yes** | — | — |
| 19 | Provider reports zero fees while charging them | router | Exact match against independent trusted cost; `UNTRUSTED_COST_MISMATCH` | Refuse | **Yes** | — | — |
| 20 | Fee component unknown | router | `UNKNOWN_COST`; unknown is never zero | Refuse | **Yes** | — | — |
| 21 | Cheapest route is from an unapproved issuer | registry, router, kernel | `ISSUER_NOT_ALLOWED`; quality never offsets a violation | **Yes** | — | — |
| 22 | Provider returns 300 routes | router | `RESOURCE_LIMIT_EXCEEDED` at 256 | Refuse | **Yes** | — | — |
| 23 | Admissible set exceeds 254 | jev | Advisory layer is skipped, set is never truncated | Deterministic result stands | **Yes** | — | — |
| 24 | Jev returns ` route_001` with a leading space | jev | Exact comparison; `CHOICE_OUT_OF_SET` | Fall back | **Yes** | — | — |
| 25 | Jev returns a whole candidate object | jev | `SCHEMA_MISMATCH`; no deserialization path exists | Fall back | **Yes** | — | — |
| 26 | Jev hangs forever | jev | Own deadline via `Promise.race`; timer cleared | Fall back | **Yes** | — | — |
| 27 | `TYPESAFE_API_KEY` unset | jev | `MISSING_CREDENTIAL`; refuses to call unauthenticated | Fall back | **Yes** | — | — |
| 28 | Robinhood returns HTTP 418 | adapter | `HTTP_ERROR`; any non-ok status | Fail closed | **Yes** | — | — |
| 29 | RPC lies about which chain it serves | adapter | `assertMainnetChain` compares the chain id, never a hostname | Refuse | **Yes** | — | — |
| 30 | **Attempt submits, then crashes; outcome never established; reservation expires** | replay | `RECLAIM` ⇒ `UNUSED` while the mandate is live; a second execution can be authorized | Stay unavailable until the mandate itself expires | **No** | **HIGH** | **5 (now)** |
| 31 | **Route carries fees exceeding the mandate cap** | kernel, router | Kernel PASSes; only the router refuses; `candidateDigest` omits fees | The authoritative layer refuses, and the commitment covers fees | **No** | **HIGH** | **1 schema + 6** |
| 32 | **SELL whose fees consume all but one atom of proceeds** | router | ADMISSIBLE | Refuse against a principal-declared floor | **No** | **HIGH** | **1 (schema)** |
| 33 | **Price moves past the bound while Jev is thinking, caller omits `handoffState`** | jev, router | Re-verifies against the evaluation state and PASSes | Reject on the state current at handoff | **No** | **HIGH** | **5 (now)** |
| 34 | **Trusted state carries 65 536 representations** | kernel, router, registry | `verify()` and `route()` throw; no receipt is produced | Return a REJECT / `INVALID_INPUT` with a reason code | **No** | **HIGH** | **5 (now)** |
| 35 | **Trusted state names a mainnet contract while its chain field says Arbitrum** | kernel | PASS | Reject: the chain inside the identifier must match the allowlisted chain | **No** | **MEDIUM** | **5 (now)** |
| 36 | Trusted state built from a different registry snapshot than the one evaluated | router | The two may disagree about `synthetic` or `operationalState`; nothing binds them | Refuse unless the snapshot digests agree | **No** | **MEDIUM** | 5 or 6 |
| 37 | Orchestrator rewinds the clock | kernel | Every age bound is defeated | Safety-critical time comes from the chain | **No** | **MEDIUM** | 6 |
| 38 | Two different states share one `stateId` | kernel | Both satisfy `checkStateBinding` | Bind on content, not name | **No** | **MEDIUM** | 5 or 6 |
| 39 | Malicious Jev picks a candidate that will fail handoff | jev | `NO_VALID_ROUTE`; index 0 is not re-attempted | Fall back to index 0, as ADR 0013 states | **No** | **MEDIUM** | 5 |
| 40 | TypeSafe returns a 2 GB body inside the deadline | jev | Buffered in full | Refuse past a declared size | **No** | **MEDIUM** | 5 |
| 41 | Mandate schema bumps to v2 with v1 mandates outstanding | kernel | All outstanding mandates become unusable | Accept a declared version window, each with a frozen codec | **No** | **MEDIUM** | 6 or later |
| 42 | BUY fills 500 bps *better* than the reference | kernel | `PRICE_DEVIATION_EXCEEDED` | Arguably accept; at minimum make the asymmetry a mandate choice | **No** | **LOW** | 1 (schema) |
| 43 | Zero-quantity candidate | kernel | PASS; would consume a single-use mandate | Refuse below a declared minimum | **No** | **LOW** | 1 (schema) |
| 44 | Non-atomic replay store permits a double reserve | replay | Undetectable by the kernel | An atomic store, then an on-chain nonce | **No** | **HIGH** | 6 |
| 45 | Chain reorg after submission | — | Not addressed | Re-observe and reconcile | **No** | **HIGH** | 6 |
| 46 | Process crash loses the receipt trail | receipts | Nothing persists | Durable append before submission | **No** | **MEDIUM** | 6/8 |
| 47 | Registry curator is compromised | registry | An attacker contract becomes admissible under a valid mandate | Change control, multi-party review, snapshot digest pinning | **No** | **CRITICAL if reached** | 6+ (operational) |
| 48 | Robinhood returns a plausible but wrong price inside the deviation bound | adapter | Undetectable | Multi-source agreement as a gate, not a report | **No** | **MEDIUM** | 6+ |

---

## 18. Severity-ranked findings

Severity reflects reachability and consequence in a production deployment of the
current architecture, not the fact that the domain is financial.

### HIGH

**F-1 · `RECLAIM` reopens a live authorization · IMPLEMENTATION · fix in Phase 5**
`applyTransition` clamps a reservation down to the mandate expiry and never up,
so any caller-chosen `reservationSeconds` shorter than the mandate's remaining
validity returns it to `UNUSED` while a submitted transaction may still settle.
`replay-semantics.md` §6 states the opposite property. Reached by ordinary
operation — a crash and a short hold — not by an adversary.
*Remediation:* refuse `RECLAIM` before the mandate's own expiry, or raise the
reservation to it. Either is one line. Then add the on-chain nonce in Phase 6.
*Evidence:* `packages/kernel/test/pressure-test-findings.test.ts`.

**F-2 · The all-in economic bound is outside the authority and outside the commitment · ARCHITECTURAL · mandate schema now, gate in Phase 6**
`ExecutionCandidate` has no fee field and `encodeCandidate` commits to none, so
`checkMaxNotional` bounds the notional alone and the kernel passes a route whose
fees are twice the cap. `TOTAL_COST_EXCEEDS_MANDATE` lives in the router.
`architecture.md` §4 assigns this concern to the verifier and explicitly not to
the candidate engine; the implementation is the reverse.
*Remediation:* add an all-in cost bound to the mandate and a fee total to the
candidate, so the kernel enforces it and `candidateDigest` commits to it. This
must land **before** Phase 6 freezes the digest the gate re-asserts.
*Evidence:* `packages/router/test/pressure-test-findings.test.ts`.

**F-3 · `verify()` and `route()` throw instead of returning a verdict · IMPLEMENTATION · fix in Phase 5**
Four counted collections are encoded as `u16` and bounded by no parser:
trusted-state representations, claims per registry property, `sourceVersions`,
and asset aliases/listings. The digests are computed before the per-check `try`,
so the encoder's range assertion escapes. V-2 (total) and INV-11 (every refusal
explainable from its receipt) are both false at the boundary. Nothing unsafe is
authorized — no PASS is produced — but a refusal with no receipt is not auditable,
and a caller with a `try` around the call may read the throw as a transport
failure and retry.
*Remediation:* bound each parser at 65 535, matching `MAX_SNAPSHOT_ENTRIES`.
*Evidence:* kernel and router finding tests.

**F-4 · A SELL mandate cannot bound its own proceeds · ARCHITECTURAL · mandate schema**
`SELL_FEES_EXCEED_PROCEEDS` triggers only when fees reach the whole notional, and
no mandate field expresses a minimum proceed or a maximum fee. A sale netting one
atom is admissible: every check passes and the outcome is ruinous. This is the
same schema gap as F-2 seen from the other side.
*Remediation:* one field, symmetric for both sides — a floor on what the
principal receives and a ceiling on what they spend.
*Evidence:* `packages/router/test/pressure-test-findings.test.ts`.

**F-5 · The handoff re-verification reads evaluation-time state · ARCHITECTURAL / IMPLEMENTATION · fix in Phase 5**
`selectEvaluated` re-verifies against `context.trustedState` and `context.clock`
— the identical objects — so the check is a tautology and
`FINAL_REVERIFICATION_FAILED` is unreachable via `route()`. `selectWithJev`'s
`handoffState` is optional and defaults to the same. `decide.ts`'s own comment
and `security-review.md` both describe the re-verification as being against the
state current at handoff.
*Remediation:* require the handoff state, and give the deterministic path the
same parameter. Correct the two documents.
*Evidence:* router and jev finding tests.

**F-44/45 · No atomic replay store, no reorg handling · FUTURE-PHASE**
Correctly scoped to Phase 6 and honestly documented (V-53). Listed at HIGH
because they are prerequisites for any real-money deployment, not because
anything in Phases 1–5 is wrong.

### MEDIUM

**F-6 · The chain inside `representationId` is never reconciled with the chain field · ARCHITECTURAL**
`checkRepresentation` compares the candidate's `chain` to trusted state's `chain`
field and never to the chain segment of the identifier that carries the contract
the execution will address. The registry closes this by construction; the kernel,
whose principle is to trust no caller, does not. A two-line check closes it.

**F-7 · Nothing binds the registry snapshot to the trusted state · ARCHITECTURAL**
Both are Verified-class caller inputs describing the same representations, and
they may disagree. The router cross-checks issuer, chain and canonical asset; it
does not cross-check `synthetic` or `operationalState`, which the kernel reads
from the trusted state alone. The routing receipt records both digests without
requiring agreement. *Remediation:* carry the snapshot digest in the trusted
state and refuse a mismatch.

**F-8 · `referenceStateId` binds a name, not content · ARCHITECTURAL**
`stateId` is freely chosen by the caller and compared by string equality. Two
materially different states sharing one `stateId` both satisfy `checkStateBinding`.
The verifier re-checks everything against whatever state it is given, so no
economic check is bypassed — but the binding establishes nothing, and Phase 6
needs a content-addressed state commitment. *Remediation:* compare
`trustedStateDigest`, which is already computed.

**F-9 · The clock is an unconstrained caller input · OPERATIONAL**
Rewinding the handoff clock turns `PRICE_STATE_STALE` into a pass. Every
freshness bound, expiry and not-before rests on the orchestrator's honesty. This
is correct for a pure verifier and is the right design; it is listed because it
makes the orchestrator part of the trusted computing base and because INV-10
already names the remedy — safety-critical time from the chain.

**F-10 · Adversarial coverage is one mutation class over single-representation worlds · IMPLEMENTATION**
All six `mainnet-routing` vectors resolve exactly one `representationId`, and the
only mutation is a cheapest route from an unapproved issuer. The Jev corpus is
built the same way. "Zero unsafe handoffs" is true and is measured in a world
where representation substitution cannot occur — the one thing INV-14 is about.
*Remediation:* corpus worlds with two or more admissible representations
differing in chain, venue, issuer and backing, and mutation classes for
substituted representation, wrong chain, wrong venue and synthetic-under-
`FORBIDDEN`.

**F-11 · No response-size bound on either network client · IMPLEMENTATION**
`await response.json()` in both `jev/client.ts` and `adapter-robinhood/client.ts`.
The fetch deadline bounds a slow body, not a fast large one. Every other boundary
in the repository has a deliberate bound.

**F-12 · A schema bump invalidates every outstanding mandate · OPERATIONAL**
`parseMandate` accepts exactly one version. Fail-closed and therefore safe, but a
hard cutover with no migration path.

**F-13 · Jev holds availability authority · ARCHITECTURAL**
A Jev-chosen candidate that fails handoff re-verification yields `NO_VALID_ROUTE`
without re-attempting index 0, although ADR 0013 says every failure selects
index 0. INV-3 as worded survives; the outcome does not.

**F-48 · Single-source price accuracy · OPERATIONAL**
A plausible but wrong price inside the deviation bound is undetectable. The
cross-surface check reports agreement; it does not gate on it.

### LOW

**F-14 · Deviation is symmetric · ARCHITECTURAL** — a BUY filled better than the
reference is rejected. Fails closed and refuses good executions; whether the
bound should be one-sided is a product decision that should be explicit.

**F-15 · A zero-quantity candidate is authorized · ARCHITECTURAL** — and would
consume a single-use mandate. No minimum size exists in the schema.

**F-16 · No persistence anywhere · OPERATIONAL** — restated for readiness;
correctly scoped.

### INFORMATIONAL

- `validateCosts`' `established === null` branch is unreachable after
  `knownCosts(trusted.costs)`. Harmless; reads as a stronger guarantee than it is.
- Two detail-sorting conventions coexist: `Object.entries(...).sort()` for
  deduplication keys and explicit sort-by-key in the encoders. Both deterministic;
  the inconsistency invites a future divergence between a dedup key and a digest.
- The same condition — a quote naming a representation the registry does not list
  — yields `REPRESENTATION_NOT_DISCOVERABLE` in `evaluateRoutes` and
  `REPRESENTATION_UNKNOWN` in `filterForMandate`.
- Positional Jev choice ids (`route_000`) make a captured choice syntactically
  valid in a later evaluation. Harmless, since it is only an index into that
  set's own members, but the receipt does not bind a choice to the set digest it
  answered.

---

## 19. Architectural invariants verified

Re-derived from the implementation during this review, not carried over.

| Invariant | Status | How it was confirmed |
| --- | --- | --- |
| INV-1 · intent is authoritative; nothing widens authority | **Holds** | Every constraint read by a check originates in the signed mandate. Allowlists are closed; an empty allowlist permits nothing |
| INV-2 · a signature alone never authorizes | **Holds** | Recovery and principal identity are separate checks with separate codes |
| INV-3 · the permitted set is identical with, without, failed or adversarial Jev | **Holds** | Re-measured: identical closed-set digest, handoff a member of the deterministic set, kernel PASS on the handoff. Qualified by F-13 (availability, not the set) |
| INV-4 · model output never supplies an address, amount or constraint | **Holds** | `parse.ts` produces a string, a unit-interval number and token counts; nothing else. No deserialization path exists |
| INV-5 · fail closed; `UNKNOWN` rejects | **Holds for financial decisions** | Every `UNKNOWN` and every absent input rejects. Qualified by F-3: at the encoding boundary the failure is a throw rather than a verdict |
| INV-6 · canonical identity distinct from token identity | **Holds** | Distinct types; the underlying is a claim set, not a field; no equivalence field exists and a structural test enforces its absence |
| INV-7 · execution addresses come only from the registry | **Holds** | Evaluation is by identifier; an unregistered contract is never scored. The kernel never parses an address |
| INV-8 · optimization only over already-valid candidates | **Holds** | Registry and kernel PASS precede ranking; quality is not a weighted authorization score |
| INV-9 · corporate-action state is part of correctness | **Holds** | Epoch checked in both directions with distinct codes, plus its own freshness bound |
| INV-11 · every decision explainable and reproducible from its receipt | **Holds except at the F-3 boundary**, where no receipt is produced |
| INV-12 · an authorization is consumed; a consumed one never executes | **Holds in the verifier; broken in the state machine** | `checkReplay` is correct. `RECLAIM` un-consumes a live authorization (F-1) |
| INV-16 · no floating point in a safety decision | **Holds** | All `bigint`; structural test rejects float literals, `parseFloat` and `Math` arithmetic in the kernel |
| INV-17 · every observed value carries provenance and a freshness bound | **Holds** | `Observed<T>` is the only accepted shape; advisory and untrusted refused at parse time *and* re-asserted at run time |
| INV-18 · every quantity carries unit and decimals | **Holds** | `Price` is a ratio of two named units; a shares/dollars transposition cannot type-check, and `notionalBounds` re-checks the units |
| Determinism | **Holds** | Executed: identical receipt digests across representation ordering, object key ordering and allowlist authoring order; stable across repeated evaluation. No locale, wall-clock, float or implicit coercion in a decision path |
| Canonical encoding | **Holds** | `encode(decode(b)) == b`; trailing bytes reject; sets strictly ascending by encoded bytes; frozen wire codes |

## 20. Architectural invariants not yet enforceable

| Invariant | Why not yet | Who closes it |
| --- | --- | --- |
| INV-10 · safety-critical time comes from the chain | No chain interaction exists. Today the clock is a caller parameter and nothing constrains it (F-9) | Phase 6 |
| INV-13 · the transaction submitted is the transaction verified | No transaction exists. And `candidateDigest` is currently missing the fee commitment (F-2), so the gate must not be built against today's digest | Phase 6 |
| INV-14 · no silent substitution between representations | Enforced in code, but **not exercised**: every corpus world has one representation (F-10) | Phase 5 corpus, then Phase 6 differential tests |
| INV-15 · cross-representation comparison is never by raw token amount | Holds in the ranking arithmetic, but unexercised for the same reason as INV-14 | Same |
| Atomic consumption | The replay store does not exist; the kernel cannot detect a double reserve (V-53) | Phase 6 |
| Two implementations agree | Only one exists. The corpus is the mechanism, not the evidence (V-55) | Phase 6 |
| Auditability across a restart | Nothing persists | Phase 6/8 |

---

## 21. Required Phase 6 closure items

Ordered by whether they must precede the gate's design.

**Must precede Phase 6, because Phase 6 freezes them.**

1. **Add the all-in cost bound to the mandate and the fee total to the
   candidate** (F-2, F-4). The gate re-asserts `candidateDigest`; if fees are not
   in it, the gate cannot bound them and the omission becomes permanent.
2. **Decide whether `candidateDigest` should commit to the route** — steps,
   venue path and provider class currently live only in `routingCandidateDigest`,
   which nothing on chain will read.
3. **Replace the nominal state binding with a content binding** (F-8): the
   candidate should carry `trustedStateDigest`, which the gate can then require.
4. **Reconcile the chain inside `representationId`** (F-6), so the gate's
   "call this token on this chain" derives from one value, not two.
5. **Fix `RECLAIM`** (F-1) before an on-chain nonce is designed around the
   off-chain state machine's semantics.

**The gate itself must close atomically.**

6. **Consumption of the mandate digest** — a nonce or bitmap written in the same
   transaction as the action, so a double reserve is impossible rather than
   merely detectable.
7. **Re-assertion of the full commitment** — mandate digest, candidate digest
   (with fees), registry snapshot digest, state digest, epoch — checked against
   chain-observed values in the same transaction.
8. **`block.timestamp` as the safety-critical clock** (INV-10), which closes F-9
   by construction.
9. **The `representationId` → token mapping**, committed on chain so the opaque
   identifier the kernel commits to resolves to exactly one address.
10. **Reference price and epoch asserted at execution**, not merely observed
    before it.
11. **Reorg reconciliation** — what a confirmed-then-reverted execution does to
    a consumed mandate.

**Differential tests Phase 6 will require.** Every place one decision will exist
in two implementations:

| Decision | TypeScript | Solidity | Shared vector source |
| --- | --- | --- | --- |
| MCE encoding and `mandateDigest` | `encoding/codec.ts` | gate | `corpus/v1` (now `corpus/v2`) |
| EIP-712 signing hash and recovery | `authorization/` | gate | `corpus/v1` (now `corpus/v2`) |
| `candidateDigest` | `encoding/codec.ts` | gate | `corpus/v1` (now `corpus/v2`) |
| Notional consistency and the one-atom band | `units.ts` | gate | new |
| `maxNotional` / all-in cost | `checks.ts` + `candidate.ts` (**two places today — F-2**) | gate | new |
| Deviation in bps, rounding up | `units.ts` | gate | new |
| Freshness and validity-window boundaries | `checks.ts` | gate | new |
| Epoch comparison | `checks.ts` | gate | new |
| Replay transitions | `replay.ts` | nonce/bitmap | new |
| Registry snapshot digest | `registry/encoding.ts` | root commitment | `corpus/registry-v1` |

Two further divergences to test independently of Solidity: **fixture versus
production adapter** (the recorded mainnet fixtures and the live paths share
their parsers, which is right, but only the fixtures are exercised in CI), and
**simulation versus runtime** (`dataClass` is deliberately never read by a
decision, and a structural test enforces that — this must survive Phase 6).

---

## 22. Explicit production-readiness gaps

Separate from correctness. None of these is a defect in Phases 1–5; all are
absent by scope.

| Gap | Consequence today |
| --- | --- |
| No persistence of any kind | A crash loses the receipt trail and every replay record |
| No replay store with compare-and-swap | Double reserve is undetectable (V-53) |
| No execution path | Nothing is submitted; INV-13 cannot hold |
| No revocation | Bounded validity is the only control, correctly |
| No key management | The principal's key is assumed safe, correctly |
| No rate limiting or admission control | Pure packages cannot provide it |
| No metrics, tracing or alerting | The signals in §16 do not exist. A permanently broken Jev integration is invisible by design |
| No registry change control | The highest-leverage non-key asset has no multi-party review, no signed snapshots, no rollback |
| No live characterization of Jev in CI | Correctly isolated and honestly labelled; the offline fixtures are the contract |
| No multi-source price gate | Cross-surface agreement is reported, not enforced |
| No partial-fill model | Deliberate (§7 of replay semantics); `FILL_OR_KILL` only |
| No operational runbook | No documented response to F-1's `RECLAIM`, a registry conflict, or a cost mismatch |

---

## 23. Final verdict

**1 · Architecture soundness through Phase 5 — SOUND.**
The decomposition is right and the boundaries are real. Identity is separated
from representation, admissibility from quality, advice from authority, and each
separation is enforced structurally rather than by convention. The two decisions
that would have been hardest to retrofit — canonical encoding with frozen wire
codes, and exact integer arithmetic with units in the type system — were made
correctly at the start. No finding in this review requires moving a boundary.

**2 · Safety of the pre-execution decision layer — SOUND FOR IDENTITY, INCOMPLETE FOR ECONOMICS.**
Every identity, representation, provenance, freshness, corporate-action, replay
and model-input path was traced and each closes correctly. No plausible path was
found by which unauthorized intent, a wrong asset, an invalid representation,
manipulated route data, model output or malformed external input reaches a
candidate the kernel calls safe. The economic half is weaker: the all-in cost
bound lives outside the authoritative layer (F-2) and a SELL cannot bound its own
proceeds at all (F-4). Both are schema gaps, not structural ones.

**3 · Production reliability readiness — NOT READY, AND CORRECTLY SO.**
No persistence, no replay store, no metrics, no registry change control, no
execution. All absent by scope and honestly labelled. The one item that is a
defect rather than a gap is F-1, which turns an uncertain transaction outcome
into a second authorization.

**4 · Remaining execution-boundary risk — HIGH AND WHOLLY UNMITIGATED, AS DESIGNED.**
Nothing binds calldata, recipient, allowance, slippage or deadline to a verified
candidate, because there is no transaction. The documents say this plainly. The
one thing this review adds is that the boundary cannot simply be built on top of
today's commitments: `candidateDigest` omits fees, `referenceStateId` is a name
rather than a digest, and the chain is carried twice. Those must be fixed
*before* the gate is designed, or the gate inherits them permanently.

**5 · Can Phase 6 proceed without redesigning Phases 1–5? — YES, with one
schema change first.**
No component boundary, dependency direction, trust level or decision ownership
needs to move. The mandate schema needs one addition — an all-in economic bound,
symmetric across BUY and SELL — and that is a Phase 1 artifact, so it must land
before Phase 6 freezes the commitment. Everything else (F-1, F-3, F-5, F-6, F-8)
is a bounded fix inside an existing design.

### ARCHITECTURE SOUND WITH REQUIRED REMEDIATIONS

**Why.** The architecture's central claims survived adversarial review against
the implementation rather than the documents. Jev independence, canonical
encoding, fail-closed resolution, the claim model's conflict policy and
determinism were all re-derived and all hold. What failed were four specific
properties the documents assert and the code does not implement — `RECLAIM`'s
fail-closed guarantee, totality at the encoding boundary, the unconditional
handoff re-verification, and the placement of the economic bound in the
authoritative layer — plus one schema gap that makes a ruinous SELL admissible.
Each is fixable without moving a boundary. That is the difference between
"requires remediation" and "requires redesign".

**Required before Phase 6 opens.**

1. Fix `RECLAIM` (F-1).
2. Add the all-in economic bound to the mandate and the fee total to the
   candidate (F-2, F-4).
3. Bound the four unbounded collections (F-3).
4. Require the handoff state, and correct the two documents that overstate it (F-5).
5. Reconcile the chain inside `representationId` (F-6) and bind the state by
   digest (F-8).

**Recommended in the same window.** Bind the registry snapshot to the trusted
state (F-7); extend the corpora to multi-representation worlds with real
substitution mutations (F-10); bound response bodies (F-11); make the Jev
fallback total (F-13).


---

## 24. Remediation status (Phase 5R)

Phase 5R closed the findings that had to be closed before the Solidity execution
boundary freezes the protocol. This section records what happened to each one;
the analysis above is unchanged.

### HIGH

| # | Finding | Status | Where |
| --- | --- | --- | --- |
| **F-1** | `RECLAIM` reopens a live authorization | **REMEDIATED** | `RECLAIM` replaced by `QUARANTINE` + `RECONCILE`; new `QUARANTINED` status the verifier refuses with `MANDATE_QUARANTINED`; `ReconciledOutcome` has no `UNKNOWN` member ([ADR 0015](adr/0015-replay-quarantine-and-reconciliation.md)) |
| **F-2** | All-in cost enforced outside the authority and outside the commitment | **REMEDIATED** | `economicLimit` added to the signed mandate, `feeTotal` to the candidate; `checkEconomicLimit` is the sole enforcement point; the router's `TOTAL_COST_EXCEEDS_MANDATE` is gone; `candidateDigest` commits to the fee ([ADR 0014](adr/0014-symmetric-signed-economic-authorization.md)) |
| **F-3** | `verify()` and `route()` throw instead of returning a verdict | **REMEDIATED** | Bounds on trusted-state representations, registry claim sets, source versions, listings and aliases, each equal to its encoder's `u16`; digest step guarded so an internal failure rejects with a receipt |
| **F-4** | A SELL mandate cannot bound its own proceeds | **REMEDIATED** | Same field as F-2, read as `MIN_TOTAL_CREDIT` on a SELL; `FEES_EXCEED_NOTIONAL` for a net debit |
| **F-5** | Handoff re-verification reads evaluation-time state | **REMEDIATED**, then **CORRECTED in 5R.1** | `HandoffInputs` required by `route()`, `selectEvaluated()` and `selectWithJev()`; no default ([ADR 0016](adr/0016-pipeline-time-and-handoff-freshness.md)). The 5R remediation was sound and the *candidate binding* added for F-8 then made every fresh handoff fail regardless of safety, so `FINAL_REVERIFICATION_FAILED` was reachable only for the wrong reason — see N-1 |
| **F-44/45** | No atomic replay store, no reorg handling | **PHASE 6** — unchanged, and correctly scoped there |

### MEDIUM

| # | Finding | Status | Where |
| --- | --- | --- | --- |
| **F-6** | Chain inside `representationId` never reconciled | **REMEDIATED** | `checkRepresentationChain` on the candidate and every state entry; `chainSegmentOf` reads only the chain half, so INV-7 is unchanged |
| **F-7** | Registry snapshot not bound to trusted state | **REMEDIATED**, **STRENGTHENED in 5R.1** | `TrustedState.registrySnapshotDigest`, carried opaquely by the kernel and compared by the router against the snapshot it evaluated. 5R left it opt-in — a state declaring none was accepted — which N-8 closed: the candidate now commits to the snapshot, the kernel compares it, and the router enforces it at the handoff stage too |
| **F-8** | `referenceStateId` binds a name, not content | **REMEDIATED**, **SUPERSEDED in 5R.1** | The diagnosis was right and the cure over-corrected. `referenceStateDigest` bound the *whole* state and was compared at every call, which made a re-verification against fresh state impossible — the defect N-1 found. The candidate now carries layered commitments: evaluation provenance (committed, not compared) and the registry snapshot (compared), with dynamic facts re-evaluated ([ADR 0017](adr/0017-layered-candidate-state-commitments.md)). F-8's own property survives: two states sharing one label are still told apart, by the predicates over their content |
| **F-9** | Clock is an unconstrained caller input | **PARTIALLY REMEDIATED** | The router enforces that the handoff instant is not earlier than the evaluation instant (`HANDOFF_TIME_REGRESSED`), and the time-authority model is now stated rather than assumed. A caller that rewinds both instants consistently still defeats every age bound; no off-chain component can detect that, and `block.timestamp` at the Phase 6 gate closes it (INV-10) |
| **F-10** | Adversarial coverage is one mutation class over single-representation worlds | **REMEDIATED** | `packages/router/test/adversarial-worlds.test.ts`: six registered representations of one asset across two chains, with combined economic-plus-identity attacks, conflicting and mixed-age claims, a corporate action across the set, a halt between evaluation and handoff, and a 256-candidate boundary set |
| **F-11** | No response-size bound on either network client | **REMEDIATED** | Incremental size-bounded body reading in both clients, tested below and above each limit |
| **F-12** | A schema bump invalidates every outstanding mandate | **ACCEPTED, DOCUMENTED** | Exercised deliberately by this phase: v1 mandates are rejected, not migrated, because none exists outside a fixture. What a post-launch schema change needs instead — a declared acceptance window with one frozen codec per version — is recorded in ADR 0014 as a production-readiness requirement rather than built for a population of zero |
| **F-13** | Jev holds availability authority | **REMEDIATED** | A handoff rejection of a Jev-chosen candidate falls back to index 0 and re-verifies it, recorded as `HANDOFF_REJECTED_FALLBACK`; an optional local circuit breaker stops a sustained outage taxing every decision |
| **F-48** | Single-source price accuracy | **PHASE 6+** — unchanged. Cross-surface agreement is still reported, not gated |

### LOW and INFORMATIONAL

| # | Finding | Status |
| --- | --- | --- |
| **F-14** | Deviation is symmetric | **ACCEPTED.** A favourable fill outside the bound still rejects. Making the bound one-sided is a product decision about what a principal is authorizing, not a defect, and it was not in Phase 5R's scope |
| **F-15** | A zero-quantity candidate is authorized | **ACCEPTED, NARROWED.** Still passes the kernel; the router requires the quote to match the caller's `requestedQuantity` exactly, so reaching it means the caller asked for zero. A minimum-size field would be another mandate schema change and no requirement for one has appeared |
| **F-16** | No persistence anywhere | **PHASE 6** — unchanged |
| INFO | `validateCosts` dead branch | **CLOSED in 5R.1** (N-10). The branch is gone and cost validation is three ordered passes: commensurability, then agreement with independent cost state, then summation |
| INFO | Two detail-sorting conventions | **OPEN.** Both deterministic |
| INFO | Two reason codes for an unregistered contract | **OPEN, now pinned.** `REPRESENTATION_NOT_DISCOVERABLE` through the router and `REPRESENTATION_UNKNOWN` through the registry filter. A test asserts which path produces which, so the divergence is visible rather than latent |
| INFO | A Jev choice is not bound to the set digest it answered | **OPEN.** Harmless: a choice is only an index into that set's own members |

### What Phase 5R did not change

The architecture. No component boundary, dependency direction, trust level or
decision ownership moved. The one structural change was moving economic
authority *into* the verifier, which is where §5 of this report said it already
belonged.

### Verdict after remediation

The report's verdict was **ARCHITECTURE SOUND WITH REQUIRED REMEDIATIONS**, and
listed five items as required before Phase 6 opens. All five are done:

1. Fix `RECLAIM` — done (F-1).
2. Add the all-in economic bound to the mandate and the fee total to the
   candidate — done (F-2, F-4).
3. Bound the four unbounded collections — done (F-3).
4. Require the handoff state and correct the two documents that overstate it —
   done (F-5); `jev-integration.md` and `security-review.md` both carry the
   correction rather than a quiet rewording.
5. Reconcile the chain inside `representationId` and bind the state by digest —
   done (F-6, F-8).

All four recommended items are also done: F-7, F-10, F-11 and F-13.

**No known HIGH finding remains in the off-chain architecture.** What remains is
owned by Phase 6 and named there: atomic on-chain consumption, chain-sourced
time, transaction binding, reorg reconciliation, and a reconciliation path for
quarantined authorizations.

## Phase 5R.1 — post-remediation audit findings

An independent audit of the Phase 5R remediation found ten further items, N-1
through N-10. They are not new areas of the architecture: seven of them are places
where a Phase 5R fix was incomplete, over-applied, or described a property the code
did not enforce. The architecture itself was not re-litigated and did not change.

### The one that mattered

| # | Finding | Status | Where |
| --- | --- | --- | --- |
| **N-1** | The candidate's whole-state digest binding made every fresh handoff fail | **REMEDIATED** | Candidate schema v3 layers the commitments by kind of fact: evaluation provenance is committed and never compared, the registry snapshot is committed and compared, dynamic facts are re-evaluated by the check that owns each one ([ADR 0017](adr/0017-layered-candidate-state-commitments.md)). A safe refresh now succeeds; an unsafe one rejects for its own reason code |

This is the finding the rest hang off. Phase 5R made the handoff read fresh state
(F-5) and, in the same phase, made a candidate require the state it is verified
against to be byte-identical to the state it was built against (F-8). The two are
mutually exclusive, and their intersection was a handoff that could only ever pass
by replaying the evaluation state — the tautology F-5 existed to remove.

### The rest

| # | Finding | Status | Where |
| --- | --- | --- | --- |
| **N-2** | Handoff tests asserted only `NO_VALID_ROUTE`, which the N-1 defect satisfied | **REMEDIATED** | `router/test/handoff.test.ts`: ten cases, each asserting the reason code its predicate produces, plus the case nothing tested before — a safe refresh that must *succeed*. The F-5 and F-7 pinning tests are strengthened the same way |
| **N-3** | `RECONCILE` treated every unrecognized outcome as FAILED | **REMEDIATED** | `parseReconciledOutcome` matches `SETTLED` and `FAILED` exactly; seventeen hostile values tested, each leaving the authorization unavailable. No branch defaults ([ADR 0018](adr/0018-observed-execution-outcomes.md)) |
| **N-4** | `applyTransition` returned `undefined` for an unrecognized transition | **REMEDIATED** | Every caller-controlled field parsed before any branch; exhaustive switch with a `never` guard; `RETIRED_REPLAY_TRANSITIONS` exported so refusing `RECLAIM`, `COMMIT` and `RELEASE` is a tested behaviour |
| **N-5** | `RELEASE` restored an authorization on a bare command | **REMEDIATED** | `COMMIT` and `RELEASE` removed; one `RECONCILE` carrying a validated `ExecutionObservation` — outcome, time, source, reference — recorded on the resulting record. A validated assertion, not a proof: verification against a chain is Phase 6 |
| **N-6** | The totality claim was stated unscoped | **REMEDIATED** | V-2 and new V-9: total over parsed, plain values — the scope of every external input — and one-directional outside it, where a hostile host object may make `verify` throw and must never make it PASS. Proxy-trap defence is deliberately not attempted |
| **N-7** | `ReplayError.KEY_MISMATCH` was unreachable | **REMEDIATED** | Removed. Key reconciliation belongs to the Phase 6 persistence layer that performs the lookup, and `replay-semantics.md` §8 names it as the store's obligation. A test now asserts every remaining replay error is reachable |
| **N-8** | Removing digest equality removed the incidental registry binding | **REMEDIATED** | The binding is explicit and no longer opt-in: `REGISTRY_SNAPSHOT_MISMATCH` and `REGISTRY_SNAPSHOT_UNKNOWN` in the kernel, enforced by the router at both stages. A changed snapshot fails closed and the caller reroutes |
| **N-9** | `trustedCosts` was unbounded | **REMEDIATED** | `MAX_TRUSTED_ROUTE_COSTS`, defined as `MAX_ROUTE_CANDIDATES` so the two cannot drift: one cost entry per route quote, duplicates refused, the route set bounded at that number. Tested below, at and above, with a typed `RESOURCE_LIMIT_EXCEEDED` refusal applied before any entry is parsed |
| **N-10** | `validateCosts` unit check sat behind a dead branch | **REMEDIATED** | Three ordered passes; commensurability returns before any summation; a regression case proves costs differing from the notional only in unit or scale cannot be numerically added |

### What Phase 5R.1 did not change

The architecture, again. No component boundary, dependency direction, trust level
or decision ownership moved. Two wire formats changed, both deliberately and both
versioned: the execution candidate is schema v3 under the `MANDATE.CANDIDATE.V3`
domain tag, and the replay transition vocabulary lost `COMMIT` and `RELEASE`. A v2
candidate does not parse and a retired transition is a typed refusal, so neither
change is silent.

One property was deliberately tightened beyond the finding: a trusted state must
now declare the registry snapshot its representations came from. Accepting an
undeclared snapshot would mean the structural binding silently does not exist, and
the kernel's own rule is that unestablished provenance is UNKNOWN and UNKNOWN
rejects.

### Still owned by Phase 6

Unchanged by this phase, and named so nothing assumes otherwise: atomic on-chain
consumption, chain-sourced time, transaction binding, reorg reconciliation, a
reconciliation path that verifies an observation rather than validating it (V-59),
key reconciliation in the replay store (N-7), and a cross-snapshot compatibility
proof if one is ever wanted instead of failing closed (V-60).
