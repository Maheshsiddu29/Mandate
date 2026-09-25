# Architecture

System structure, component boundaries, and where each concern is enforced.

> **Status: Phase 5R.1 complete.** The kernel, registry, read-only Robinhood
> external-data adapter, deterministic router and the optional Jev advisory
> layer are built, and the remediations the
> [architecture pressure test](production-architecture-pressure-test.md)
> required before the execution boundary are applied: symmetric signed economic
> authorization ([ADR 0014](adr/0014-symmetric-signed-economic-authorization.md)),
> replay quarantine ([ADR 0015](adr/0015-replay-quarantine-and-reconciliation.md)),
> and mandatory fresh handoff state with monotonic pipeline time
> ([ADR 0016](adr/0016-pipeline-time-and-handoff-freshness.md)). The
> post-remediation audit then found that the last of those was defeated by the
> candidate's whole-state digest binding, so candidate commitments are layered by
> the kind of fact each carries
> ([ADR 0017](adr/0017-layered-candidate-state-commitments.md)) and every replay
> resolution carries validated evidence
> ([ADR 0018](adr/0018-observed-execution-outcomes.md)). MCE is at schema v2 for
> the mandate and trusted state; the execution candidate is at schema v3.
> Transaction construction and submission, execution
> contracts, funding and web work remain planned. Jev has not been
> characterized against a live account
> ([jev-characterization.md](jev-characterization.md)).
> The "Phase" column records when a component lands; see [roadmap.md](roadmap.md).
> The complete rationale for every decision here is in
> [mandate-design.md](mandate-design.md) — this document is the structural
> summary, not the argument.

## 1. Shape of the system

```
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ PRINCIPAL                                                               │
  │ authors and signs a mandate: canonical asset, side, limits,             │
  │ permitted issuers, instrument constraints, freshness, expiry            │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │  signed mandate            AUTHORITATIVE
  ┌────────────────────────────────▼────────────────────────────────────────┐
  │ AGENT                                                                   │
  │ acts under the mandate. Supplies no addresses, no amounts,              │
  │ no constraint values.                                                   │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
  ┌────────────────────────────────▼────────────────────────────────────────┐
  │ RESOLUTION          canonical asset ──▶ representations                 │
  │ registry lookup; ambiguity rejects; addresses originate here only       │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │  admissible representations
  ┌────────────────────────────────▼────────────────────────────────────────┐
  │ DISCOVERY           representations ──▶ execution candidates            │
  │ venue adapters, market-state adapters; each observation carries         │
  │ provenance and an observation time                                      │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │  candidates + state snapshots
  ┌────────────────────────────────▼────────────────────────────────────────┐
  │ ADMISSIBILITY       registry + kernel verification          AUTHORITATIVE│
  │ only PASS candidates continue; every exclusion is retained              │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │  closed admissible candidate set
  ┌────────────────────────────────▼────────────────────────────────────────┐
  │ SELECTION           deterministic ranking; Jev may advise, never permit │
  │ exact cost, deviation, freshness, complexity, stable digest tie-break   │
  │ an advisory choice is an index into this closed set, and nothing else   │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │  one selected candidate
  ╔════════════════════════════════▼════════════════════════════════════════╗
  ║ VERIFICATION        pure, total, deterministic, model-free  AUTHORITATIVE║
  ║ verify(mandate, candidate, state, clock) -> PASS | REJECT + reason codes ║
  ╚════════════════════════════════┬════════════════════════════════════════╝
                                   │  PASS only
  ┌────────────────────────────────▼────────────────────────────────────────┐
  │ EXECUTION           submit the verified candidate                       │
  │ on-chain gate re-asserts the commitment atomically with the action      │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
  ┌────────────────────────────────▼────────────────────────────────────────┐
  │ SETTLEMENT & RECONCILIATION                                             │
  │ observed result; receipt; intended versus realized                      │
  └─────────────────────────────────────────────────────────────────────────┘
```

The double border on VERIFICATION is the point of the diagram. Everything
above it is a proposal. It is the only component that authorizes, and it
trusts none of its callers.

## 2. Components

