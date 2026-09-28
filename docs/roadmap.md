# Roadmap

Phased engineering plan: what each phase delivers, how it is known to be done,
and what it depends on.

> **Status: Phase 6 is FROZEN at `dc98df5`. Phase 7A — the Mandate Core v1
> specification ([core-v1/](core-v1/README.md)) — is FROZEN after its hardening
> checkpoint. Phase 7B — Core types, canonical encodings and the generic
> action/state model ([implementation-7b.md](core-v1/implementation-7b.md)),
> with its 7B.1 hardening — is FROZEN. Phase 7C — the authority graph and
> global authority ledger ([implementation-7c.md](core-v1/implementation-7c.md))
> — is FROZEN. Phase 7D — the invariant and reservation engine
> ([implementation-7d.md](core-v1/implementation-7d.md)), with its 7D.1
> semantic hardening, 7D.2 historical semantic provenance and 7D.3 immutable
> authority semantics — is FROZEN.
> Phase 7E is NEXT and not started.** No production domain module,
> venue integration, observation reconciliation or later Phase 7 mechanism
> exists, and nothing has been deployed.
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

**Delivered.** `packages/kernel` and `corpus/v2` (reissued at MCE v2 in Phase 5R). Exit criteria met; evidence
per property in [verifier-invariants.md](verifier-invariants.md).

| Delivered | Where |
| --- | --- |
| Mandate types, MVP field set | `packages/kernel/src/mandate.ts` |
| Canonical encoding and digests (MCE v1, keccak-256; reissued as v2 in Phase 5R, candidate v3 in 5R.1) | `src/encoding/`, [ADR 0002](adr/0002-canonical-mandate-encoding.md), [ADR 0017](adr/0017-layered-candidate-state-commitments.md) |
| EIP-712 authorization, one scheme behind a registry | `src/authorization/`, [ADR 0001](adr/0001-mandate-authorization-architecture.md) |
| Deterministic verifier, 19 independent checks as of Phase 5R.1 | `src/verifier/` |
| Reason-code registry, 43 codes | [reason-codes.md](reason-codes.md) |
| Receipts for PASS and REJECT | `src/receipt.ts` |
| Human-readable layer, kept separate | `src/explain.ts` |
| Replay semantics and transition rules | [replay-semantics.md](replay-semantics.md) |
| Decision-vector corpus, 67 vectors | [corpus/v2](../corpus/v2/README.md) |
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

## Phase 5R through 5R.3 — adversarial review and remediation ✅

Not a feature phase. Two rounds of adversarial review of everything Phases 1–5
built, applied before the Solidity execution structure freezes the protocol.

**5R** remediated the
[production architecture pressure test](production-architecture-pressure-test.md)
(findings F-1…F-16): symmetric signed economic authorization
([ADR 0014](adr/0014-symmetric-signed-economic-authorization.md)), replay
quarantine ([ADR 0015](adr/0015-replay-quarantine-and-reconciliation.md)),
mandatory fresh handoff state with monotonic pipeline time
([ADR 0016](adr/0016-pipeline-time-and-handoff-freshness.md)), bounds on every
counted collection, response-size limits on both network clients, and
multi-representation adversarial worlds.

**5R.1** remediated an independent audit *of that remediation* (findings
N-1…N-10). Seven of the ten were places where a 5R fix was incomplete,
over-applied, or described a property the code did not enforce. The one that
mattered: 5R had bound a candidate to the digest of the entire trusted state,
which made the fresh handoff re-verification 5R had just introduced impossible to
pass. Candidate commitments are now layered by the kind of fact each carries
([ADR 0017](adr/0017-layered-candidate-state-commitments.md)), and every replay
resolution requires a validated observed outcome
([ADR 0018](adr/0018-observed-execution-outcomes.md)).

**5R.2** strictly validates stored replay records and the local temporal
consistency of reconciliation evidence, and totalizes the four outer request
APIs named by that audit.

**5R.3** closes the remaining exported selection boundaries, validates Jev's
top-level request before field access, enforces registry `i64` timestamp and
`u16` eligibility-list domains before encoding, and adds the explicit
[public trust-boundary inventory](public-trust-boundaries.md) plus a shared
hostile-value regression matrix. Phase 6 remains unopened.

**Exit criterion:** every finding either closed or explicitly assigned to a later
phase, with each closure pinned by a test that fails if the defect returns. The
full ledger is [§24 of the pressure test](production-architecture-pressure-test.md).

**Depends on:** Phase 5. **Blocks Phase 6** — deliberately, because an on-chain
gate re-asserts commitments, and freezing the wrong commitment structure in
Solidity is the expensive mistake.

