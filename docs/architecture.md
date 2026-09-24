# Architecture

System structure, component boundaries, and where each concern is enforced.

> **Status: Phase 0.** No component below is implemented. The "Phase" column
> records when a component is planned to land; see [roadmap.md](roadmap.md).
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
| Mandate types | The authorization object: schema, canonical encoding, digest, signature | 1 | not implemented |
| Deterministic verifier | `verify(mandate, candidate, state, clock) -> Verdict`. Pure, total, fail-closed, model-free | 1 | not implemented |
| Reason-code registry | Stable namespaced codes with data-driven explanations | 1 | not implemented |
| Canonical asset registry | Canonical identities and their external identifier schemes | 2 | not implemented |
| Representation registry | Tokenized representations, their metadata and provenance | 2 | not implemented |
| Resolution | Human reference → canonical asset → admissible representations | 2 | not implemented |
| Market-state adapters | Price, liquidity, quotes, operational and corporate-action state, with provenance | 3 | not implemented |
| Chain adapters | Chain identity, reads, transaction construction and submission | 3 | not implemented |
| Candidate engine | Venue and route discovery; candidate construction with state snapshots | 4 | not implemented |
| Ranking | Ordering of admissible candidates in a common economic unit | 4 | not implemented |
| Jev adapter | Advisory selection over a closed candidate set; bounded, abstention-safe | 5 | not implemented |
| Execution gate | On-chain re-assertion of the commitment, atomic with the action | 6 | not implemented |
| Funding adapters | Stablecoin funding abstraction | 7 | not implemented |
| Receipts and audit | Structured receipt for every attempt, including refusals | 1, then 8 | not implemented |
| Demo and web | Public demonstration, including deliberate failure demonstrations | 8 | not implemented |

Directories are created when they hold real code. Phase 0 adds none.

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
| Is this representation acceptable? | Verifier (semantics checks) against registry metadata | Discovery, ranking |
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

## 6. Key decisions and their rationale

| Decision | Rationale | Detail |
| --- | --- | --- |
| Canonical asset identity separate from token identity | Representations of one underlying are not equivalent instruments | [§5](mandate-design.md#5-canonical-assets-and-token-representations) |
| Registry asserts only "issued against the same underlying" | Any stronger claim would be false and the system would be built on it | [§5.4](mandate-design.md#54-why-same-underlying-is-deliberately-weak) |
| Verifier is pure and total | Testability, auditability, reduced attack surface, portability | [§10.4](mandate-design.md#104-why-the-verifier-does-no-io) |
| Jev returns an index into a closed set | Returning an object is an opportunity to return a modified one | [§11.4](mandate-design.md#114-the-integration-surface) |
| Admissibility filtered before ranking, then re-verified after | Ranking and model selection sit between the filter and execution | [§12.1](mandate-design.md#121-admissibility-before-quality) |
| Corporate-action epoch rather than event-list comparison | Cheap integer check, on-chain expressible, asset-class agnostic | [§13.4](mandate-design.md#134-corporate-action-epoch) |
| On-chain gate binds the verified action | Off-chain PASS does not bind what is submitted | [§14.3](mandate-design.md#143-the-execution-gate) |
| Mandates carry no contract addresses | A compromised authoring path could otherwise redirect funds with a valid mandate | [§7.4](mandate-design.md#74-design-rules-for-the-mandate-schema) |
| Mandates carry no free text | A verifier must never interpret prose | [§7.4](mandate-design.md#74-design-rules-for-the-mandate-schema) |

## 7. Invariants

Eighteen invariants define the system and are listed with their enforcement
points in [mandate-design.md §16](mandate-design.md#16-major-invariants). The
four that shape the architecture most:

- **INV-3** — the permitted-execution set is identical whether Jev is present,
  absent, failed or adversarial. This is why selection and verification are
  separate components rather than separate functions.
- **INV-5** — fail closed. This is why `UNKNOWN` is a value in the type system.
- **INV-7** — execution addresses come only from the registry. This is why
  resolution is a distinct stage that the agent cannot bypass.
- **INV-13** — the transaction submitted is the transaction verified. This is
  why an on-chain gate exists at all.

## 8. Threat model

Enumerated and assigned to components in
[mandate-design.md §17](mandate-design.md#17-threat-model-overview), including
an honest statement of what the design does not address. Phase 0 solves
nothing; it assigns each risk to the component and phase that must handle it.
