# Mandate

**Intent-aware execution infrastructure for AI agents transacting in tokenized
financial assets.**

> **Status: Phase 5 complete — an advisory model layer that cannot authorize.** The deterministic
> verifier, its domain types, canonical encoding, EIP-712 authorization, receipts
> and replay semantics are built and tested in `packages/kernel`. The canonical
> asset and representation registry — identifier schemes, reference resolution,
> provenance-carrying representation metadata, mandate-constrained admissibility
> and reproducible snapshots — is built and tested in `packages/registry`. A
> strict adapter in `packages/adapter-robinhood` normalizes recorded and live
> Robinhood Stock Token REST/RPC state into those unchanged decision engines.
> `packages/router` constructs bounded candidates, separates admissibility from
> quality, ranks exact costs, reverifies the winner and emits deterministic
> receipts. `packages/jev` attaches TypeSafe's Jev as an **optional advisory
> selector over an already-closed admissible set**: it may choose, abstain,
> fail, be wrong or be malicious, and it can never authorize. Transaction
> construction/submission, execution contracts, funding and the web experience
> are **not** built. The kernel, registry and router still make no network call
> of any kind. **Jev has not been characterized against a live account** — see
> [docs/jev-characterization.md](docs/jev-characterization.md); every Phase 5
> result comes from recorded fixtures, deterministic stubs and adversarial
> stubs.
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

**Model output is advisory; deterministic code decides.** Jev selects among
candidates the pipeline has already admitted. It receives a projection rather
than a candidate, returns a name that is only meaningful as a key into a local
array, and whatever it names is re-verified from scratch against current state
before handoff. A model cannot relax a constraint, add a candidate, or
authorize an execution — and this is measured, not asserted: seventeen
adversarial behaviours and every failure reason produce zero unsafe handoffs
across the evaluation corpus. See
[docs/jev-integration.md](docs/jev-integration.md).

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

Three pure decision packages and one external adapter. The kernel, registry and
router perform no I/O, read no clock, and can reach no inference client. The
adapter owns external I/O; the router consumes already-normalized trusted state.

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

**The Robinhood adapter** strictly normalizes issuer REST state and fixed-block
mainnet contract/oracle observations. Ticker never establishes identity; the
audited edge is issuer UID + validated ISIN + authoritative deployment + matching
onchain code and metadata.

**The router** limits discovery to registry representations, treats every
provider quote as untrusted, requires exact full-fill quantity and independently
established costs, verifies before ranking, and verifies the selected route a
second time before returning a handoff candidate.

