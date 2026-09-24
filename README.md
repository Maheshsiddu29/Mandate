# Mandate

**Intent-aware execution infrastructure for AI agents transacting in tokenized
financial assets.**

> **Status: Phase 2 complete — the kernel and the registry.** The deterministic
> verifier, its domain types, canonical encoding, EIP-712 authorization, receipts
> and replay semantics are built and tested in `packages/kernel`. The canonical
> asset and representation registry — identifier schemes, reference resolution,
> provenance-carrying representation metadata, mandate-constrained admissibility
> and reproducible snapshots — is built and tested in `packages/registry`.
> Routing, chain adapters, live market data, Jev, execution contracts and the web
> experience are **not** built, and the registry makes no network call of any kind.
> Nothing below should be read as a claim beyond that boundary.

---

## The problem

An AI agent with spending authority and a swap tool will produce transactions
that are mechanically valid and financially wrong. The chain confirms them; a
block explorer calls them successes. Each of these is one:

- buying a token whose ticker matches `NVDA` but which is an unrelated deployment;
- buying synthetic exposure when the principal required a backed instrument;
- buying from an issuer an institution has not approved;
- executing against a quote taken before a 4:1 split;
- executing while the underlying is halted;
- routing to an address supplied by a prompt injection.

Slippage tolerance catches none of them. Slippage protects a token-amount
expectation. These are failures of financial identity, instrument semantics,
authorization scope, and state freshness.

## The approach

Mandate replaces the routing decomposition used today:

```
token address  ->  swap
```

with one that separates financial intent from blockchain mechanics:

```
financial intent  ->  valid representation  ->  valid route  ->  verified execution
```

Three ideas carry the design.

**A canonical asset is not a token.** `NASDAQ:NVDA` is a financial identity.
An ERC-20 on some chain from some issuer is a *representation* of it.
Representations of the same underlying differ in backing, redemption,
shareholder rights, corporate-action handling and jurisdiction. Mandate treats
"same underlying" and "economically equivalent" as separate claims and never
converts one into the other silently.

**A mandate is a bounded authorization, not a prompt.** A human or institution
signs a machine-readable authorization — asset, side, maximum notional,
approved issuers, whether synthetic exposure is allowed, tolerable execution
deviation, required corporate-action freshness, expiry. The agent operates
inside it. A valid agent signature proves who asked; it does not prove the
action was permitted.

**Model output is advisory; deterministic code decides.** Jev may classify,
rank or select among candidates. Whatever it returns is then re-checked from
scratch by a deterministic verifier with final authority. A model cannot relax
a constraint, add a candidate, or authorize an execution.

## What Mandate optimizes

Crypto routers maximize token output. Mandate optimizes execution quality
**subject to** canonical asset identity, representation semantics, issuer
restrictions, backing requirements, economic rights, jurisdiction, portfolio
policy, price limits, execution deviation, liquidity, trading status,
corporate-action state, user authorization, agent authority, mandate expiry and
replay protection.

The constraint set is the product. Optimization happens only over candidates
that already satisfy it — a candidate that violates a constraint is not a worse
candidate, it is not a candidate.

## What exists today

Two pure packages. Neither performs I/O, reads a clock, or can reach an inference
client — all three are enforced by tests that read the sources and the dependency
tree, not by convention.

**The verifier** decides whether one proposed execution is inside one signed
authorization:

```
verify({ mandate, authorization, candidate, trustedState, clock, expectedDomain })
    -> { decision: PASS | REJECT, reasonCodes[], violations[], digests, receiptDigest }
```

**The registry** decides what financial asset a human meant, and which tokenized
representations may legitimately be considered for it:

```
resolve(registry, "NVDA")                 -> RESOLVED | AMBIGUOUS | UNKNOWN | INVALID
listRepresentations(registry, assetId)     -> representations issued against it
evaluateRepresentation(registry, req, id)  -> ADMISSIBLE | EXCLUDED + reasonCodes[]
```

| Piece | What it does |
| --- | --- |
| `packages/kernel` | Mandate types, MCE v1 canonical encoding and keccak-256 digests, EIP-712 authorization, the verifier's 17 independent checks, 43 stable reason codes, receipts, and the replay state machine |
| `packages/registry` | Canonical asset identity with check-digit-validated identifier schemes, deterministic reference resolution, provenance-carrying representation metadata with trust floors and fail-closed conflict handling, mandate-constrained admissibility with 20 registry reason codes, reproducible snapshots and digests, and synthetic world builders |
| `corpus/v1` | 57 verifier decision vectors across 24 families |
| `corpus/registry-v1` | 27 registry decision vectors covering resolution and admissibility |

Three properties hold across both. A refusal names **every** violated constraint,
not the first. No verdict depends on the order checks ran in. And `UNKNOWN` is a
value that rejects — unknown metadata, a conflict between data sources, an
unregistered contract and an ambiguous ticker are all refusals, not defaults.

