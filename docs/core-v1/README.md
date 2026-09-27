# Mandate Core v1

> **Status: Phase 7A specification, DRAFT pending review. Nothing here is
> implemented.** Phase 6 is frozen as of `dc98df5` and is not modified by
> anything in this directory. No code accompanies this specification.

Mandate Core v1 is the domain-independent economic control layer that Spot,
Perp, Options, Prediction, Lending, Liquidity, Payment, Treasury and Governance
modules will build on. It represents delegated economic authority, proposed
autonomous actions, the economic state they depend on, the authority they
consume and hold while in flight, where they are enforced, how their actual
outcome is reconciled, and the evidence left behind.

```
agent autonomy  ⊆  principal-delegated economic authority
```

## Reading order

| Document | What it specifies |
| --- | --- |
| [architecture.md](architecture.md) | The core equation, the four layers, what is deterministic Core and what belongs to domain modules and adapters, the linearization point, the relationship to frozen Phase 6, and the concept catalogue |
| [authority-model.md](authority-model.md) | Parties, grants, the seven kinds of authority term, the meet that keeps child ⊆ parent, lineage and delegation validity, revocation and expiry |
| [action-state-model.md](action-state-model.md) | Identifiers, typed economic quantities and the rules that stop units and kinds mixing, the action envelope, the state envelope with source trust and freshness, conservative projection, typed invariants, and the domain module interface |
| [authority-ledger.md](authority-ledger.md) | Which constraints are counters and which are not, dimensions with BUDGET and CAPACITY accounting, events and statuses, path charging, balance equations, the availability check, linearizability, and overrun, drift and adjustment |
| [reservations-reconciliation.md](reservations-reconciliation.md) | Non-atomic execution statuses, intent replay identity and generations, the reservation state machine, observations and their validation order, consumption arithmetic, late and conflicting events, a partial-fill timeline, and the mapping onto the Phase 6 replay machine |
| [enforcement-adapters.md](enforcement-adapters.md) | The adapter contract, the questions every adapter must answer, non-bypassability, the frozen Phase 6 gate as the EVM adapter's enforcement point, requirements for a perp Venue Signer, and binding rules |
| [receipts-provenance.md](receipts-provenance.md) | Receipt kinds, the hash-chained header, schemas, which field answers which audit question, reproducibility, and authority, state and execution provenance |
| [security-invariants.md](security-invariants.md) | AUTH, LEDGER, CONC, SCOPE, UNIT, PROJ, STATE, FAIL, EXEC, CRED, RECON, TIME, REPLAY, RECEIPT, DOM, CORE and PHASE6 invariants, each with its enforcing mechanism and the test that must establish it |
| [examples.md](examples.md) | Cross-domain capital, cross-venue pending exposure, two agents on one budget, hierarchical delegation, and an EVM retry with a stale observation — with the ambiguities each exposed |

## The model in one page

```
M   = meet of every grant on the acting node's lineage
L   = the principal's ledger at version v (reconciled occupancy + active reservations)
S   = admitted snapshots (source, trust class, freshness) + L
S'  = Project_d(S ⊕ Pending(L), A)                        conservative, all domains, all agents

Authorize(A, t) at v  ⇔  LineageValid ∧ AuthorityCovers ∧ FreshEnough ∧ InvariantsHold(S') ∧ AuthorityAvailable
                          ── committed with the reservation by compare-and-swap at v ──

Reserve → Bind → Enforce → Observe → Reconcile → Consume / Release → Receipt
```

- **Authority** is a forest of signed grants per principal. A child is ⊆ its
  parent twice over: refused at registration if it widens or omits a term, and
  re-intersected at every action.
- **Constraints** come in seven kinds. Only quantities are ledger counters;
  sets, rights, bounds, time and state invariants are enforced where they mean
  something.
- **Quantities** carry kind, unit, decimals and, where relevant, asset and
  valuation. Spot notional and perp margin cannot be added because they are
  different types.
