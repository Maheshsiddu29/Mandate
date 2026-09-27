# Mandate Core v1 — Security invariants

> **Status: Phase 7A specification, FROZEN (after the hardening checkpoint). Not implemented, so
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
| **AUTH-5** | One principal's tree never charges, reads availability from, or is charged by another principal's ledger, or another tree of the same principal; the only thing trees of one principal share is that principal's policy. | ledger scoping ([authority-ledger.md §1](authority-ledger.md#1-purpose-and-scope)) | S |
| **AUTH-GLOBAL-1** | Principal-global invariants and dimensions apply to every action of the principal, whichever authority root or path it uses; no action escapes one by using a different root. A principal with no registered policy can authorize nothing, and an empty policy is an explicit statement, never an inferred aggregate. | the principal policy as the last node of every charging path; lineage validity requires a policy ([authority-model.md §8](authority-model.md#8-principal-policy-and-principal-global-invariants)) | S with several roots and agents; M dropping the policy legs must let a second root breach the global limit |
| **AUTH-GLOBAL-2** | A principal-global dimension counts what already exists: introduced by a new policy, it starts from the open lots and active reservations that match it, and a replaced policy keeps the consumption history of every dimension it keeps. | policy registration initializes from lots and reservations in the same commit | S; P over policy replacement sequences |

## Ledger

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **LEDGER-1** | For every node, policy and dimension, `consumed + active reserved ≤ granted + restored` for everything Core authorizes. Only observed overrun or adverse drift can exceed it; both are always recorded and block further increases on that dimension. | availability check at commit; `BREACHED` flag ([authority-ledger.md §10](authority-ledger.md#10-overrun)) | S with concurrent agents, M |
| **LEDGER-GRANT-1** | Economic gains cannot increase granted authority implicitly: `GRANTED` changes only by a new signed grant or principal policy, and no proceeds, profit, appreciation or yield enters `GRANTED` or `RESTORED`. | the vocabulary of [authority-ledger.md §4](authority-ledger.md#4-authority-vocabulary-granted-reserved-consumed-restored-available); no event writes `G` | P: `available ≤ granted` after any sequence of profitable round trips; M restoring at proceeds must fail |
| **LEDGER-RESTORE-1** | Restored capacity never exceeds what final evidence legitimately released: `0 ≤ restored ≤ consumed` per dimension; restoration only by a final decreasing observation or `DRIFT_CORRECT`, at the dimension's own rule, credited only to the legs the closed lots were charged to; `BUDGET` dimensions never restore. | restoration rules and position lots ([authority-ledger.md §4.1](authority-ledger.md#41-position-lots-and-restoration-attribution)) | S with partial closes, reordering and cross-agent closes; P that no sequence yields `available > granted` |
| **LEDGER-2** | One reservation cannot be consumed twice: each fill is applied at most once and a leg's consumption never exceeds its reservation (excess is overrun). | fill-id idempotency; consumption arithmetic ([reservations-reconciliation.md §6](reservations-reconciliation.md#6-consumption-arithmetic)) | S with duplicated and reordered deliveries |
| **LEDGER-3** | A released reservation cannot later consume authority without a new valid generation: after `CLOSE`, a new fill is overrun plus conflict, never consumption against released authority. | closed-reservation handling (§8) | S |
| **LEDGER-4** | A reservation's legs across the lineage are reserved, consumed, overrun and released together or not at all. | atomic batch commit | S with injected commit failures |
| **LEDGER-5** | A required contribution that matches no dimension on the lineage rejects: no unbounded consumption. | availability check | P, M |
| **LEDGER-6** | Every balance equals the fold of the event log from genesis. | pure transition rules; cached balances verified | P |
| **CONC-1** | Decisions are linearizable: a decision commits only at the ledger version it read, and a conflicting commit forces recomputation. | compare-and-swap on the principal-wide version ([authority-ledger.md §9](authority-ledger.md#9-linearizability-and-what-it-does-not-cover)) | S with interleaved agents; M replacing CAS with read-then-write must produce oversubscription |
| **CORE-CONC-1** | Ledger linearization does not imply external-state atomicity: Mandate serializes authority consumption, not market state. No property may be argued from CAS alone for anything outside the ledger; external state is relied on only through state bindings (STATE-4, STATE-5). | the scope statement of [architecture.md §6a](architecture.md#6a-what-the-linearization-point-does-not-linearize); issue-time admission | S where external state changes between commit and issue: the artifact is never issued on inadmissible state |
| **SCOPE-1** | A contribution carries every scope attribute its kind defines, resolved, or the action rejects. | domain module `contributions` contract | P, M |

## Units and projection

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **UNIT-1** | No addition, subtraction or comparison across quantity kind, unit or asset. | types; runtime refusals at boundaries ([action-state-model.md §3.4](action-state-model.md#34-rules)) | P, F, and a type-level test that the mixing expression does not compile |
| **UNIT-2** | Cross-kind relations exist only as named, versioned domain rules; there is no generic converter. | module interface | structural |
| **UNIT-3** | Cross-unit relations exist only as declared settlement assumptions or valuations with provenance; never an implicit 1:1. | quantity rules ([action-state-model.md §3.4](action-state-model.md#34-rules)) | P, M |
| **UNIT-4** | Every rounding is against the actor. | exact arithmetic with stated direction | P with exact oracle, as `ExactMath.t.sol` does |
| **UNIT-5** | Unsigned quantities never go negative: a subtraction that would is a refusal, never a wrap or saturation, unless a rule defines saturation explicitly. | quantity arithmetic | P, F |
| **PROJ-1** | Projection credits no pending risk-reducing effect and applies every pending risk-increasing effect in full. | domain module `project` contract | P per module |
| **SETTLE-MONO** | A domain module's `settle` is monotone in the fill set. | domain module contract | P per module |

## State

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **STATE-1** | Every required snapshot satisfies its source policy (configured source, configured trust class) and its state requirement: freshness by its declared mode, and finality — the tightest of the module's default, every lineage node's and the principal policy's. | admission ([action-state-model.md §5.3](action-state-model.md#53-admission)) | P, F |
| **STATE-2** | Conflicting admitted observations of the same state kind and subject fail closed. | admission rule 7 | P |
| **STATE-3** | No snapshot older than the ledger's reconciliation watermark for its subject, or with a regressed sequence, is admitted. | admission rules 5–6 | S |
| **STATE-4** | An authorization binds the exact state provenance and freshness requirements it used: each admitted snapshot's source, trust class, sequence, observation time, validity, finality and digest, and the effective requirement it was admitted under, are on the reservation and in every receipt, and are replaced only by a committed revalidation. *(The brief's "STATE-2"; STATE-2 was already assigned to conflicts.)* | `StateBinding` ([action-state-model.md §5.5](action-state-model.md#55-state-bindings-freshness-modes-and-execution-dependence)) | P: every decision's receipt reproduces its admission; M dropping a binding field must fail reproduction |
| **STATE-5** | A state-dependent action cannot silently execute against state outside its declared policy: no artifact is issued unless every binding is admissible at issue time or replaced by a passing revalidation; no artifact outlives a `BOUNDED_BY_FRESHNESS` binding; every other execution-time dependency is enforced by a named artifact field or declared pre-trade only. | issue-time admission ([reservations-reconciliation.md §10a](reservations-reconciliation.md#10a-issue-time-state-admission-and-revalidation)); EXEC-6 | S with state aging and superseding between decision and issue, both sides of each freshness boundary |
| **FAIL-1** | `UNKNOWN` — missing state, an invariant that cannot be evaluated, an unknown execution status — rejects every risk-increasing action. | invariant and status vocabularies; no default path | P, M |

## Execution

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **EXEC-1** | Every enforcement artifact is bound to the authorized action: mutating any bound field makes the enforcement point refuse. | adapter `bind`/`issue`; enforcement point checks | per-adapter field mutation vectors, as `bind-*` |
| **EXEC-2** | The agent cannot alter authorized execution parameters after approval beyond bounds derived from the reservation. | adapter custody; enforcement point bounds ([enforcement-adapters.md §5](enforcement-adapters.md#5-binding-rules)) | adversarial agent tests per adapter |
| **EXEC-3** | Every artifact's validity ends at or before its reservation's attempt ceiling, which is at or before the intent's and every lineage node's expiry. | `ADMIT_ATTEMPT`; adapter derivation | P, boundary tests on both sides of each instant |
| **EXEC-4** | All attempts under one reservation cannot together execute more than its worst case. | enforcement-point dedup or one live attempt at a time | S per adapter |
| **EXEC-5** | Nothing is issued under a reservation that is not `ACTIVE` at the authorization's generation, or under a lineage no longer valid, or before issue-time state admission. | `ADMIT_ATTEMPT` precondition, committed before any artifact exists | S, M |
| **EXEC-6** | No artifact's validity outlives the `BOUNDED_BY_FRESHNESS` state it depends on. | adapter derivation of validity windows | P, boundary tests |
| **CRED-1** | The agent holds no credential that can move principal resources, or produce an artifact the enforcement point accepts, except through Core. | adapter custody design; reviewed per adapter ([enforcement-adapters.md §3](enforcement-adapters.md#3-non-bypassability)) | review; negative test that an agent-only key set cannot execute |

## Reconciliation and replay

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **RECON-1** | Reconciliation cannot release more authority than remains reserved. | release = reserved − consumed; overrun booked separately | P, S |
| **RECON-2** | An observation of any generation other than the reservation's current one mutates nothing. | generation check first ([reservations-reconciliation.md §5](reservations-reconciliation.md#5-observations)) | S — the Phase 6R.1b randomized reconciliation property, generalized; M |
| **RECON-3** | Consumption, release and restoration exist only as effects of applied, validated observations or of drift evidence under the ledger's drift rules; there is no bare command and no generic adjustment. | the event vocabulary ([authority-ledger.md §5](authority-ledger.md#5-events)) | structural; M |
| **RECON-4** | Observations are idempotent: a `(sourceId, eventId)` is applied at most once, and the same id with different content is a conflict. | applied-set | S with duplicates |
| **RECON-5** | Only a final observation at the adapter's declared finality level closes a reservation. | finality check | S with non-final cancels, M |
| **TIME-1** | The passage of time never releases reserved authority, restores consumed authority, resolves pending drift, or extends authority: a lapsed ceiling quarantines, it never closes. An `EPOCH` budget's new window is authority the principal signed in advance, not restoration, and releases nothing still reserved. | no time-triggered release or restoration transition | S; M adding a timer release must fail |
| **REPLAY-1** | A consumed authorization cannot be replayed: a `SPENT` intent never reserves again; a generation never repeats or wraps; retry happens only after a final zero-consumption close. | intent record ([reservations-reconciliation.md §3](reservations-reconciliation.md#3-intent-replay-identity)) | S, boundary test at the generation maximum |

## Drift

| ID | Invariant | Enforced by | Test |
| --- | --- | --- | --- |
| **DRIFT-1** | Adverse trusted drift cannot increase available authority: it is recorded as consumption on every charging path that could act on the subject, immediately, and can only lower `available`. | `DRIFT_ADVERSE` ([authority-ledger.md §11](authority-ledger.md#11-drift)) | S with injected external activity; P that no adverse evidence raises any `available` |
| **DRIFT-2** | Favorable drift cannot release or restore authority without final evidence meeting the domain's reconciliation policy; until then it is pending, with no balance effect, and time never resolves it. | `DRIFT_PENDING` / `DRIFT_CORRECT` | S with stale, lagging and wrong favorable snapshots; M applying favorable drift immediately must fail |
| **DRIFT-3** | No privileged function can create or restore authority to correct the ledger; every correction is a rule over evidence, receipted. | the event vocabulary has no generic adjustment | structural; review |

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
| **DOM-2** | The semantic module that interprets an action and its state — `ModuleRef { domainId, moduleId, moduleVersion, moduleDigest }` — is part of the authorization's identity and is the same on the intent, the decision, the reservation, the execution binding, every reconciliation and every receipt; only an implementation registered as conforming to that digest may run it; the same holds for the adapter's `AdapterRef`. | module registry; reservation fields ([action-state-model.md §8.1](action-state-model.md#81-module-identity-and-binding)) | S upgrading modules mid-lifecycle: reconciliation still uses the reservation's module; F on `ModuleRef` parsing; M loading an unregistered implementation must be refused |
| **CORE-1** | Only Core says yes: no adapter, domain module, model or agent can cause a reservation or an artifact without a Core PASS. | layer boundaries | adversarial stubs for each layer, as the Phase 5 Jev stubs |
| **PHASE6-1** | Core leaves Phase 6 byte-identical: every Phase 6 generated artifact and vector is unchanged. | no Phase 6 edits | `npm run generated:check`, `contracts:test` unchanged, in every Phase 7 report |