| Component | Responsibility | Phase | Status |
| --- | --- | --- | --- |
| Mandate types | The authorization object: schema, canonical encoding, digest, signature | 1 | **implemented** — `packages/kernel/src/mandate.ts`, `encoding/`, `authorization/` |
| Deterministic verifier | `verify(mandate, candidate, state, clock) -> Verdict`. Pure, total, fail-closed, model-free | 1 | **implemented** — `packages/kernel/src/verifier/` |
| Reason-code registry | Stable namespaced codes with data-driven explanations | 1 | **implemented** — 43 codes; [reason-codes.md](reason-codes.md) |
| Replay semantics | Pure consumption state machine; the store stays outside the kernel | 1 | **implemented** — [replay-semantics.md](replay-semantics.md) |
| Decision-vector corpus | Cross-implementation compatibility contract | 1, reissued 5R | **implemented** — `corpus/v2`, 67 vectors |
| Canonical asset registry | Canonical identities and their external identifier schemes | 2 | **implemented** — `packages/registry/src/asset-id.ts`, `asset.ts` |
| Representation registry | Tokenized representations, their metadata and provenance | 2 | **implemented** — `packages/registry/src/representation.ts`, `claims.ts`, `semantics.ts` |
| Resolution | Human reference → canonical asset → admissible representations | 2 | **implemented** — `packages/registry/src/reference.ts`, `asset-index.ts`, `evaluate.ts` |
| Registry snapshots and digests | Reproducible registry state a decision can be replayed against | 2 | **implemented** — `packages/registry/src/snapshot.ts`, `encoding.ts` |
| Registry decision vectors | Cross-implementation contract for resolution and admissibility | 2 | **implemented** — `corpus/registry-v1`, 27 vectors |
| Robinhood market-state adapter | Strict asset, price, halt, capability and corporate-action normalization with provenance | 3 | **implemented** — `packages/adapter-robinhood` |
| Robinhood mainnet read adapter | Chain identity, fixed-block code/metadata/multiplier/event/oracle reads | 3 | **implemented read-only** — no transaction construction or submission |
| Mainnet replay corpus | Recorded REST/RPC state through registry and kernel, with stable digests and metrics | 3 | **implemented** — `corpus/mainnet-v1`, 11 vectors |
| Transaction construction and submission | Build and submit a transaction bound to a verified candidate | 6 | not implemented |
| Candidate engine | Strict provider parsing and candidate construction over trusted normalized state | 4 | **implemented** — `packages/router` |
| Ranking | Lexicographic exact-cost ordering of kernel-PASS candidates | 4 | **implemented** — ADR 0010 |
| Routing receipts and simulation | Deterministic selection audit, mainnet candidate replay and seeded adversarial worlds | 4 | **implemented** |
| Jev adapter | Advisory selection over a closed candidate set; bounded, abstention-safe | 5 | **implemented** — `packages/jev`; live characterization outstanding |
| Advisory receipts | `JevDecisionReceipt` and the selection record binding it to the routing receipt and handoff verification | 5 | **implemented** — no verifier reads either |
| Jev evaluation corpus | 13 advisory scenarios over six recorded symbols in five modes, with measured safety counters | 5 | **implemented** — `corpus/jev-evaluation-v1` |
| Execution gate | On-chain re-assertion of the commitment, atomic with the action | 6 | not implemented |
| Funding adapters | Stablecoin funding abstraction | 7 | not implemented |
| Receipts and audit | Structured receipt for every attempt, including refusals | 1, then 8 | **implemented** (kernel receipts); audit surfacing is Phase 8 |
| Demo and web | Public demonstration, including deliberate failure demonstrations | 8 | not implemented |

Directories are created when they hold real code.

```
packages/kernel/     the verifier and everything it needs (ADR 0003)
packages/registry/   canonical assets, representations, resolution (ADR 0004)
packages/adapter-robinhood/ strict external I/O and normalization (ADR 0008)
packages/router/     pure candidate construction, filtering and ranking
packages/jev/        optional advisory selection over a closed set (ADR 0012)
corpus/v2/           cross-implementation verifier decision vectors (MCE v2)
corpus/registry-v1/  cross-implementation registry decision vectors
corpus/mainnet-v1/   recorded mainnet registry-plus-kernel replay vectors
corpus/mainnet-routing-v1/ recorded state plus synthetic route economics
corpus/routing-simulation-v1/ seeded execution-world validation metrics
corpus/jev-evaluation-v1/ advisory-layer safety and selection metrics
docs/adr/            architecture decision records
```