- **The ledger** is one linearizable log per principal. Reservations place legs
  at every lineage node that grants a matching dimension.
- **Reservations** close only on final observed evidence. Time quarantines and
  never releases. Observations are bound to a generation, idempotent, and
  reordering-safe. Overruns are recorded, not refused.
- **Enforcement** is whatever actually refuses: the Phase 6 gate, a venue's
  signature check, an account module. Non-bypassability is a property of who
  holds which credential, and is declared per adapter.
- **Receipts** are hash-chained, digest-referencing and reproducible.

## Decisions frozen

These decisions are frozen for Phase 7B onward, subject to this review.

1. **Phase 6 is untouched.** Core sits above it. The frozen gate is the EVM
   adapter's enforcement point, and each Core reservation generation derives a
   fresh MCE v2 mandate.
2. **Every action and state value is a Core envelope plus a typed payload.**
   There is no universal state or action struct.
3. **Identity is content.** `AuthorityId`, `ActionDigest`, `StateDigest`,
   `ReservationId` and `ReceiptDigest` are keccak-256 digests with domain tags,
   under the canonical-encoding discipline of ADR 0002. Labels are never
   identity.
4. **The authority graph is a tree per root and a forest per principal.**
   Nothing is shared across trees or across principals.
5. **Authority terms come in seven kinds, and only quantities are counted.**
6. **Child ⊆ parent is enforced at registration and again at every action.**
   Registration refuses widening and requires every bound, invariant and
   state-policy term to be restated. The meet is recomputed at every action.
7. **Child limits are ceilings, not partitions.** The path rule charges every
   ancestor's leg.
8. **One linearizable ledger per principal** with a principal-wide version. The
   decision and its reservation commit together by compare-and-swap.
9. **Every quantity has a kind and a unit.** Cross-kind relations are named
   domain rules. Cross-unit relations are declared assumptions or valuations
   with provenance.
10. **The ledger stores only non-floating quantities.** Marked exposure is an
    invariant evaluated on fresh prices.
11. **Accounting is `BUDGET` or `CAPACITY`.** Capital is restored at cost basis,
    never at proceeds.
12. **Closed world for quantities.** A required contribution must match a
    dimension. Scope attributes must be resolved.
13. **Projection is conservative and global.** Every pending reservation, in
    every domain and from every agent, counts at its worst case, and pending
    reductions are not credited.
14. **The domain module derives what the agent is not trusted to say.** Risk
    direction, state dependencies and contribution amounts come from the
    module, never from the agent.
15. **Consume and release happen only as effects of applied observations.**
    Time never releases, and quarantine holds authority.
16. **Observations are bound to a generation and are idempotent.** The key is
    `(source, event)`, fills commute, and finality means evidence at the
    adapter's declared level.
17. **A partial execution spends its intent.** A retry is allowed only after a
    zero-consumption final close.
18. **Overrun is recorded, not refused, and a breach blocks increases.**
19. **Revocation is irreversible and subtree-wide.** It does not release
    in-flight reservations.
20. **Risk-increasing actions fail closed.** There is no degraded-state
    exception in v1 (`degradedStatePolicy = NONE`).
21. **Reason codes do not name dimensions.** Nodes and dimensions travel as
    structured detail.
22. **Every adapter declares a non-execution rule.** Without one, unresolved
    reservations stay quarantined.

## Open questions

These are unresolved and need an answer before, or during, the phase named.

