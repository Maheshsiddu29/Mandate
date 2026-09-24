# Roadmap

Phased engineering plan: what each phase delivers, how it is known to be done,
and what it depends on.

> **Status: Phase 0 complete.** Phases 1 and beyond are planned, not started.
> Rationale for the phase ordering is in
> [mandate-design.md §25](mandate-design.md#25-phased-engineering-roadmap);
> scope boundaries are in
> [§20](mandate-design.md#20-buildathon-mvp-scope) and
> [§21](mandate-design.md#21-explicit-non-goals-for-the-mvp).

## Ordering principle

**Build the gate before the thing it gates.**

The deterministic verifier comes first. Everything else is defined by what the
verifier requires, and a routing engine built before its constraints exist will
encode the wrong shape. The cost of reordering is not a delay — it is a
rewrite.

## Rules that apply to every phase

Enforced by [AGENTS.md](../AGENTS.md):

- **Multiple meaningful commits per phase.** Never one giant commit; never fake
  granularity from meaningless one-line commits.
- **Failure modes are tested.** In this system the rejections are the product.
  A check without a test that produces its rejection is not done.
- **Docs change in the same commit as the code they describe.**
- **Phase report, then human approval, before the next phase begins.**
- **No phase weakens an invariant.** Changing one is a product decision, made
  in [mandate-design.md §16](mandate-design.md#16-major-invariants) first.

---

## Phase 0 — Foundation ✅

**Delivered.** Product thesis, system boundaries, architecture, core domain
model, engineering rules, threat-model enumeration, MVP scope with explicit
non-goals, StateLatch reuse assessment, and this roadmap.

**Exit criterion met:** a stable reference specification exists that later
phases can be reviewed against. No implementation.

---

## Phase 1 — Mandate core types and deterministic verifier

The most important phase. The verifier is the component with the least room for
later change, because everything else is shaped by it.

**Delivers**

- mandate type definitions with the MVP field set
  ([§7.3](mandate-design.md#73-mvp-mandate-versus-long-term-mandate));
- canonical encoding, digest, and signature verification;
- the deterministic verifier: `verify(mandate, candidate, state, clock)`;
- the reason-code registry with data-driven explanations;
- the receipt model, including receipts for refusals;
- the differential decision-vector corpus, established from the start;
- ADR format adopted.

**Exit criteria**

- every enumerated unsafe condition in
  [§10.2](mandate-design.md#102-check-families) is rejected with a stable
  reason code;
- a failure-mode test exists per reason code;
- the verifier is pure, total, fail-closed and model-free, checked
  structurally — its dependency graph contains no inference client, no network
  client and no clock;
- a rejection names every violated constraint, not just the first;
- a verdict is reproducible from its receipt alone.

**Depends on:** nothing. **Blocks:** everything.

**Risks:** the signature scheme and canonical encoding are unresolved
([§7.5](mandate-design.md#75-open-questions)) and must be decided here rather
than drifted into.

---

## Phase 2 — Canonical asset and representation registry

**Delivers**

- canonical asset identity and its identifier scheme
  ([§5.2](mandate-design.md#52-canonical-asset-identity));
- the representation registry with metadata, provenance and as-of times
  ([§6.2](mandate-design.md#62-metadata-dimensions));
- resolution: human reference → canonical asset → admissible representations;
- per-representation exclusion reasons.

**Exit criteria**

- a canonical asset resolves to its admissible representations, and each
  exclusion reports *which constraint* excluded it;
- ambiguous resolution rejects rather than choosing
  ([§9.4](mandate-design.md#94-resolution-failure-is-a-normal-outcome));
- an unregistered contract is `UNKNOWN` and never admissible;
- the membership-is-not-equivalence rule is expressed in the type system, not
  only in a comment.

**Depends on:** Phase 1. **Reuse:** re-derive from the prior `registry.ts`
model ([statelatch-reuse.md §6](statelatch-reuse.md#6-actions-for-later-phases)).

---

## Phase 3 — Robinhood Chain / Arbitrum market-state adapters

**Begins with empirical investigation, not code.** What is actually available
in this environment is not yet known
([§18.3](mandate-design.md#183-what-is-not-yet-known)), and the answers may
change the corporate-action mechanism.

**Delivers**

- chain adapter: chain identity by chain ID, reads, transaction construction;
- market-state adapter: price, liquidity, venue quotes;
- operational-state adapter: pause and transfer restrictions;
- corporate-action state source, in whatever form proves available;
- state normalization with `UNKNOWN` as a value and conflicts failing closed.

**Exit criteria**

- real state flows into candidate construction;
- every observation carries provenance and an observation time;
- a source conflict is recorded as a conflict and fails closed, never
  reconciled;
- the verifier contains no Arbitrum-specific or Robinhood-Chain-specific
  assumption;
- findings from the investigation are documented, and
  [§18.3](mandate-design.md#183-what-is-not-yet-known) is revised.

**Depends on:** Phase 2. **Risk:** corporate-action state may not be available
on-chain, which affects MVP capability 4 and failure demonstration 5.

---

## Phase 4 — Execution-candidate and route engine

**Delivers**

- venue adapters behind a common interface;
- candidate construction with self-contained state snapshots
  ([§12.2](mandate-design.md#122-execution-candidates));
- the two-stage admissibility filter;
- ranking in a common economic unit
  ([§12.3](mandate-design.md#123-ranking));
- commitment construction binding a candidate to a transaction.

**Exit criteria**

- at least two genuinely different candidates are produced for one mandate;
- candidates on different representations are never compared by raw token
  output;
- substitution cost rounds against the substitution, never in favour of it;
- adding a venue adapter requires no verifier change — the test of the
  abstraction.

**Depends on:** Phase 3.

---

## Phase 5 — Jev integration for candidate classification

**Begins with characterization, not integration.** Jev's API, latency profile
and cost are not yet established
([§11.5](mandate-design.md#115-open-questions)).

**Delivers**

- Jev adapter: closed candidate set in, index or abstention out;
- timeout and budget bounds, with exceeding either treated as abstention;
- deterministic ranking fallback;
- Jev inputs, outputs, model identity and version in the receipt.

**Exit criteria**

- an adversarial Jev stub that always returns the most dangerous available
  answer produces no execution the deterministic path would not also have
  permitted — this establishes
  [INV-3](mandate-design.md#16-major-invariants);
- Jev's absence or failure degrades execution quality and never safety.

**Depends on:** Phase 4. **Does not block Phase 6** — that independence is
INV-3 expressed as a scheduling property.

---

## Phase 6 — On-chain execution gate and settlement

**Delivers**

- the on-chain gate: commitment re-assertion, atomic with the action
  ([§14.3](mandate-design.md#143-the-execution-gate));
- self-position checking, so ordering is not left to the transaction builder;
- nonce consumption for replay protection;
- submission, result observation, and receipt completion;
- the deliberate failure demonstrations
  ([§20.3](mandate-design.md#203-the-failure-demonstrations)).

**Exit criteria**

- a verified execution lands on testnet;
- a transaction mutated after verification is rejected by the gate;
- the gate is read-only and side-effect free;
- all failure demonstrations produce their expected reason codes;
- the off-chain verifier and the on-chain gate agree on the shared
  decision-vector corpus
  ([§10.5](mandate-design.md#105-differential-verification));
- what was demonstrated is stated precisely, with no overclaiming.

**Depends on:** Phase 4. **Reuse:** re-derive the gate's ideas for EVM; do not
port the prior Solana program
([statelatch-reuse.md §5](statelatch-reuse.md#5-where-reuse-saves-the-most-time)).

---

## Phase 7 — Stablecoin funding and routing adapters

**Delivers** funding-asset modelling with the same representation care given
to assets, funding-route discovery, and conversion costs folded into execution
economics so the deviation bound covers the whole path
([§19](mandate-design.md#19-stablecoin-funding-as-a-supporting-layer)).

**Exit criterion:** a fiat-denominated intent executes without the mandate
naming a funding asset.

**Depends on:** Phase 6. **Position is flexible** — it is a supporting layer,
scheduled when funding becomes the blocker.

---

## Phase 8 — Demo product and web experience

**Delivers** the public demonstration and the site, reusing the prior project's
design system and scaffolding
([statelatch-reuse.md §3.4](statelatch-reuse.md#34-web-design-and-demo)):
token system and typography lifted and re-paletted, route shell and diagram
components ported, refusal-first demo structure ported.

**Exit criteria**

- the demo shows PASS and, prominently, REJECT with visible reasons;
- live data and engineered data are visibly separated with the seam disclosed;
- no prior naming, palette prefix or imported metric survives;
- every claim on the site is true of what was built.

**Depends on:** Phase 6.

---

## Phase 9+ — Cross-chain network and broader asset classes

Out of buildathon scope. Direction is recorded in
[§22](mandate-design.md#22-future-architecture) and
[§23](mandate-design.md#23-expansion-beyond-equities), constraining today's
abstractions so these become additions rather than rewrites.

The one structural commitment carried into every future phase: **the verifier
remains the sole authorization authority.** Any capability that would let
something else permit an execution is a change to the product, and belongs in
the design document before it belongs in code.

---

## Summary

| Phase | Deliverable | Depends on | Status |
| --- | --- | --- | --- |
| 0 | Foundation: thesis, architecture, rules, scope, reuse assessment | — | ✅ complete |
| 1 | Mandate types and deterministic verifier | 0 | planned |
| 2 | Canonical asset and representation registry | 1 | planned |
| 3 | Market-state and chain adapters | 2 | planned |
| 4 | Execution-candidate and route engine | 3 | planned |
| 5 | Jev integration | 4 | planned, non-blocking |
| 6 | On-chain execution gate and settlement | 4 | planned |
| 7 | Stablecoin funding adapters | 6 | planned, flexible |
| 8 | Demo product and web experience | 6 | planned |
| 9+ | Cross-chain network, broader asset classes | 8 | future |