The external adapter and router depend inward — never the reverse. The router
consumes adapter-normalized values but does not import an issuer adapter.
Structural tests enforce all four boundaries: the kernel imports nothing
outside itself and its two allowlisted crypto dependencies, the registry imports
nothing outside itself and the kernel, and neither imports the adapter
([ADR 0004](adr/0004-registry-package-boundary.md),
[ADR 0008](adr/0008-robinhood-data-source-authority.md)). The router imports
only the registry and kernel and cannot reach I/O, environment, randomness,
implicit clocks, Jev or another model client.

```
adapter  ──▶ registry ──▶ kernel             permitted
router   ──▶ registry ──▶ kernel             permitted
jev      ──▶ router ──▶ registry ──▶ kernel  permitted
kernel/registry/router ──▶ jev               forbidden, structurally
kernel/registry ──▶ adapter/router           forbidden, structurally
```

The last direction is the one that matters for INV-3. The router cannot import
the advisory layer, cannot detect its presence, and behaves identically whether
or not it exists. A structural test in `packages/jev` asserts that the kernel,
registry and router neither declare nor import `@mandate/jev`, and the router's
own structural test fails if a model client appears in its source.

## 3. Trust levels

Every input carries a trust level, and its level bounds what it may influence.

| Level | Sources | May influence |
| --- | --- | --- |
| **Authoritative** | Signed mandate; on-chain state read at execution | Anything, including admissibility |
| **Verified** | Registry entries under change control; market state from configured providers, with provenance and freshness | Admissibility, subject to freshness checks |
| **Advisory** | Jev output; heuristic rankings | Ordering within the already-admissible set only — expressed as an index into a closed array, never as a value |
| **Untrusted** | Model-authored text, tool responses, external content, free text | Nothing. Quotable in audit records; never a source of an address, amount or constraint |

The rule that does the work: **an address, an amount, or a constraint value
never originates from an untrusted or advisory source.** Addresses come from
the registry; amounts come from the mandate and quoted market state;
constraints come from the signed mandate.

## 4. Where each concern is enforced

| Concern | Enforced in | Not enforced in |
| --- | --- | --- |
| Is the asset the right financial asset? | Resolution + verifier (identity checks) | Ranking, Jev |
| What financial asset did a human mean? | Registry resolution — ambiguity rejects | The verifier, which is handed an identity, not a reference |
| Is this representation acceptable? | Registry admissibility, then re-checked by the verifier (semantics checks) against registry metadata | Discovery, ranking |
| Do the data sources about a representation agree? | Registry claim resolution — conflict fails closed | The verifier, which reads one resolved value |
| Is the amount within authority? | Verifier (economic checks) — `maxNotional` for gross exposure and `economicLimit` for cash flow, fees included | Candidate engine, which establishes the fee total and ranks on it but holds no economic permission (ADR 0014) |
| Is the state fresh enough? | Verifier (state checks) against observation times | Adapters |
| Is the corporate-action state current? | Verifier (epoch check) | Adapters |
| Is the agent authorized? | Verifier (authorization checks) | Authentication layer |
| Is the submitted transaction the verified one? | Execution gate | Off-chain code |
| Which admissible candidate is best? | Ranking, optionally Jev | Verifier — it does not rank |
| Is the decision still valid at handoff? | Verifier, re-run on caller-supplied handoff state, re-evaluating every dynamic predicate rather than comparing digests; the router requires the state and refuses a handoff instant earlier than the evaluation instant | Evaluation-time state, which is never reused as handoff state (ADR 0016) |
| Did the registry and the trusted state come from one snapshot? | Both. The kernel compares the state's declared `registrySnapshotDigest` against the candidate's own commitment; the router compares it against the registry it evaluated, at the evaluation *and* the handoff stage (ADR 0017) | Neither may skip it: an undeclared snapshot is `REGISTRY_SNAPSHOT_UNKNOWN`, not agreement |
| Which world was a candidate built against? | Nobody enforces it; the candidate commits to it (`evaluationStateId`, `evaluationStateDigest`) so an auditor can reconstruct it | The verifier, which must not compare it — it sees one instant per call and cannot know which pipeline stage it is in (ADR 0017) |