| # | Question | Needed by |
| --- | --- | --- |
| 1 | **EVM principal-side key custody.** The gate requires `ECDSA recover == mandate.principal` and has no ERC-1271 support. The options are a human signature per action, a custody-held funded EOA (recommended, which puts the signer in the TCB), or a new gate version. | 7F |
| 2 | **Perp margin mode first supported, isolated or cross,** and therefore where `CAPITAL` is charged: on the order, or on the deposit (examples §A) | 7E |
| 3 | **Every venue fact the Venue Signer depends on:** API, trading-only key scope, order expiry or nonce invalidation, cancel finality, collateral asset. Nothing in the repository evidences any of them for Lighter or any other venue. | 7E |
| 4 | **Who may perform `ADJUST`, on which evidence, and with what drift tolerance per domain.** The default until then is that drift blocks increases. | 7C / 7F |
| 5 | **Whether a narrow risk-reducing exception should exist:** under degraded state, and for closing positions after revocation | after 7F |
| 6 | **Priority and fairness between sibling agents,** and reservation hogging by long-resting orders | 7C |
| 7 | **Retention of the content-addressed objects receipts reference,** which reproducibility depends on | 7H |
| 8 | **The ledger's physical store, where it runs, and its availability.** The ledger is a liveness single point of failure by design. | 7C |
| 9 | **The final Core reason-code registry.** The names in these documents are provisional. | 7B |
| 10 | **Exact canonical encodings, domain tags and collection bounds,** and whether Core imports the kernel's `PartyId`/`Amount`/`Price` (a package-boundary ADR) | 7B |
| 11 | **Settlement-assumption vocabulary** (e.g. "USDG settles USD"): who may declare one and whether anything verifies it | 7B |
| 12 | **The mark source per canonical asset for marked-exposure invariants,** and what to do when venue marks diverge | 7D |
| 13 | **Acceptable revocation latency per adapter** | 7E / 7F |
| 14 | **Residual-intent semantics for partial fills.** v1 marks the intent `SPENT`. | later |
| 15 | **The superseded roadmap items: stablecoin funding (old Phase 7) and the demo and web experience (old Phase 8).** Both are unscheduled under the new roadmap. | owner |

## Deferred features

The following are recorded here so they are not built by accident: multi-parent and DAG
delegation; threshold issuers; contract principals (ERC-1271), which need a new
gate version; key rotation with continuous identity; scheduled revocation;
cross-principal agent-to-agent authority proofs (Phase 9); signed attestations
and state-trust adapters (Phase 10); ZK proofs; an onchain ledger; per-dimension
ledger versions or sharding; agent priority; residual intents; degraded-state
exceptions; `REAL_MARKET` EVM execution (needs authenticated inclusion-time
state); Options, Prediction, Lending, Liquidity, Payment and Governance modules
(Phase 8+); the SDK and simulator (7G); and, never in v1, a policy scripting
language.

## Design review questions

