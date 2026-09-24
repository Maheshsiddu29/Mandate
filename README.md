# Mandate

**Intent-aware execution infrastructure for AI agents transacting in tokenized
financial assets.**

> **Status: Phase 0 — foundation.** This repository currently contains
> specification and engineering rules only. No component described below is
> implemented. Nothing here should be read as a claim about working software.

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

## Documentation

| Document | What it covers |
| --- | --- |
| **[docs/mandate-design.md](docs/mandate-design.md)** | **Canonical specification.** The complete Mandate design: problem, primitives, lifecycle, verification, routing, corporate actions, settlement, invariants, threat model, scope and roadmap. Start here. |
| [docs/architecture.md](docs/architecture.md) | System structure, components and their boundaries, data flow, and where each concern is enforced. |
| [docs/roadmap.md](docs/roadmap.md) | Phased engineering plan, what each phase delivers, and its exit criteria. |
| [docs/statelatch-reuse.md](docs/statelatch-reuse.md) | Assessment of the prior StateLatch / EquityGuard codebase: what is reusable, what must be rebuilt, and what must not be carried over. |
| [AGENTS.md](AGENTS.md) | Operating rules for coding agents working in this repository. Read before making any change. |

Other documents summarize; `docs/mandate-design.md` is the source of truth and
is where a disagreement gets resolved.

## Scope

**Buildathon MVP** — a narrow, production-quality vertical slice on tokenized
equities over Robinhood Chain / Arbitrum-compatible infrastructure: a
machine-readable mandate, canonical asset and representation registry,
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
├── AGENTS.md      operating rules for coding agents
├── README.md      this file
└── docs/
    ├── mandate-design.md     canonical specification
    ├── architecture.md       system structure and component boundaries
    ├── roadmap.md            phased engineering plan
    └── statelatch-reuse.md   prior-codebase reuse assessment
```

Directories are created when they hold real code. Phase 0 adds none.

## Contributing

Human and agent contributors both follow [AGENTS.md](AGENTS.md). The rules that
matter most: agents commit locally and never push, never merge, never open pull
requests, and never modify remote state; the repository owner reviews and
pushes. Each phase lands as several meaningful commits, never one large one.
