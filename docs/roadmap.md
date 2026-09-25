# Roadmap

Phased engineering plan: what each phase delivers, how it is known to be done,
and what it depends on.

> **Status: Phase 5 complete.** Phase 6 and beyond are planned, not started.
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

## Phase 1 — Mandate core types and deterministic verifier ✅

**Delivered.** `packages/kernel` and `corpus/v1`. Exit criteria met; evidence
per property in [verifier-invariants.md](verifier-invariants.md).

| Delivered | Where |
| --- | --- |
| Mandate types, MVP field set | `packages/kernel/src/mandate.ts` |
| Canonical encoding and digests (MCE v1, keccak-256) | `src/encoding/`, [ADR 0002](adr/0002-canonical-mandate-encoding.md) |
| EIP-712 authorization, one scheme behind a registry | `src/authorization/`, [ADR 0001](adr/0001-mandate-authorization-architecture.md) |
| Deterministic verifier, 17 independent checks | `src/verifier/` |
| Reason-code registry, 43 codes | [reason-codes.md](reason-codes.md) |
| Receipts for PASS and REJECT | `src/receipt.ts` |
| Human-readable layer, kept separate | `src/explain.ts` |
| Replay semantics and transition rules | [replay-semantics.md](replay-semantics.md) |
| Decision-vector corpus, 57 vectors | [corpus/v1](../corpus/v1/README.md) |
| ADR format adopted | [docs/adr](adr/) |

116 tests pass; typecheck clean. Two decisions Phase 0 flagged as blocking were
resolved in ADRs before implementation began, and one field the design implied
but had not named — `maxCorporateActionAgeSeconds` — was added, because an
epoch feed is itself state that can go stale.

**Not delivered, deliberately:** a second implementation to run the corpus
against (Phase 6), an adversarial end-to-end test of Jev independence (Phase 5,
though the structural half is done), and anything about partial fills.

<details>
<summary>Original Phase 1 plan</summary>

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

**Risks:** the signature scheme and canonical encoding are unresolved and must
be decided here rather than drifted into.

</details>

---

## Phase 2 — Canonical asset and representation registry ✅