Read the table as a boundary specification: a component appearing in the
right-hand column must not acquire the corresponding responsibility later.

## 5. Structural rules

These constrain implementation and are testable as properties of the codebase,
not only of its behaviour.

1. **The verifier's dependency graph contains no inference client, no network
   client, and no clock.** Time is a parameter. This is checked structurally,
   not by convention.
2. **The verifier performs no I/O.** Every input is a value; every output is a
   value.
3. **Adapters are independent.** Two issuers, two venues or two chains never
   share assumed semantics. An adapter that cannot express a venue's or an
   issuer's semantics fails closed rather than approximating.
4. **Adding a chain, venue or issuer adapter must not require changing the
   verifier.** This is the test of whether the abstraction holds.
5. **`UNKNOWN` is a value, not an exception.** It flows through the types and
   causes rejection at the verifier. It is never an error a caller can catch
   and ignore.
6. **Every quantity carries its unit and decimals.** A unit-less quantity is
   not representable in the type system.
7. **Safety-critical comparisons use exact representations.** No safety
   decision is made on floating-point equality.
8. **Every observed value carries provenance and an observation time.** A bare
   value from an adapter is not accepted.
9. **Failure modes are tested, not just happy paths.** A check is not done
   until the rejection it produces is covered by a test.
10. **Architecture docs change in the same commit as the code they describe.**

## 5a. Phase 1: the kernel

What was built, and the decisions that shaped it.

| Area | Decision | Record |
| --- | --- | --- |
| Language | TypeScript on Node 22; runtime dependency allowlist of exactly two audited, network-free crypto packages, machine-checked | [ADR 0003](adr/0003-kernel-language-and-dependency-boundary.md) |
| Authorization | Chain-agnostic mandate digest; EIP-712 domain confined to the authorization envelope; one scheme implemented behind a registry | [ADR 0001](adr/0001-mandate-authorization-architecture.md) |
| Encoding | MCE v2 — flat, versioned, length-explicit binary, keccak-256, reproducible in Solidity | [ADR 0002](adr/0002-canonical-mandate-encoding.md), [ADR 0014](adr/0014-symmetric-signed-economic-authorization.md) |
| Verification | 19 independent checks, unioned and sorted, so a rejection names every violation and the verdict cannot depend on check order | [verifier-invariants.md](verifier-invariants.md) |
| Replay | Pure transition rules in the kernel; the store outside it. Reserve before signing, commit on observed settlement, release only on observed failure, **quarantine when the outcome was never established** | [replay-semantics.md](replay-semantics.md), [ADR 0015](adr/0015-replay-quarantine-and-reconciliation.md) |
| Compatibility | 67 decision vectors as a contract any future implementation must reproduce | [corpus/v2/README.md](../corpus/v2/README.md) |

The kernel's entry point is one function:

```
verify({ mandate, authorization, candidate, trustedState, clock, expectedDomain })
    -> VerificationReceipt { decision, reasonCodes[], violations[], digests, receiptDigest }
```

Totality is a property of that signature and was found to be false at the
encoding boundary before Phase 5R: an unbounded collection made the digest step
throw, so a refusal produced no receipt. Every collection the encoders count is
now bounded by its parser.

It accepts `unknown` for each input and parses at the boundary. That is what
makes totality real: a caller cannot hand it something unparseable and receive
a thrown error it might mistake for a transport failure.

## 5b. Phase 2: the registry

What was built, and the decisions that shaped it.

