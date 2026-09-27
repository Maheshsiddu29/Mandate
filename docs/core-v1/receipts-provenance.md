# Mandate Core v1 — Receipts and authority provenance

> **Status: Phase 7A specification, DRAFT pending review. Not implemented.**
> Receipts extend the kernel's `VerificationReceipt` and the gate's
> `MandateExecuted` evidence; neither is changed. Implementation is Phase 7H.

## Contents

1. [Principles](#1-principles)
2. [Receipt kinds](#2-receipt-kinds)
3. [Common header and chaining](#3-common-header-and-chaining)
4. [Schemas](#4-schemas)
5. [The questions a receipt answers](#5-the-questions-a-receipt-answers)
6. [Reproducibility](#6-reproducibility)
7. [Provenance](#7-provenance)
8. [Relation to Phase 6 evidence](#8-relation-to-phase-6-evidence)
9. [What receipts are not](#9-what-receipts-are-not)

---

## 1. Principles

- **Every decision and every ledger transition leaves a receipt**, refusals
  included ([design §15.1](../mandate-design.md#151-the-execution-receipt)).
- **Digests and identifiers, not payloads.** A receipt names grants by
  `AuthorityId`, state by `StateDigest`, actions by `ActionDigest`, evidence by
  transaction hash and log index or venue event id. It does not embed order
  books, account dumps or raw venue responses. The referenced objects are kept
  in a content-addressed store keyed by those digests.
- **Enough structure to read without decoding.** Reason codes, typed
  quantities for every requested, available, reserved, consumed and released
  amount, and the node and dimension each applies to — so a developer can see
  why something happened without replaying it.
- **Canonical and attestable later.** Canonical encoding, stable digests, no
  dependence on mutable external references
  ([design §15.4](../mandate-design.md#154-attestations)).
- **Bounded.** Every list in a receipt has a declared bound, enforced at parse,
  as every counted collection in the kernel does.

## 2. Receipt kinds

| Kind | Emitted at | Chained to |
| --- | --- | --- |
| `GrantReceipt` | `REGISTER_GRANT`, accepted or refused | the principal's ledger chain |
| `RevocationReceipt` | `REVOKE` | the principal's ledger chain |
| `DecisionReceipt` | every authorization decision, PASS or REJECT | the ledger chain; on PASS, starts the reservation's chain |
| `TransitionReceipt` | `ADMIT_ATTEMPT`, every applied or refused observation, `QUARANTINE`, `ADJUST` | the previous receipt of the same reservation |
| `CloseReceipt` | `CLOSE` | the previous receipt of the same reservation |

Refused observations (`STALE_RESERVATION_OBSERVATION`, `CONFLICT`,
`OBSERVATION_INVALID`) are receipted too: "who tried to restore this
authority, on what evidence, and why it was refused" must be answerable from the
store, which is the property
[replay-semantics.md §9](../replay-semantics.md#9-what-an-operator-has-to-do)
established for the kernel.

## 3. Common header and chaining

```text
ReceiptHeader {
  kind, version
  coreVersion                  Core rules version
  principal                    PartyId
  ledgerBefore                 { version, headDigest }
  ledgerAfter                  { version, headDigest } | NONE for a decision that wrote nothing
  previousReceipt              ReceiptDigest | NONE      same reservation (or same node, for grant events)
  evaluatedAt                  UnixSeconds               the decision's t, a parameter
}
ReceiptDigest = H("mandate-core/v1/receipt/" ‖ kind, receipt)
```

A reservation's receipts form a hash chain from its `DecisionReceipt` to its
`CloseReceipt`. Every receipt that wrote to the ledger names the version and head
digest before and after, so the receipt chain and the ledger's own hash chain
anchor each other: a receipt cannot be re-ordered or omitted without breaking
one of them.

## 4. Schemas

### DecisionReceipt

```text
DecisionReceipt {
  header
  action          { actionDigest, actor, principal, authority, domain, actionType,
                    adapter, target, resources, validFrom, expiresAt }
  lineage         list<AuthorityId>, leaf to root
  effective       digest of the computed effective authority (the meet)
  domainModule    { id, version }
  state           list<{ stateDigest, sourceId, trustClass, observedAt, sequence }>
  pending         { ledgerVersion, pendingSetDigest }
  coverage        list<{ term, outcome, reasonCode }>                       failures only on PASS: none
  invariants      list<InvariantResult>
  contributions   list<Contribution>                                        typed worst case
  availability    list<{ node, dimensionId, requested, available, limit, outcome }>
  decision        PASS | REJECT
  reasonCodes     sorted, deduplicated
  reservation     { reservationId, generation, attemptCeiling } | NONE
  authorizationId                                                           | NONE
}
```

### TransitionReceipt

```text
TransitionReceipt {
  header
  reservationId, generation
  transition      ADMIT_ATTEMPT | APPLY | QUARANTINE | ADJUST
  attempt         { attemptId, bindingDigest, validUntil }                  | NONE
  observation     { observationId, sourceId, eventId, sequence, observedAt,
                    finality, status, executed, evidence refs }              | NONE
  outcome         APPLIED | DUPLICATE | STALE_RESERVATION_OBSERVATION | STALE_SEQUENCE
                  | CONFLICT | OBSERVATION_INVALID | OBSERVATION_INCONSISTENT
  legDeltas       list<{ node, dimensionId, consumed, overrun, restored }>  typed
  remaining       list<{ node, dimensionId, available, limit }>             for every touched (node, dimension)
}
```

### CloseReceipt

```text
CloseReceipt {
  header
  reservationId, generation, actionDigest
  final           { status, executed, basis, observationId }
  legs            list<{ node, dimensionId, reserved, consumed, overrun, released }>
  intentStatus    SPENT | UNUSED
  flags           OVERRUN, CONFLICT
  remaining       list<{ node, dimensionId, available, limit }>             every lineage node, every touched dimension
}
```

## 5. The questions a receipt answers

| Question | Answered by |
| --- | --- |
| Who authorized this? | `DecisionReceipt.lineage` → root `GrantReceipt` → the principal and its signature |
| Under what mandate? | the root `AuthorityId` (`MandateId`) and every `DelegationId` on the lineage |
| Which agent proposed it? | `action.actor`, whose signature over `actionDigest` is kept with the intent |
| Which economic state was used? | `state` (snapshot digests, sources, trust classes, times) and `pending` (the ledger version whose reservations were projected) |
| Which invariants were checked? | `invariants`, each with observed value, bound and inputs |
| What authority was reserved? | `contributions`, `availability` and `reservation` |
| What exact execution was permitted? | `TransitionReceipt(ADMIT_ATTEMPT).attempt.bindingDigest` → the `ExecutionBinding` |
| What actually happened? | the `TransitionReceipt(APPLY)` chain and `CloseReceipt.final`, with evidence references |
| What authority was consumed? | `CloseReceipt.legs` |
| What remains? | `CloseReceipt.remaining` |

## 6. Reproducibility

**RECEIPT-2: re-running `Authorize` over the objects a `DecisionReceipt`
references — the intent, the grants, the admitted snapshots, the ledger at
`ledgerBefore.version`, `evaluatedAt`, the Core and domain-module versions —
produces the same decision, the same reason codes and the same reservation.**
This is [INV-11](../mandate-design.md#16-major-invariants) carried to Core. A
receipt whose decision cannot be reproduced from its own references indicates a
non-deterministic rule or an incomplete receipt; both are defects.

Reproducibility therefore depends on the content-addressed store retaining the
referenced objects. How long, and whether a principal can require it, is an open
question for 7H.

## 7. Provenance

Three provenance chains meet in a receipt:

- **Authority provenance** — the lineage of `AuthorityId`s, each a signed grant
  whose issuer is its parent's holder, ending at the principal. Revocations that
  were checked are identified by the ledger version at which the lineage was
  valid.
- **State provenance** — every snapshot's source, trust class, observation time
  and sequence, and the admission policy that accepted it.
- **Execution provenance** — every observation's source, event id, finality level
  and evidence reference (for the EVM adapter: transaction hash, log index and
  the gate's `MandateExecuted` fields).

## 8. Relation to Phase 6 evidence

Under the EVM adapter, a Core receipt references, without changing, the Phase 6
artifacts:

- the kernel's `VerificationReceipt` digest for `M_g`'s handoff verification;
- `M_g`'s MCE v2 digest, the Candidate V3 digest and the execution commitment;
- the `MandateExecuted` log (transaction hash, log index) that
  `observationFromGateEvidence` read.

## 9. What receipts are not

- **Not authentication.** A receipt digest is a commitment for audit, as the
  kernel's `receiptDigest` is; it proves nothing about who produced it.
- **Not attestations.** Signed, independently verifiable attestations are
  deferred ([design §15.4](../mandate-design.md#154-attestations)); receipts are
  designed so that signing them later requires no schema change.
- **Not a place for secrets or personal data.** Receipts may be shared with
  auditors and counterparties; they contain identifiers, digests, typed
  quantities and reason codes only.