---

## Phase 6 — On-chain execution gate and settlement — FROZEN ✓

**Frozen at `dc98df5` by the repository owner (2026-09-27).** MCE v2, Candidate
V3, `MandateCodec`, `MandateExecutionGate`, `GateArithmetic`, the fixture
execution semantics, the replay and reservation semantics and every canonical
vector are not modified by any later phase. Phase 7 builds above and alongside
Phase 6, treating the gate as the enforcement point of one adapter
([core-v1/architecture.md §7](core-v1/architecture.md#7-relationship-to-frozen-phase-6)).
The status lines below record each sub-phase as its report stated it at the
time; they are history and are not rewritten.

**Phase 6R.1b implemented and tested locally; not deployed; awaiting independent review** ([report](phase-6r1b-report.md)).
**Phase 6R.2A measured where the gate's gas goes and recommends the 6R.2B path; it changed no production code** ([report](phase-6r2a-gas-profile.md)).
**Phase 6R.2B implemented that path — word-level (SWAR) identifier validation and ordering and a single-buffer encoder — with no semantic change: normal BUY 401,684 → 246,963 execution gas, worst case 6,724,561 → 425,922; awaiting independent security and gas review** ([report](phase-6r2b-report.md)). Semantics,
threat model and residual risks are in [execution-gate.md](execution-gate.md);
the decision is [ADR 0019](adr/0019-onchain-execution-gate.md).

**Delivered**

- `MandateExecutionGate`: an immutable executor gate that re-encodes MCE v2 and
  Candidate V3, verifies the principal's existing `MandateAuthorization` and the
  agent's `ExecutionAuthorization` under the ADR 0001 domain, enforces chain time,
  consumes the mandate digest atomically, binds candidate, mandate and pinned
  market facts, and settles on the principal's measured balance deltas;
- Phase 6R independently enforces immutable fixture price, quantity × price
  notional, signed `maxNotional`, declared side-specific economics and exact
  quantity; Phase 6R.1 makes `maxNotional` bound the true quantity × price at
  the principal's precision in the kernel and the gate (M-1), proves each
  fixture venue settles at the pinned price, and fails a mandate in
  reconciliation only once it has expired
  ([report](phase-6r1-report.md)); Phase 6R.1a fails an execution attempt once
  the reservation that bounds every attempt's deadline has passed, keeping
  mandate expiry a separate basis, and makes the gate create each fixture
  market's venue and adapter itself, with that wiring checkable after deployment
  (gate provenance itself is not yet verified)
  ([report](phase-6r1a-report.md)); it rejects all `REAL_MARKET` configurations pending authenticated
  inclusion-time state;
- one supported execution path against a **labelled settlement fixture** — the
  repository evidences no executable Robinhood venue (§5 of the gate document);
- `@mandate/execution-gate`: wire form, execution commitment, a reference model
  of the gate built on the kernel's decoder and signature rule, and the rule that
  turns confirmed chain evidence into the kernel's `ExecutionObservation`;
- `corpus/gate-v1` and a TypeScript ↔ Solidity differential harness over it;
- Foundry unit, adversarial, fuzz and stateful invariant suites, forge-lint and
  Slither in CI, and a deterministic, mainnet-refusing deployment script.

**Exit criteria, as the original plan stated them**

| Criterion | Result |
| --- | --- |
| A verified execution lands on testnet | **Not done — not authorized in this phase**, and no testnet venue is evidenced. Local execution against the fixture is tested |
| A transaction mutated after verification is rejected by the gate | **Met** — every committed field, by vector, fuzz and invariant |
| The gate is read-only and side-effect free | **Superseded** by ADR 0019: the EVM cannot bind an action it does not perform, so the gate is the executor; the protected property — nothing unverified settles — holds |
| All failure demonstrations produce their expected codes | **Met for the gate's own refusals** (demonstration 10); 1–9 remain kernel refusals |
| The offchain verifier and onchain gate agree on a shared corpus | **Met** — 240 attempts, 139 mandate and 188 candidate encodings, including 16 actual-kernel malicious-agent rejects |
| What was demonstrated is stated precisely | See execution-gate.md §5 and §16 |

**Not delivered, deliberately:** deployment of any kind, a real venue adapter,
onchain re-assertion of real-market price, halt, multiplier, epoch or registry snapshot, a persistent replay
store, and funding (Phase 7).

**Depends on:** Phase 5R.3.

---

## Phase 7 — Mandate Core

Phase 7 builds the domain-independent economic control layer specified in
[core-v1/](core-v1/README.md): authority graphs, a global authority ledger,
typed actions and state, reservations and reconciliation, enforcement adapters
and receipts. It does not implement another trading-specific policy engine and
does not modify Phase 6. Each sub-phase ends with a report and an approval gate.

### Phase 7A — Mandate Core v1 specification — FROZEN ✓

**Delivers** the specification in [core-v1/](core-v1/README.md): architecture
and the core equation, the authority and delegation model, action, state,
quantity and invariant envelopes, global authority ledger semantics,
reservations and reconciliation, the enforcement-adapter contract, receipts,
security invariants and worked examples, with frozen decisions, open questions
and deferred features listed.

**Exit criterion:** the specification is reviewed, each open question is
assigned to a phase, and no design-review question has an unclear answer. No
code.

**Hardening checkpoint (met).** Review accepted the architecture and asked for
five semantic gaps to be closed before 7B encodes the model. All five are
closed and frozen in [core-v1/README.md](core-v1/README.md#decisions-frozen),
decisions 23–28:

- ledger linearizability versus external-state consistency (CORE-CONC-1, state
  bindings, issue-time revalidation);
- principal-global invariants across roots (the principal policy);
- the granted / reserved / consumed / restored / available vocabulary;
- domain-module semantic version binding (DOM-2);
- conservative, asymmetric drift correction.

The remaining open questions are implementation choices assigned to 7B–7H.

**Depends on:** Phase 6 (frozen).

### Phase 7B — Core types and generic action/state model — FROZEN ✓

**Delivers** a Core package with canonical encodings and strict parsers for
grants, intents, snapshots and quantities; typed economic quantities; the
authority meet; `ModuleRef`, `StateBinding`, `PrincipalPolicy` and the
authority vocabulary as types; the domain module interface. No ledger.
**Exit:** UNIT-1 and AUTH-2 established by property tests; encodings pinned by
a corpus; Phase 6 generated artifacts byte-identical.

**As built** ([implementation-7b.md](core-v1/implementation-7b.md),
[ADR 0020](adr/0020-mandate-core-package-and-encoding.md)): `packages/core`
with every Core object above as a validated, canonically encoded,
domain-separated type; UNIT-1 established for Core arithmetic by type-level
and runtime tests; encodings pinned by `corpus/core-v1`; Phase 6 artifacts
byte-identical. By the Phase 7B brief, **the authority meet, AUTH-2 and the
domain module interface were not built** (no subset or later-phase logic).
Phase 7B.1 (representation hardening) bound `StateEnvelope` to a full
`ModuleRef`, required fill evidence for execution-priced committed notional,
and assigned the deferred items: the meet and AUTH-2 to 7C, the executable
`DomainModule` interface to 7D.

### Phase 7C — Authority Graph + Global Authority Ledger — FROZEN ✓

**Delivers** the authority graph: the authority meet and effective-lineage
computation (child ⊆ parent at registration and at every action), with AUTH-2
subset and property testing; and the ledger: pure ledger transition rules over
an event log, the compare-and-swap store contract and a reference store.
**Exit:** AUTH-2 established by property tests over random grant trees
(including the mutation of each half separately); LEDGER-1…6 and CONC-1
established by stateful tests with concurrent agents, including the mutation
that removes compare-and-swap.

**As built** ([implementation-7c.md](core-v1/implementation-7c.md),
ADRs [0021](adr/0021-authority-ledger-package-boundary.md),
[0022](adr/0022-principal-event-log-and-derived-state.md),
[0023](adr/0023-ledger-store-contract.md)): `packages/ledger` — registration,
lineage validity, revocation, the subset check and the meet; a closed,
hash-chained event log folded by one pure reducer; atomic charging of every
leg of the lineage-then-policy path; the compare-and-swap store contract with
an in-memory reference store; module-registry conformance; and a bounded-retry
engine. AUTH-2, AUTH-4, AUTH-GLOBAL-1 (dimensions), LEDGER-1, -4, -5, -6 and
CONC-1 (with the read-then-write mutation) are established; LEDGER-2, -3 and
LEDGER-RESTORE-1 only partly, because consumption, release and restoration
are folded without observation validation, which is 7D's. AUTH-GLOBAL-2 is not
established: a new principal-global dimension is refused once anything was
reserved.

### Phase 7D — Invariant + Reservation Engine — FROZEN ✓

**Delivers** the executable `DomainModule` interface (decode, resources,
required state, risk direction, projection, contributions, settle, positions,
invariants), invariant dispatch, conservative projection, the reservation
state machine and reconciliation rules.
**Exit (as originally written):** RECON-1…5, TIME-1 and REPLAY-1 established
by randomized reconciliation properties with duplicated, reordered and stale
observations.

**Exit ownership corrected in 7D.1.** The original exit criteria depend on
things 7D does not have, so the ordering was corrected. The invariants were
not implemented early, and they are not claimed to close 7D:

- **RECON-1…5** → **7F**: they need validated observations, finality and
  idempotent application.
- **TIME-1, the external/finality part** → **7F**.
- **REPLAY-1, execution-authorization / artifact replay protection** →
  **7E**, where the first signer and issuance boundary exist.

The internal foundations already built stay credited to 7C/7D:
generation-exact reservation identity and facts, non-repeating generations,
and no time-triggered release in the reducer.

**As built** ([implementation-7d.md](core-v1/implementation-7d.md),
ADRs [0024](adr/0024-version-bound-domain-module-interface.md)–[0026](adr/0026-worst-case-projection-over-pending-reservations.md)):
`packages/control` — the version-bound `DomainModule` interface and exact
module resolution with conformance; state requirements, admission and
bindings over an explicit evaluation context; worst-case projection over
every unresolved reservation; lineage and principal-global invariant
evaluation, including Core's cross-module aggregate; semantic delegation
narrowing through a configured ledger ordering; ledger demands into charge
plans; atomic reservation by CAS with full re-projection on conflict; pure
revalidation and `NEVER_ISSUED` closure. The phase brief excluded
venue-driven transitions, so observation reconciliation — and with it the
exit criteria RECON-1…5, TIME-1 and REPLAY-1 — is **not** built; see the
corrected ownership above. `settle` and `positions` are not part of the
interface yet. No production domain module exists.

**Phase 7D.1 — semantic hardening** (accepted;
[implementation-7d.md §22](core-v1/implementation-7d.md#22-phase-7d1-semantic-hardening)).
It closes five issues before the first real market integration, as rulings:

- a principal-global marked aggregate uses one admitted valuation context per
  canonical asset;
- aggregate scope is closed and fail-closed, and every module with unresolved
  activity is consulted;
- a new or tightened principal-global invariant needs a baseline once
  activity exists (`POLICY_UPDATE_REQUIRES_BASELINE`);
- retired modules stay available for historical replay, and invariant
  ownership is bound to the module's name and version;
- `NEVER_ISSUED` becomes unavailable once 7E admits an issuance attempt.

Cross-domain valuation consistency is established. AUTH-GLOBAL-2, RECON-1…5
and REPLAY-1 are not.

**Phase 7D.2 — historical semantic provenance and freeze**
([implementation-7d.md §23](core-v1/implementation-7d.md#23-phase-7d2-historical-semantic-provenance-and-freeze)).
Every narrowing the ledger accepts now commits the exact definition that
proved it — Core, or the full `ModuleRef` with its digest — in the
registration event. Replay resolves that exact artifact from the loaded or
archived modules, never through the registry's current name mapping, and
refuses without it. Benchmarks were re-run after 7D.1, up to the
4,096-reservation bound, and scale linearly.

**Phase 7D.3 — immutable authority semantics and final freeze**
([implementation-7d.md §24](core-v1/implementation-7d.md#24-phase-7d3-immutable-authority-semantics-and-final-freeze)).
A registered grant or policy is bound, in its registration event, to the
exact definition — `ModuleRef` with digest — of each module-defined term.
Future authorization evaluates the term under that committed definition,
loaded or archived, and never under whichever module the registry maps the
name to later. If that definition is unavailable, the action refuses. New
authority binds to the current, active definition. SEMANTIC-AUTH-1…3 are
established. Semantic drift of already-registered authority is closed, and
Phase 7D is frozen after this checkpoint.

### Phase 7E — PerpPolicy v1 and Venue Signer — NEXT

**Delivers** the perp domain module and a Venue Signer adapter.
**Exit (from 7D, corrected in 7D.1):** REPLAY-1's execution-authorization and
artifact replay protection.
**Frozen precondition (7D.1).** Before any enforcement adapter may issue or
sign an external artifact, it must commit an issuance-attempt event
(`ADMIT_ATTEMPT`) for the exact reservation generation. From then on,
`NEVER_ISSUED` cannot close that generation because later revalidation,
process execution or signer behaviour failed. An uncertain failure leaves it
reserved or quarantined, and nothing is released on a timeout
([implementation-7d.md §22.6](core-v1/implementation-7d.md#226-never_issued-and-the-frozen-7e-issuance-precondition-r5)).
**Depends on** first evidencing the venue facts the adapter needs
([core-v1 open question 3](core-v1/README.md#open-questions)).

### Phase 7F — Cross-domain reconciliation: EVM fixture and perps

**Delivers** the EVM adapter over the frozen gate and one principal ledger
shared across the EVM fixture and perps.
**Exit:** examples A–C of [core-v1/examples.md](core-v1/examples.md) run as
tests; and, from 7D (corrected in 7D.1), RECON-1…5 and TIME-1's
external/finality part, established by randomized reconciliation properties
with duplicated, reordered and stale observations.

### Phase 7G — Developer SDK and simulator

### Phase 7H — Receipts and authority provenance

**Exit:** RECEIPT-1…3 established; every decision in a corpus reproduced from
its receipt.

---

## Phase 8+ — Validated domain modules

Predictions, Lending, Liquidity, Options, Payments, Governance. Each is a
domain module and, where needed, an adapter. **The test of the abstraction:
adding one requires no Core change and no Phase 6 change**, as Phase 4 required
that adding a venue adapter need no verifier change.

## Phase 9 — Multi-agent delegation

Full hierarchical delegation and agent-to-agent authority proofs across
principals.

## Phase 10 — State attestation, freshness and trust adapters

## Phase 11 — Audits, benchmarks and production pilots

### Previously planned, now unscheduled

The earlier Phase 7 (stablecoin funding and routing adapters, design
[§19](mandate-design.md#19-stablecoin-funding-as-a-supporting-layer)) and
Phase 8 (demo product and web experience) are not in the new ordering. They
are unscheduled pending an owner decision, not cancelled.

The one structural commitment carried into every future phase: **only Core
says yes.** For the EVM path, Core's decision includes the kernel verifier's.
Any capability that would let something else permit an execution is a change
to the product, and belongs in the design documents before it belongs in code.

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
| 5R | Pressure-test remediation (F-1…F-16) | 5 | ✅ complete |
| 5R.1 | Post-remediation audit remediation (N-1…N-10) | 5R | ✅ complete |
| 5R.2–5R.3 | Replay evidence, public boundaries, encoder domains | 5R.1 | ✅ complete |
| 6 | On-chain execution gate and settlement fixture | 5R.3 | **FROZEN ✓ at `dc98df5`**, including 6R–6R.2B below (rows are historical) |
| 6R | Principal-authority closure and execution-gate hardening | 6 | implemented locally; remediated by 6R.1 |
| 6R.1 | Exact principal notional enforcement (M-1) | 6R | implemented locally; independently reviewed; remediated by 6R.1a |
| 6R.1a | Reconciliation coherence and fixture trust closure | 6R.1 | implemented locally; independently reviewed; cleaned up by 6R.1b |
| 6R.1b | Final pre-optimization cleanup | 6R.1a | ✅ implemented locally, not deployed; awaiting independent review |
| 6R.2A | Gas attribution and architecture benchmark (measurement only) | 6R.1b | ✅ measured locally; recommendation awaiting review; no production change |
| 6R.2B | Gas optimization, path chosen from the 6R.2A measurements | 6R.2A | ✅ implemented locally; awaiting independent security and gas review; not deployed |
| 7A | Mandate Core v1 specification | 6 | **FROZEN ✓** — specification only, hardened |
| 7B | Core types and generic action/state model | 7A | **FROZEN ✓** — with 7B.1 representation hardening (meet and AUTH-2 → 7C; module interface → 7D) |
| 7C | Authority Graph + Global Authority Ledger (meet, effective lineage, AUTH-2) | 7B | **FROZEN ✓** |
| 7D | Invariant + Reservation Engine (executable `DomainModule` interface) | 7C | **FROZEN ✓** — with 7D.1 hardening, 7D.2 provenance and 7D.3 immutable authority semantics (observation reconciliation → 7F, issuance → 7E) |
| 7E | PerpPolicy v1 and Venue Signer | 7D | **NEXT** — not started; blocked on venue evidence |
| 7F | Cross-domain reconciliation: EVM fixture and perps | 7E | planned |
| 7G | Developer SDK and simulator | 7F | planned |
| 7H | Receipts and authority provenance | 7F | planned |
| 8+ | Validated domain modules | 7H | future |
| 9 | Multi-agent delegation, agent-to-agent authority proofs | 8 | future |
| 10 | State attestation, freshness and trust adapters | 9 | future |
| 11 | Audits, benchmarks and production pilots | 10 | future |