| Area | Decision | Record |
| --- | --- | --- |
| Package boundary | A separate package depending on the kernel, performing no I/O, so a decision is replayable and there is one decision engine rather than a real and a simulated one | [ADR 0004](adr/0004-registry-package-boundary.md) |
| Asset identity | Closed scheme vocabulary (`figi`, `isin`, `cusip`) with check-digit validation; resolution total over `RESOLVED` / `AMBIGUOUS` / `UNKNOWN` / `INVALID`, never a tie-break | [ADR 0005](adr/0005-canonical-asset-identity-and-resolution.md) |
| Provenance | Every security-relevant property is a claim set resolved against a `VERIFIED` trust floor; sub-floor claims neither establish nor conflict; conflicts fail closed unconditionally | [ADR 0006](adr/0006-representation-claims-and-conflict-policy.md) |
| Snapshots | MCE primitives with the registry's own tags and its own schema version, so registry evolution cannot change a mandate digest | [ADR 0007](adr/0007-registry-snapshot-encoding-and-digest.md) |
| Admissibility | A function of mandate, semantics and trusted state — never stored. Additional requirements can only narrow | [registry-semantics.md](registry-semantics.md) |
| Compatibility | 27 registry decision vectors | [corpus/registry-v1](../corpus/registry-v1/README.md) |

The registry's surface is resolution and filtering, not authorization:

```
resolve(registry, "NVDA")                    -> RESOLVED | AMBIGUOUS | UNKNOWN | INVALID
listRepresentations(registry, assetId)        -> representations issued against it
evaluateRepresentation(registry, req, id)     -> ADMISSIBLE | EXCLUDED + reasonCodes[]
toRepresentationState(record, req)            -> kernel trusted state, or an error
```

The last one is the seam. The registry's output is an *input* to the verifier,
re-checked from scratch, and it refuses to emit anything it could not establish
rather than substituting a permissive default.

## 5c-bis. Phase 5: the advisory layer

| Area | Decision | Record |
| --- | --- | --- |
| Authority | Jev is called only after the set is closed, returns a name used solely as a local array key, and supplies no value | [ADR 0012](adr/0012-jev-closed-set-authority-boundary.md) |
| Fallback | Every failure maps to one stable reason code and selects index 0; no retry inside a decision | [ADR 0013](adr/0013-jev-fallback-and-confidence-policy.md) |
| Abstention | `ABSTAIN` is a first-class outcome meaning "use the deterministic result", distinct from failure and from `NO_VALID_ROUTE` | [jev-integration.md](jev-integration.md) |
| Confidence | No threshold ships: the distribution it would be derived from has not been observed | [ADR 0013](adr/0013-jev-fallback-and-confidence-policy.md) |
| Cardinality | The API's 255-option limit never truncates an admissible set; above 254 the layer is skipped | [jev-integration.md](jev-integration.md) |
| Data minimization | Twelve declared view fields, built individually, enforced by an allowlist test over every payload key | [security-review.md](security-review.md) |
| Handoff | The selected candidate is re-verified against state the caller supplies for the handoff, which is **required** rather than defaulting to the evaluation state | [ADR 0016](adr/0016-pipeline-time-and-handoff-freshness.md), [jev-integration.md](jev-integration.md) |

The router was split into `evaluateRoutes` and `selectEvaluated` so the
advisory layer addresses the same ranked array the deterministic path selects
from. There is one ranking implementation, and `route()` is defined as
evaluate-then-select-index-0 with byte-identical Phase 4 receipts.

## 5c. Phase 3: Robinhood external state

The adapter is the only network-aware package. It strictly parses issuer REST
responses and fixed-block JSON-RPC observations into provenance-labelled values,
then builds the same registry records and kernel state used by synthetic worlds.