| Question | Answer |
| --- | --- |
| Can Core represent authority without knowing every market? | **Yes.** Core reads envelopes, kinds, units and scopes. Domain facts reach it only through a pure, versioned module interface ([action-state-model.md §8](action-state-model.md#8-the-domain-module-interface)). A new domain is a new module plus registry entries. The condition is that the module's `contributions`, `settle` and `project` are correct: modules are in the TCB. |
| Can different economic units be confused accidentally? | **Not silently.** Kind, unit and asset are part of every quantity, and no operation mixes them (UNIT-1, examples §A). What types cannot catch is a module rule that labels a quantity with the wrong kind, such as emitting notional as `CAPITAL`. That is caught only by per-module tests. |
| Can two agents oversubscribe one budget? | **No, given a compare-and-swap store** (CONC-1, examples §C). A store without CAS is not a conforming store. Separately, an agent holding an enforcement credential could act outside Core entirely (CRED-1). |
| Can pending actions remain reserved? | **Yes.** They stay reserved until a final observation. Quarantine keeps holding them, and neither time nor revocation releases them (examples §B). |
| Can partial fills reconcile correctly? | **Yes.** Fills are applied once each by id, consumption is capped at the reservation, excess is booked as overrun, and the remainder is released only at a final close ([reservations-reconciliation.md §9](reservations-reconciliation.md#9-worked-timeline-a-partial-fill-and-a-cancel)). The one thing Core cannot prevent is a late fill after an adapter's wrong finality claim: it is recorded as overrun plus conflict and freezes the adapter. |
| Can a stale venue observation release newer authority? | **No.** Other generations are refused first (RECON-2, examples §E). Within a generation, a lower-sequence status is ignored, a release needs a final observation at the adapter's level, and a contradiction after close is a conflict, not a release. |
| Can a child delegation widen authority? | **No.** It is refused at registration, and even if one were registered, the action-time meet bounds it by every ancestor (AUTH-2, examples §D). |
| Can one mandate govern two enforcement domains? | **Yes.** A root dimension with no domain scope is charged by every domain (examples §A and §B). Both adapters must be in the grant's adapter set and meet CRED-1. |
| Can state provenance and freshness be required? | **Yes.** Each state kind has a state policy, sources are configured with a trust class, and freshness is the consumer's bound. Stale, untrusted, conflicting and behind-ledger state are distinct rejections (STATE-1…3). |
| Can an agent bypass an enforcement adapter? | **Not by design, but this is a deployment property, not a Core property.** It holds exactly when the agent holds no credential the enforcement point accepts (CRED-1). For the EVM adapter it depends on open question 1. For any venue it depends on facts not yet established (open question 3). |
| Can receipts reconstruct why an action was authorized? | **Yes, if the referenced objects are retained.** The `DecisionReceipt` references every input by digest, and re-running `Authorize` reproduces the verdict (RECEIPT-2). Retention is open question 7. |
| Can future domains be added without modifying frozen Phase 6? | **Yes.** Core defines its own types, and Phase 6 appears only as the EVM enforcement point (PHASE6-1). What the EVM adapter can enforce is bounded by the frozen gate: fixture markets, FILL_OR_KILL, principal recipient, no ERC-1271. Going beyond that needs a new gate version, not an edit to Phase 6. |

No answer above is unconditional. Each condition is either an open question,
a TCB assumption stated in the linked document, or a per-adapter deployment
property.

## Provisional reason-code families

These families are named across the documents and will be finalized in 7B:

- **Action:** `MALFORMED_ACTION`, `ACTION_RESOURCES_MISMATCH`, `ACTION_NOT_COVERED`, `BOUND_EXCEEDED`, `ACTOR_NOT_HOLDER`
- **Authority:** `AUTHORITY_UNKNOWN`, `_SIGNATURE_INVALID`, `_ISSUER_MISMATCH`, `_PRINCIPAL_MISMATCH`, `_NOT_YET_VALID`, `_EXPIRED`, `_REVOKED`, `_DEPTH_EXCEEDED`
- **Delegation:** `DELEGATION_WIDENS_{SET,RIGHT,BOUND,WINDOW,LIMIT}`, `DELEGATION_DROPS_{BOUND,INVARIANT,STATE_POLICY}`, `DELEGATION_WEAKENS_{INVARIANT,STATE_POLICY}`, `DELEGATION_DEPTH_EXCEEDED`, `DELEGATION_TERM_INCOMPARABLE`
- **State:** `STATE_MISSING`, `STATE_SOURCE_NOT_ADMITTED`, `STATE_STALE`, `STATE_FROM_FUTURE`, `STATE_SEQUENCE_REGRESSED`, `STATE_BEHIND_LEDGER`, `STATE_CONFLICT`
- **Quantity:** `QUANTITY_KIND_MISMATCH`, `QUANTITY_UNIT_MISMATCH`, `EXPOSURE_ASSET_UNRESOLVED`
- **Ledger:** `LEDGER_LIMIT_EXCEEDED`, `UNBOUNDED_CONTRIBUTION`, `DIMENSION_BREACHED`, `DRIFT_DETECTED`
- **Invariant:** per invariant, plus `INVARIANT_UNKNOWN`
- **Reconciliation:** `STALE_RESERVATION_OBSERVATION`, `STALE_SEQUENCE`, `DUPLICATE`, `CONFLICT`, `OBSERVATION_INVALID`, `OBSERVATION_INCONSISTENT`