The registry asserts the weakest useful claim: *this token is issued against that
underlying*. It never asserts that two representations of one underlying are
equivalent, interchangeable or equally safe. Whether one may satisfy a given
mandate is computed against that mandate and is not stored anywhere.

```bash
npm install
npm run check      # typecheck + 298 tests
```

## Documentation

| Document | What it covers |
| --- | --- |
| **[docs/mandate-design.md](docs/mandate-design.md)** | **Canonical specification.** The complete Mandate design: problem, primitives, lifecycle, verification, routing, corporate actions, settlement, invariants, threat model, scope and roadmap. Start here. |
| [docs/architecture.md](docs/architecture.md) | System structure, components and their boundaries, data flow, and where each concern is enforced. |
| [docs/roadmap.md](docs/roadmap.md) | Phased engineering plan, what each phase delivers, and its exit criteria. |
| [docs/statelatch-reuse.md](docs/statelatch-reuse.md) | Assessment of the prior StateLatch / EquityGuard codebase: what is reusable, what must be rebuilt, and what must not be carried over. |
| [docs/verifier-invariants.md](docs/verifier-invariants.md) | What the kernel guarantees today, how each guarantee is established, and what it explicitly does not guarantee. |
| [docs/registry-semantics.md](docs/registry-semantics.md) | Canonical asset identity, the representation model, registry trust and provenance, resolution and ambiguity, admissibility, snapshots — and what the registry explicitly does not guarantee. |
| [docs/reason-codes.md](docs/reason-codes.md) | The 43 stable verifier reason codes. Generated from the registry, so it cannot drift. |
| [docs/registry-reason-codes.md](docs/registry-reason-codes.md) | The 20 registry reason codes, and the kernel codes registry decisions reuse. Generated. |
| [docs/replay-semantics.md](docs/replay-semantics.md) | How a mandate is consumed, and the one obligation the kernel cannot enforce for an integrator. |
| [docs/adr/](docs/adr/) | Architecture decision records: authorization architecture, canonical encoding, kernel language and dependency boundary. |
| [corpus/v1/README.md](corpus/v1/README.md) | Verifier decision-vector format, for reimplementers. |
| [corpus/registry-v1/README.md](corpus/registry-v1/README.md) | Registry decision-vector format, and exactly which fixture data is real and which is synthetic. |
| [AGENTS.md](AGENTS.md) | Operating rules for coding agents working in this repository. Read before making any change. |

Other documents summarize; `docs/mandate-design.md` is the source of truth and
is where a disagreement gets resolved.

## Scope

**Buildathon MVP** — a narrow, production-quality vertical slice on tokenized
equities over Robinhood Chain / Arbitrum-compatible infrastructure: a
machine-readable mandate, a canonical asset and representation registry,
representation metadata, market-state integration, multiple execution
candidates, optional Jev-assisted selection, deterministic verification with
stable PASS/REJECT reason codes, an execution gate, and deliberate failure
demonstrations.

**Not in the MVP** — cross-chain routing, multi-issuer breadth, portfolio
mandates, delegated institutional policy, settlement abstraction, agent
identity infrastructure, automated reauthorization, and asset classes beyond
equities. These are described in the design document as future architecture and
are not claimed as built.

See [MVP scope](docs/mandate-design.md#20-buildathon-mvp-scope) and
[explicit non-goals](docs/mandate-design.md#21-explicit-non-goals-for-the-mvp).

## Repository layout

```
.
├── AGENTS.md              operating rules for coding agents
├── README.md              this file
├── packages/kernel/       the verifier and everything it needs
│   ├── src/               domain types, encoding, authorization, verifier
│   └── test/              118 tests: behaviour, boundaries, properties, structure
├── packages/registry/     canonical assets, representations, resolution
│   ├── src/               identity, claims, semantics, admissibility, snapshots
│   │   └── testing/       synthetic world builders and labelled dev fixtures
│   └── test/              180 tests: behaviour, adversarial properties, structure
├── corpus/v1/             cross-implementation verifier decision vectors
├── corpus/registry-v1/    cross-implementation registry decision vectors
└── docs/
    ├── mandate-design.md         canonical specification
    ├── architecture.md           system structure and component boundaries
    ├── roadmap.md                phased engineering plan
    ├── verifier-invariants.md    what the kernel guarantees, and how
    ├── registry-semantics.md     what the registry means, and what it refuses to mean
    ├── reason-codes.md           generated verifier reason-code registry
    ├── registry-reason-codes.md  generated registry reason-code registry
    ├── replay-semantics.md       consumption and nonce semantics
    ├── statelatch-reuse.md       prior-codebase reuse assessment
    └── adr/                      architecture decision records
```

Directories are created when they hold real code. The dependency direction is
`registry → kernel`, never the reverse, and structural tests enforce it from both
sides. Later phases add adapters and chain clients the same way.

## Contributing

Human and agent contributors both follow [AGENTS.md](AGENTS.md). The rules that
matter most: agents commit locally and never push, never merge, never open pull
requests, and never modify remote state; the repository owner reviews and
pushes. Each phase lands as several meaningful commits, never one large one.
