# Mandate Core v1 — Security invariants

> **Status: Phase 7A specification, DRAFT pending review. Not implemented, so
> nothing below is established.** Each invariant names the mechanism specified
> to enforce it and the kind of test that must establish it when that mechanism
> is built. They are written to become property, fuzz, stateful-invariant,
> differential and mutation tests in Phases 7B–7H, in the style of
> `INV-ONCHAIN-*` and `verifier-invariants.md`.

These extend, and never weaken, the product invariants in
[design §16](../mandate-design.md#16-major-invariants). In particular INV-1
(no component widens signed authority), INV-2 (authentication is not
authorization), INV-3/INV-4 (models are advisory), INV-5 (fail closed), INV-11
(reproducible receipts), INV-12 (replay), INV-13 (the executed action is the
verified one), INV-16 (no floating point) and INV-18 (units) apply to Core
unchanged.

Test kinds: **P** property test over generated inputs; **F** fuzz of a parser
or boundary; **S** stateful invariant under random operation sequences
(multiple agents, domains, observations, crashes, reorderings); **D**
differential against a second implementation or reference model; **M**
mutation — the test must fail when the enforcing check is removed.

## Authority

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **AUTH-1** | No action may consume authority not delegated by a valid principal lineage. | lineage validity at every decision ([authority-model.md §5](authority-model.md#5-lineage-validity)); reservations only from committed PASS decisions | S, M |
| **AUTH-2** | Delegation cannot widen parent authority: a widening grant is refused at registration, and the effective authority of any node is never wider than any ancestor's terms even if one were registered. | registration check (§6) **and** the meet at every action (§4) | P over random grant trees, M on each half separately |
| **AUTH-3** | A valid actor signature never authorizes on its own: actor = leaf holder is necessary and never sufficient. | pipeline steps 2–11 | P, M |
| **AUTH-4** | Revocation is irreversible and subtree-wide, and blocks every reservation committed at or after the ledger version that records it. | revocation set in the ledger, read at the decision's version | S |
| **AUTH-5** | One principal's tree never charges, reads availability from, or is charged by another principal's ledger, or another tree of the same principal. | ledger scoping ([authority-ledger.md §1](authority-ledger.md#1-purpose-and-scope)) | S |

## Ledger

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **LEDGER-1** | For every node and dimension, consumed + active reserved ≤ granted for everything Core authorizes. Only an observed overrun can exceed it; it is always recorded and blocks further increases on that dimension. | availability check at commit; `BREACHED` flag ([authority-ledger.md §9](authority-ledger.md#9-overrun-drift-and-adjustment)) | S with concurrent agents, M |
| **LEDGER-2** | One reservation cannot be consumed twice: each fill is applied at most once and a leg's consumption never exceeds its reservation (excess is overrun). | fill-id idempotency; consumption arithmetic ([reservations-reconciliation.md §6](reservations-reconciliation.md#6-consumption-arithmetic)) | S with duplicated and reordered deliveries |
| **LEDGER-3** | A released reservation cannot later consume authority without a new valid generation: after `CLOSE`, a new fill is overrun plus conflict, never consumption against released authority. | closed-reservation handling (§8) | S |
| **LEDGER-4** | A reservation's legs across the lineage are reserved, consumed, overrun and released together or not at all. | atomic batch commit | S with injected commit failures |
| **LEDGER-5** | A required contribution that matches no dimension on the lineage rejects: no unbounded consumption. | availability check | P, M |
| **LEDGER-6** | Every balance equals the fold of the event log from genesis. | pure transition rules; cached balances verified | P |
| **CONC-1** | Decisions are linearizable: a decision commits only at the ledger version it read, and a conflicting commit forces recomputation. | compare-and-swap on the principal-wide version ([authority-ledger.md §8](authority-ledger.md#8-linearizability)) | S with interleaved agents; M replacing CAS with read-then-write must produce oversubscription |
| **SCOPE-1** | A contribution carries every scope attribute its kind defines, resolved, or the action rejects. | domain module `contributions` contract | P, M |

## Units and projection

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **UNIT-1** | No addition, subtraction or comparison across quantity kind, unit or asset. | types; runtime refusals at boundaries ([action-state-model.md §3.4](action-state-model.md#34-rules)) | P, F, and a type-level test that the mixing expression does not compile |
| **UNIT-2** | Cross-kind relations exist only as named, versioned domain rules; cross-unit relations only as declared settlement assumptions or valuations with provenance. | no generic converter exists | structural |
| **UNIT-3** | Every rounding is against the actor. | exact arithmetic with stated direction | P with exact oracle, as `ExactMath.t.sol` does |
| **PROJ-1** | Projection credits no pending risk-reducing effect and applies every pending risk-increasing effect in full. | domain module `project` contract | P per module |
| **SETTLE-MONO** | A domain module's `settle` is monotone in the fill set. | domain module contract | P per module |

## State

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **STATE-1** | Every required snapshot satisfies its source policy (configured source, configured trust class) and its freshness policy (the tightest age bound on the lineage). | admission ([action-state-model.md §5.3](action-state-model.md#53-admission)) | P, F |
| **STATE-2** | Conflicting admitted observations of the same state kind and subject fail closed. | admission rule 7 | P |
| **STATE-3** | No snapshot older than the ledger's reconciliation watermark for its subject, or with a regressed sequence, is admitted. | admission rules 5–6 | S |
| **FAIL-1** | `UNKNOWN` — missing state, an invariant that cannot be evaluated, an unknown execution status — rejects every risk-increasing action. | invariant and status vocabularies; no default path | P, M |

## Execution

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **EXEC-1** | Every enforcement artifact is bound to the authorized action: mutating any bound field makes the enforcement point refuse. | adapter `bind`/`issue`; enforcement point checks | per-adapter field mutation vectors, as `bind-*` |
| **EXEC-2** | The agent cannot alter authorized execution parameters after approval beyond bounds derived from the reservation. | adapter custody; enforcement point bounds ([enforcement-adapters.md §5](enforcement-adapters.md#5-binding-rules)) | adversarial agent tests per adapter |
| **EXEC-3** | Every artifact's validity ends at or before its reservation's attempt ceiling, which is at or before the intent's and every lineage node's expiry. | `ADMIT_ATTEMPT`; adapter derivation | P, boundary tests on both sides of each instant |
| **EXEC-4** | All attempts under one reservation cannot together execute more than its worst case. | enforcement-point dedup or one live attempt at a time | S per adapter |
| **EXEC-5** | Nothing is issued under a reservation that is not `ACTIVE` at the authorization's generation. | adapter `issue` precondition | S, M |
| **CRED-1** | The agent holds no credential that can move principal resources, or produce an artifact the enforcement point accepts, except through Core. | adapter custody design; reviewed per adapter ([enforcement-adapters.md §3](enforcement-adapters.md#3-non-bypassability)) | review; negative test that an agent-only key set cannot execute |

## Reconciliation and replay

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **RECON-1** | Reconciliation cannot release more authority than remains reserved. | release = reserved − consumed; overrun booked separately | P, S |
| **RECON-2** | An observation of any generation other than the reservation's current one mutates nothing. | generation check first ([reservations-reconciliation.md §5](reservations-reconciliation.md#5-observations)) | S — the Phase 6R.1b randomized reconciliation property, generalized; M |
| **RECON-3** | Consumption and release exist only as effects of applied, validated observations; there is no bare command. | the event vocabulary ([authority-ledger.md §4](authority-ledger.md#4-events-and-statuses)) | structural; M |
| **RECON-4** | Observations are idempotent: a `(sourceId, eventId)` is applied at most once, and the same id with different content is a conflict. | applied-set | S with duplicates |
| **RECON-5** | Only a final observation at the adapter's declared finality level closes a reservation. | finality check | S with non-final cancels, M |
| **TIME-1** | The passage of time never releases, restores or extends authority: a lapsed ceiling quarantines, it never closes. | no time-triggered release transition | S; M adding a timer release must fail |
| **REPLAY-1** | A consumed authorization cannot be replayed: a `SPENT` intent never reserves again; a generation never repeats or wraps; retry happens only after a final zero-consumption close. | intent record ([reservations-reconciliation.md §3](reservations-reconciliation.md#3-intent-replay-identity)) | S, boundary test at the generation maximum |

## Receipts

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **RECEIPT-1** | Every receipt references the exact lineage, admitted state, ledger versions and decision or transition it records. | receipt schemas ([receipts-provenance.md §4](receipts-provenance.md#4-schemas)) | P |
| **RECEIPT-2** | A decision is reproducible from the objects its receipt references. | pure decision function; content-addressed inputs | D: replay every decision in a corpus from receipts alone |
| **RECEIPT-3** | Every ledger transition, including every refused observation, has a receipt, and the receipt chain and the ledger chain anchor each other. | header chaining | S: no transition without a receipt; tamper tests |

## Boundaries

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **DOM-1** | Domain modules are pure and total and cannot authorize; Core reads payloads only through them. | module interface; structure tests (no I/O, clock or model client) | structural, as every existing package |
| **CORE-1** | Only Core says yes: no adapter, domain module, model or agent can cause a reservation or an artifact without a Core PASS. | layer boundaries | adversarial stubs for each layer, as the Phase 5 Jev stubs |
| **PHASE6-1** | Core leaves Phase 6 byte-identical: every Phase 6 generated artifact and vector is unchanged. | no Phase 6 edits | `npm run generated:check`, `contracts:test` unchanged, in every Phase 7 report |