| Area | Decision | Record |
| --- | --- | --- |
| Authority boundary | Field-specific REST, issuer disclosure, onchain and curated-mapping authority; ticker never establishes identity | [ADR 0008](adr/0008-robinhood-data-source-authority.md) |
| Identity | Issuer UID and check-digit-valid ISIN must match an audited asset-class mapping; deployment identity also requires chain, address, code and metadata | [Robinhood integration](robinhood-integration.md) |
| Price | REST is underlying USD/share; token price applies `uiMultiplier` with observed 18-decimal truncation; Chainlink is already token-adjusted | [Robinhood integration](robinhood-integration.md#price-and-time-semantics) |
| Corporate actions | Latest effective multiplier event reconciled with fixed-block `uiMultiplier()` is the epoch; pending state remains distinct | [ADR 0009](adr/0009-corporate-action-epoch-authority.md) |
| Replay | Six unmodified real snapshots and five failure cases use registry plus unchanged kernel | [Mainnet replay](mainnet-replay.md) |
| Network isolation | Recorded fixtures are default; live capture/checks are explicit; normal CI remains offline | [Robinhood integration](robinhood-integration.md#developer-commands-and-network-isolation) |

## 6. Key decisions and their rationale

| Decision | Rationale | Detail |
| --- | --- | --- |
| Canonical asset identity separate from token identity | Representations of one underlying are not equivalent instruments | [§5](mandate-design.md#5-canonical-assets-and-token-representations) |
| Registry asserts only "issued against the same underlying" | Any stronger claim would be false and the system would be built on it | [§5.4](mandate-design.md#54-why-same-underlying-is-deliberately-weak) |
| Ambiguous resolution refuses rather than choosing | A tie-break is a guess about financial identity, and a guess that is right most of the time buys the wrong security the rest | [ADR 0005](adr/0005-canonical-asset-identity-and-resolution.md) |
| A sub-floor claim can neither establish a value nor create a conflict | Otherwise injecting an advisory claim denies service to every honest representation it touches | [ADR 0006](adr/0006-representation-claims-and-conflict-policy.md) |
| Registry admissibility is evaluated by identifier, never by caller-supplied record | Makes "an unregistered contract is never admissible" structural rather than a check that could be forgotten | [registry-semantics.md](registry-semantics.md) |
| Verifier is pure and total | Testability, auditability, reduced attack surface, portability | [§10.4](mandate-design.md#104-why-the-verifier-does-no-io) |
| Jev returns an index into a closed set | Returning an object is an opportunity to return a modified one | [§11.4](mandate-design.md#114-the-integration-surface) |
| Admissibility filtered before ranking, then re-verified after | Ranking and model selection sit between the filter and execution | [§12.1](mandate-design.md#121-admissibility-before-quality) |
| Corporate-action epoch rather than event-list comparison | Cheap integer check, on-chain expressible, asset-class agnostic | [§13.4](mandate-design.md#134-corporate-action-epoch) |
| On-chain gate binds the verified action | Off-chain PASS does not bind what is submitted | [§14.3](mandate-design.md#143-the-execution-gate) |
| Mandates carry no contract addresses | A compromised authoring path could otherwise redirect funds with a valid mandate | [§7.4](mandate-design.md#74-design-rules-for-the-mandate-schema) |
| Mandates carry no free text | A verifier must never interpret prose | [§7.4](mandate-design.md#74-design-rules-for-the-mandate-schema) |

## 7. Invariants

Eighteen invariants define the system and are listed with their enforcement
points in [mandate-design.md §16](mandate-design.md#16-major-invariants).
Per-property evidence is in [verifier-invariants.md](verifier-invariants.md) for
the kernel and
[registry-semantics.md §12](registry-semantics.md#12-registry-invariants-and-their-evidence)
for the registry. Phase 2 established INV-6 and INV-7. The four that shape the
architecture most:

- **INV-3** — the permitted-execution set is identical whether Jev is present,
  absent, failed or adversarial. This is why selection and verification are
  separate components rather than separate functions. **Established in Phase
  5** by an adversarial harness rather than by argument: across every hostile
  behaviour and every failure reason, the closed-set digest is unchanged, every
  handoff is a member of the deterministic admissible set, and every handoff
  carries a kernel `PASS`.
- **INV-5** — fail closed. This is why `UNKNOWN` is a value in the type system,
  and why a lapsed reservation quarantines rather than clearing itself: the
  passage of time is not an observation.
- **INV-7** — execution addresses come only from the registry. This is why
  resolution is a distinct stage that the agent cannot bypass, and why
  admissibility is evaluated by identifier rather than by a record a caller
  supplies.
- **INV-13** — the transaction submitted is the transaction verified. This is
  why an on-chain gate exists at all.

## 8. Threat model

Enumerated and assigned to components in
[mandate-design.md §17](mandate-design.md#17-threat-model-overview), including
an honest statement of what the design does not address. Phase 0 solves
nothing; it assigns each risk to the component and phase that must handle it.
