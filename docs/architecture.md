# Architecture

System structure, component boundaries, and where each concern is enforced.

> **Status: Phase 3 complete.** The kernel, registry, and read-only Robinhood
> external-data adapter are built. Routing, transaction construction and
> submission, Jev, execution contracts, funding and web work remain planned.
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
  │ SELECTION           ranking, then optionally Jev             ADVISORY   │
  │ returns an index into a closed candidate set, or abstains               │
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
| Decision-vector corpus | Cross-implementation compatibility contract | 1 | **implemented** — `corpus/v1`, 57 vectors |
| Canonical asset registry | Canonical identities and their external identifier schemes | 2 | **implemented** — `packages/registry/src/asset-id.ts`, `asset.ts` |
| Representation registry | Tokenized representations, their metadata and provenance | 2 | **implemented** — `packages/registry/src/representation.ts`, `claims.ts`, `semantics.ts` |
| Resolution | Human reference → canonical asset → admissible representations | 2 | **implemented** — `packages/registry/src/reference.ts`, `asset-index.ts`, `evaluate.ts` |
| Registry snapshots and digests | Reproducible registry state a decision can be replayed against | 2 | **implemented** — `packages/registry/src/snapshot.ts`, `encoding.ts` |
| Registry decision vectors | Cross-implementation contract for resolution and admissibility | 2 | **implemented** — `corpus/registry-v1`, 27 vectors |
| Robinhood market-state adapter | Strict asset, price, halt, capability and corporate-action normalization with provenance | 3 | **implemented** — `packages/adapter-robinhood` |
| Robinhood mainnet read adapter | Chain identity, fixed-block code/metadata/multiplier/event/oracle reads | 3 | **implemented read-only** — no transaction construction or submission |
| Mainnet replay corpus | Recorded REST/RPC state through registry and kernel, with stable digests and metrics | 3 | **implemented** — `corpus/mainnet-v1`, 11 vectors |
| Transaction construction and submission | Build and submit a transaction bound to a verified candidate | 4, 6 | not implemented |
| Candidate engine | Venue and route discovery; candidate construction with state snapshots | 4 | not implemented |
| Ranking | Ordering of admissible candidates in a common economic unit | 4 | not implemented |
| Jev adapter | Advisory selection over a closed candidate set; bounded, abstention-safe | 5 | not implemented |
| Execution gate | On-chain re-assertion of the commitment, atomic with the action | 6 | not implemented |
| Funding adapters | Stablecoin funding abstraction | 7 | not implemented |
| Receipts and audit | Structured receipt for every attempt, including refusals | 1, then 8 | **implemented** (kernel receipts); audit surfacing is Phase 8 |
| Demo and web | Public demonstration, including deliberate failure demonstrations | 8 | not implemented |

Directories are created when they hold real code.

```
packages/kernel/     the verifier and everything it needs (ADR 0003)
packages/registry/   canonical assets, representations, resolution (ADR 0004)
packages/adapter-robinhood/ strict external I/O and normalization (ADR 0008)
corpus/v1/           cross-implementation verifier decision vectors
corpus/registry-v1/  cross-implementation registry decision vectors
corpus/mainnet-v1/   recorded mainnet registry-plus-kernel replay vectors
docs/adr/            architecture decision records
```

The external adapter depends on the registry and kernel — never the reverse.
Structural tests enforce all three boundaries: the kernel imports nothing
outside itself and its two allowlisted crypto dependencies, the registry imports
nothing outside itself and the kernel, and neither imports the adapter
([ADR 0004](adr/0004-registry-package-boundary.md),
[ADR 0008](adr/0008-robinhood-data-source-authority.md)).

```
adapter   ──▶  registry  ──▶  kernel        permitted
kernel/registry  ──▶  adapter               forbidden, structurally
```

## 3. Trust levels

Every input carries a trust level, and its level bounds what it may influence.

| Level | Sources | May influence |
| --- | --- | --- |
| **Authoritative** | Signed mandate; on-chain state read at execution | Anything, including admissibility |
| **Verified** | Registry entries under change control; market state from configured providers, with provenance and freshness | Admissibility, subject to freshness checks |
| **Advisory** | Jev output; heuristic rankings | Ordering within the already-admissible set only |
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
| Is the amount within authority? | Verifier (economic checks) | Candidate engine |
| Is the state fresh enough? | Verifier (state checks) against observation times | Adapters |
| Is the corporate-action state current? | Verifier (epoch check) | Adapters |
| Is the agent authorized? | Verifier (authorization checks) | Authentication layer |
| Is the submitted transaction the verified one? | Execution gate | Off-chain code |
| Which admissible candidate is best? | Ranking, optionally Jev | Verifier — it does not rank |

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
| Encoding | MCE v1 — flat, versioned, length-explicit binary, keccak-256, reproducible in Solidity | [ADR 0002](adr/0002-canonical-mandate-encoding.md) |
| Verification | 17 independent checks, unioned and sorted, so a rejection names every violation and the verdict cannot depend on check order | [verifier-invariants.md](verifier-invariants.md) |
| Replay | Pure transition rules in the kernel; the store outside it. Reserve before signing, commit on observed settlement, release only on observed failure | [replay-semantics.md](replay-semantics.md) |
| Compatibility | 57 decision vectors as a contract any future implementation must reproduce | [corpus/v1/README.md](../corpus/v1/README.md) |

The kernel's entry point is one function:

```
verify({ mandate, authorization, candidate, trustedState, clock, expectedDomain })
    -> VerificationReceipt { decision, reasonCodes[], violations[], digests, receiptDigest }
```

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
  separate components rather than separate functions.
- **INV-5** — fail closed. This is why `UNKNOWN` is a value in the type system.
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