**Delivered.** `packages/registry` and `corpus/registry-v1`. Exit criteria met;
evidence per property in
[registry-semantics.md §12](registry-semantics.md#12-registry-invariants-and-their-evidence).

| Delivered | Where |
| --- | --- |
| Canonical asset identity, closed scheme vocabulary, check-digit validation | `packages/registry/src/asset-id.ts`, [ADR 0005](adr/0005-canonical-asset-identity-and-resolution.md) |
| Canonical asset records, identity separated from display | `src/asset.ts` |
| Deterministic reference resolution, four named outcomes | `src/reference.ts`, `src/asset-index.ts` |
| Representation identity, EIP-55 validated and canonicalized | `src/representation-id.ts` |
| Provenance-carrying claim sets, trust floors, conflict policy | `src/claims.ts`, [ADR 0006](adr/0006-representation-claims-and-conflict-policy.md) |
| Representation semantics vocabularies | `src/semantics.ts`, `src/representation.ts` |
| Mandate-constrained admissibility, all exclusions collected | `src/requirements.ts`, `src/evaluate.ts` |
| Deterministic snapshots and digests | `src/snapshot.ts`, `src/encoding.ts`, [ADR 0007](adr/0007-registry-snapshot-encoding-and-digest.md) |
| Kernel bridge, refusing to emit unestablished state | `src/bridge.ts` |
| Synthetic world builders and labelled dev fixtures | `src/testing/` |
| Registry reason codes, 20 codes | [registry-reason-codes.md](registry-reason-codes.md) |
| Registry decision vectors, 27 vectors | [corpus/registry-v1](../corpus/registry-v1/README.md) |
| Package boundary and purity, enforced structurally | [ADR 0004](adr/0004-registry-package-boundary.md) |

298 tests pass (118 kernel, 180 registry); typecheck clean.

Exit criteria, each met: a canonical asset resolves to its admissible
representations and every exclusion reports which constraint excluded it;
ambiguous resolution rejects rather than choosing; an unregistered contract is
never admissible, enforced structurally by evaluating identifiers rather than
caller-supplied records; and membership-is-not-equivalence is expressed in the
type system — no record type carries an equivalence or admissibility field, and a
source scan fails if one is added.

**Two things Phase 2 added that the original plan did not name.** Source conflict
policy needed its own ADR, because the obvious-looking tie-breaks are each a way
for one bad source to override curation, and because the rule that a *sub-floor*
claim must not be able to create a conflict is a security property rather than a
modelling preference. And requirements had to be split into mandate-derived and
narrowing-only halves, because the Phase 1 mandate schema is frozen and does not
carry backing, rights or jurisdiction constraints — layering those as
institutional policy that can only tighten was the only way to support them
without changing signed digests.

**Not delivered, deliberately:** any live data access, any adapter, any database,
and any routing. A second registry implementation to run the corpus against does
not exist yet either; the corpus is the mechanism, not the proof.

**Depends on:** Phase 1. **Reuse:** re-derived from the prior `registry.ts`
model, with the membership-is-not-equivalence rule preserved in the type system
([statelatch-reuse.md §6](statelatch-reuse.md#6-actions-for-later-phases)).

---

## Phase 3 — Robinhood Chain / Arbitrum market-state adapters

**Complete.** Empirical findings, exact sources and limitations are recorded in
[Robinhood integration findings](robinhood-integration.md). The implementation
is read-only and did not begin routing or execution work.

**Delivers**

- strict external adapter package with dependency direction
  `adapter → registry → kernel`;
- chain identity plus fixed-block contract, metadata, multiplier, event and
  Chainlink reads;
- raw underlying price, trading halt, volume and per-session trading
  capabilities;
- explicit Stock Token debt/exposure/rights/backing/redemption/settlement claims;
- deterministic multiplier-event corporate-action epoch authority;
- SHA-256-pinned real REST/RPC fixtures and an 11-vector registry-plus-kernel
  replay corpus;
- opt-in live capture and validation, with normal CI entirely offline.

**Exit criteria**

- real state flows through registry admissibility and kernel candidate
  verification;
- every observation carries provenance and an observation time;
- a source conflict is recorded as a conflict and fails closed, never
  reconciled;
- the verifier contains no Arbitrum-specific or Robinhood-Chain-specific
  assumption;
- findings from the investigation are documented, and
  [§18.3](mandate-design.md#183-empirical-findings-and-remaining-limits) is revised.

**Not delivered, deliberately:** route discovery, liquidity-based candidate
construction, transaction construction, any chain write, testnet execution,
stablecoin funding, Jev and web UX.

**Depends on:** Phase 2. **Resolved risk:** Robinhood exposes API action records
and ERC-8056 multiplier events/state; actions not reflected in that authority
remain unsupported rather than being forced into an epoch.

---

## Phase 4 — Execution-candidate and route engine

**Complete.** The implementation is in `packages/router`; semantics and limits
are documented in [routing.md](routing.md).

**Delivered**

- an untrusted route-provider interface and strict bounded parser;
- candidate construction committed to an explicit trusted-state snapshot
  ([§12.2](mandate-design.md#122-execution-candidates));
- the two-stage admissibility filter;
- ranking in a common economic unit
  ([§12.3](mandate-design.md#123-ranking));
- domain-separated candidate and selection-receipt commitments;
- post-ranking kernel re-verification;
- seeded simulations and six-asset mainnet candidate-set replay;
- offline CI, dependency review, credential and repository-junk gates.

**Exit criteria**

- at least two genuinely different candidates are produced for one mandate;
- candidates on different representations are never compared by raw token
  output;
- substitution cost rounds against the substitution, never in favour of it;
- adding a venue adapter requires no verifier change — the test of the
  abstraction.

All exit criteria are met. The committed 200-world run produced zero malicious
selections, zero unsafe handoffs and zero determinism or receipt-reproduction
failures. Transaction construction was not started; candidate identity will be
bound to transactions by the Phase 6 execution gate.

**Depends on:** Phase 3.

---

## Phase 5 — Jev integration for candidate selection

**Complete, with one item outstanding and labelled.** The implementation is in
`packages/jev`; semantics are in [jev-integration.md](jev-integration.md),
methodology in [jev-evaluation.md](jev-evaluation.md).

**Delivered**

- the documented TypeSafe surface recorded, and three assumptions the design
  held corrected ([jev-characterization.md](jev-characterization.md));
- a Jev client and strict response parser, with the credential confined to one
  environment variable in one module;
- closed-set projection: a twelve-field view, positional local identifiers, and
  recovery by array index only ([ADR 0012](adr/0012-jev-closed-set-authority-boundary.md));
- explicit `ABSTAIN`, four selection modes and eighteen fallback reasons, all
  resolving to the single Phase 4 deterministic baseline
  ([ADR 0013](adr/0013-jev-fallback-and-confidence-policy.md));
- cardinality handling that never truncates an admissible set;
- `JevDecisionReceipt` and a selection record binding it to the routing receipt
  and the handoff verification;
- mandatory kernel re-verification against state current at handoff;
- an adversarial stub set and a 13-scenario evaluation corpus over six recorded
  mainnet symbols, run in five modes;
- offline CI, an extended credential scanner and a documented trust boundary.

**Exit criteria**

- an adversarial Jev stub that always returns the most dangerous available
  answer produces no execution the deterministic path would not also have
  permitted — **met, and measured**: `corpus/jev-evaluation-v1` reports zero
  unsafe handoffs in all five modes, and `equivalence.test.ts` asserts the
  property across every hostile behaviour and every failure reason. This
  establishes [INV-3](mandate-design.md#16-major-invariants);
- Jev's absence or failure degrades execution quality and never safety —
  **met**: every failure path selects the deterministic candidate, and a test
  asserts a single identical selection across all of them.

**Previously outstanding, now done:** the live characterization run was
performed on 2026-09-25 once an account credential became available. Six of six
choice requests succeeded against `jev-1.13.0` at p50 94 ms and p95 250 ms,
mean usage 1592 input and 75 output tokens; the repository now holds four
schema-derived fixtures and one live one. The numbers and their sample size are
in [jev-characterization.md §3](jev-characterization.md#3-observed-behaviour).
A sample of six from one machine is a characterization, not an SLA, and neither
`timeoutMs` nor `minimumConfidence` was retuned on the strength of it.

**The honest finding on value.** Phase 4's route data is almost entirely exact
integers with a total order, and a model has nothing to add to a comparison of
integers. Over the evaluation corpus a signal-following model abstains on 9 of
11 eligible decisions. What Phase 5 demonstrates is that a model can be
attached to this pipeline in a way that cannot compromise it — the boundary,
not the advice.

**Depends on:** Phase 4. **Did not block Phase 6** — that independence is
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
| 1 | Mandate types and deterministic verifier | 0 | ✅ complete |
| 2 | Canonical asset and representation registry | 1 | ✅ complete |
| 3 | Read-only Robinhood market-state and chain adapters | 2 | ✅ complete |
| 4 | Execution-candidate and route engine | 3 | ✅ complete |
| 5 | Jev-assisted decision layer | 4 | ✅ complete (live characterization performed 2026-09-25) |
| 6 | On-chain execution gate and settlement | 4 | planned |
| 7 | Stablecoin funding adapters | 6 | planned, flexible |
| 8 | Demo product and web experience | 6 | planned |
| 9+ | Cross-chain network, broader asset classes | 8 | future |