| Piece | What it does |
| --- | --- |
| `packages/kernel` | Mandate types, MCE v1 canonical encoding and keccak-256 digests, EIP-712 authorization, the verifier's 17 independent checks, 43 stable reason codes, receipts, and the replay state machine |
| `packages/registry` | Canonical asset identity with check-digit-validated identifier schemes, deterministic reference resolution, provenance-carrying representation metadata with trust floors and fail-closed conflict handling, mandate-constrained admissibility with 20 registry reason codes, reproducible snapshots and digests, and synthetic world builders |
| `packages/adapter-robinhood` | Strict Robinhood assets, price, capability, corporate-action, ERC-20/ERC-8056 and Chainlink normalization; explicit live failure handling and capture tooling |
| `packages/router` | Strict provider boundary, committed routing candidates, fail-closed cost model, lexicographic BUY/SELL ranking, re-verification, selection receipts and seeded simulation |
| `packages/jev` | TypeSafe client and strict response parser, closed-set choice projection, explicit abstention, deterministic fallback across eighteen failure reasons, advisory receipts, handoff re-verification, adversarial stubs and the trader-facing summary |
| `corpus/v2` | 67 verifier decision vectors across 27 families (MCE v2) |
| `corpus/registry-v1` | 27 registry decision vectors covering resolution and admissibility |
| `corpus/mainnet-v1` | 11 recorded-mainnet registry-plus-kernel replay vectors and a machine-readable report |
| `corpus/mainnet-routing-v1` | Six hybrid recorded-mainnet candidate-set routing worlds with deterministic receipts |
| `corpus/routing-simulation-v1` | Committed 200-world safety and determinism metrics |
| `corpus/jev-evaluation-v1` | 13 advisory scenarios over six recorded symbols, run in five modes including a fully adversarial one |

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
npm run check      # 567 offline tests plus fixtures, replays, boundaries and repository safety gates
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
| [docs/robinhood-integration.md](docs/robinhood-integration.md) | Verified endpoints, schemas, issuer semantics, price/multiplier rules, timestamps and real-data limitations. |
| [docs/mainnet-replay.md](docs/mainnet-replay.md) | Recorded-mainnet replay methodology, synthetic labelling and validation report. |
| [docs/routing.md](docs/routing.md) | Candidate model, provider boundary, ranking, costs, limits and selection receipts. |
| [docs/jev-integration.md](docs/jev-integration.md) | The advisory decision layer: authority boundary, closed-set projection, abstention, fallback, confidence policy, receipts and trader-facing output. |
| [docs/jev-characterization.md](docs/jev-characterization.md) | The documented TypeSafe API surface, the characterization method, and the measured results of the live run performed on 2026-09-25. |
| [docs/jev-evaluation.md](docs/jev-evaluation.md) | Advisory evaluation methodology, the safety/quality distinction, results, and the honest finding about decision quality. |
| [docs/jev-performance.md](docs/jev-performance.md) | Local latency cost of the advisory layer, and what is deliberately not measured. |
| [docs/router-performance.md](docs/router-performance.md) | Deterministic router latency baseline and methodology. |
| [docs/security-review.md](docs/security-review.md) | Living internal threat/control review and dependency-audit status. |
| [docs/ci.md](docs/ci.md) | Offline continuous-integration and drift gates. |
| [docs/simulation.md](docs/simulation.md) | Seeded hybrid-world generation, metrics and replay methodology. |
| [docs/adr/](docs/adr/) | Architecture decision records: authorization architecture, canonical encoding, kernel language and dependency boundary. |
| [corpus/v2/README.md](corpus/v2/README.md) | Verifier decision-vector format, for reimplementers. |
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
├── packages/adapter-robinhood/ strict Robinhood REST/RPC normalization
│   ├── src/               adapters, provenance, exact price and epoch semantics
│   └── test/              recorded fixtures, offline replay and failure tests
├── corpus/v2/             cross-implementation verifier decision vectors
├── corpus/registry-v1/    cross-implementation registry decision vectors
├── corpus/mainnet-v1/     recorded mainnet replay vectors and metrics
└── docs/
    ├── mandate-design.md         canonical specification
    ├── architecture.md           system structure and component boundaries
    ├── roadmap.md                phased engineering plan
    ├── verifier-invariants.md    what the kernel guarantees, and how
    ├── registry-semantics.md     what the registry means, and what it refuses to mean
    ├── reason-codes.md           generated verifier reason-code registry
    ├── registry-reason-codes.md  generated registry reason-code registry
    ├── replay-semantics.md       consumption and nonce semantics
    ├── robinhood-integration.md  verified Phase 3 external-data findings
    ├── mainnet-replay.md         real replay methodology and limits
    ├── statelatch-reuse.md       prior-codebase reuse assessment
    └── adr/                      architecture decision records
```

Directories are created when they hold real code. The dependency direction is
`adapter → registry → kernel`, never the reverse, and structural tests enforce
it from all three packages.

## Contributing

Human and agent contributors both follow [AGENTS.md](AGENTS.md). The rules that
matter most: agents commit locally and never push, never merge, never open pull
requests, and never modify remote state; the repository owner reviews and
pushes. Each phase lands as several meaningful commits, never one large one.
