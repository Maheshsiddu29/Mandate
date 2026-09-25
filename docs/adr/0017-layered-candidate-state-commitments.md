# ADR 0017 — Layered candidate state commitments

**Status:** accepted, Phase 5R.1
**Amends:** [ADR 0014](0014-symmetric-signed-economic-authorization.md) (candidate
schema), [ADR 0016](0016-pipeline-time-and-handoff-freshness.md) (handoff
semantics), [verifier-invariants.md](../verifier-invariants.md) V-39
**Closes:** post-remediation audit findings N-1 and N-8

## Context

ADR 0014 added `referenceStateDigest` to the execution candidate, and
`checkStateBinding` required it to equal the digest `verify` computed over the
trusted state it was handed. The reasoning was sound as far as it went: a
candidate had previously been bound to `referenceStateId`, a caller-chosen label,
so two materially different states could satisfy one candidate's binding
(pressure-test finding F-8). Binding to content rather than to a name is the right
instinct.

It was the wrong cure, and the independent post-remediation audit found why
(N-1). A trusted-state digest covers **every** field of the state, including each
input's `observedAtUnixSeconds`. So *any* fresh observation changes it. And ADR
0016 had, in the same phase, made the execution-handoff re-verification read
**fresh** state by construction — that was the entire point of it, because
re-verifying against the evaluation state is a tautology for a deterministic
verifier.

The two decisions were mutually exclusive. Their intersection was:

- a handoff against genuinely fresh state **always** failed, with
  `CANDIDATE_STATE_MISMATCH`, regardless of whether anything unsafe had happened;
- the only handoff that could succeed was one replaying the evaluation state,
  which is the tautology ADR 0016 existed to remove;
- the handoff regression tests asserted `NO_VALID_ROUTE` and passed — on the
  accidental failure, not the intended one (finding N-2).

The defect is a category error, not an off-by-one. Three different kinds of fact
had been collapsed into one digest and one rule:

1. **Provenance** — which observed world this candidate was constructed against.
   Needed for audit and reproduction. Meaningless as a predicate about the world
   *now*, because the verifier sees one instant per call and cannot know whether
   it is the evaluation or the re-verification.
2. **Structural authority** — which registry snapshot established the
   representation set. Does not refresh. A different snapshot can retire a
   representation, reassign an issuer or move a contract.
3. **Dynamic facts** — price, halt status, freshness, corporate-action epoch,
   replay status, trust class. Refresh constantly, and the whole reason for a
   second verification is to read them again.

Requiring byte equality is right for (2), wrong for (1), and actively defeats the
purpose for (3).

There is a second consequence the audit named separately (N-8). The whole-state
digest covered `TrustedState.registrySnapshotDigest` *incidentally*, which is why
the router was able to treat the registry binding as opt-in — accepting a state
that declared no snapshot at all. Removing whole-state equality removes that
incidental cover, so the registry binding has to become explicit or it disappears.

## Decision

### 1. Candidate schema v3 carries three distinct commitments

`referenceStateId` and `referenceStateDigest` are replaced by:

| Field | Kind | Rule |
| --- | --- | --- |
| `evaluationStateId` | Provenance | Committed. Never compared. |
| `evaluationStateDigest` | Provenance | Committed. Never compared. |
| `registrySnapshotDigest` | Structural authority | Committed **and** compared for equality. |

The names are deliberate. `referenceStateDigest` did not say what authority it
carried, which is part of how one field came to be used for three purposes.

Dynamic facts are not commitments at all. They are re-evaluated by the check that
owns each one: `checkPriceDeviation`, `checkPriceFreshness`, `checkHalt`,
`checkCorporateAction`, `checkReplay`, `checkRepresentation`,
`checkRepresentationChain` and `checkTrustLevels`. Nothing left the verifier's
scope; enforcement moved from *"these bytes must be identical"* to *"these
predicates must still hold"*.

`CANDIDATE_STATE_MISMATCH` survives, meaning exactly what its developer message
always said and nothing more: the candidate's committed corporate-action epoch
disagrees with the observed one.

### 2. The registry snapshot binding is explicit, and absence fails closed

`checkRegistrySnapshotBinding` replaces `checkStateBinding`:

- state declares no snapshot → `REGISTRY_SNAPSHOT_UNKNOWN`;
- state declares a different snapshot → `REGISTRY_SNAPSHOT_MISMATCH`;
- equal → pass.

Two new kernel reason codes, `MND-STATE-009` and `MND-STATE-010`. The router
previously carried a `REGISTRY_SNAPSHOT_MISMATCH` string literal with no
definition behind it, so a routing refusal named a code an integrator could not
look up; it now uses the kernel's.

The kernel still never *interprets* the digest — it has no registry types, per
ADR 0003. It compares it.

### 3. The router enforces the binding at both stages

`evaluateRoutes` already compared the evaluation state's declaration against the
registry it evaluated; that comparison is no longer opt-in, because an undeclared
snapshot is now an unestablished binding rather than one covered incidentally.

`resolveHandoff` gains the same comparison against the handoff state. It now
enforces two pipeline invariants rather than one: time does not run backwards, and
**the registry snapshot does not change under an already-ranked candidate**. A
changed snapshot is a routing-level refusal, not one rejected candidate, because
the admissible *set* was computed against the old snapshot — every ranking
position is suspect, not just the winner's.

### 4. No cross-snapshot compatibility proof, in this phase

If the snapshot changes between evaluation and handoff, the call fails closed and
the caller reroutes against the current snapshot. A compatibility proof — evidence
that the specific entries a candidate depends on are unchanged across two
snapshots — is a defensible alternative and is not built. `resolveHandoff` is
where it would go.

### 5. The version change is explicit

`CANDIDATE_SCHEMA_VERSION` is 3 and the MCE domain tag is
`MANDATE.CANDIDATE.V3`. A v2 candidate does not parse, and a v2 encoding does not
decode, so an integrator on the old schema gets a typed refusal rather than a
misread candidate. Wire semantics are not changed silently.

`ProviderRouteQuote.referenceStateId` keeps its name and its schema version. It is
an untrusted provider claim about which snapshot was quoted against, compared at
the router against the evaluation state — where "reference state" is accurate. It
is not a commitment.

## Consequences

**A safe refresh can now succeed.** A handoff state differing only in observation
timestamps, still satisfying every predicate, hands off. This was impossible
before and is now a test that fails if it regresses.

**An unsafe change rejects for the actual reason.** A halt reports
`TRADING_HALTED`, an expiry `MANDATE_EXPIRED`, a moved price
`PRICE_DEVIATION_EXCEEDED`. An operator reading the receipt learns what happened
instead of "the state changed".

**The handoff re-verification is load-bearing for the first time.** It was
previously a tautology (ADR 0016's finding) and then a guaranteed failure (this
one). It is now a real predicate over real fresh state.

**F-8's original property is preserved by different means.** Two states sharing
one `stateId` are still told apart — by the predicates over their content rather
than by a digest comparison. The label still establishes nothing.

**Every trusted state must declare its registry snapshot.** This is a real
tightening, and it is a breaking change for any adapter that emitted a state
without one. The kernel's own rule applies: unestablished provenance is UNKNOWN,
and UNKNOWN rejects. Accepting it would mean the structural binding silently does
not exist.

**The whole-state digest is still computed and still reported.** `verify` puts
`trustedStateDigest` in every receipt, and the routing receipt carries the
evaluation state digest and the handoff state digest separately. Nothing became
less auditable; one digest stopped being a predicate it could not correctly be.

**A dynamic fact with no check is now unbound.** Under whole-state equality, a
state field nobody checked was still covered by accident. That accident is gone,
so adding a security-relevant field to `TrustedState` now requires adding the
check that reads it. This is the cost of the change, and it is the honest
direction: a fact covered only by a digest comparison was never actually being
*evaluated*, only frozen.

## Commitment hierarchy after this decision

```
signed mandate digest                keccak256(MCE(mandate)), signed under EIP-712
  └─ candidate digest                keccak256(MCE(candidate)) — every execution
     │                               field, the fee total, both provenance fields
     │                               and the registry snapshot digest
     ├─ evaluation-state provenance   committed, audited, never a predicate
     └─ structural authority          committed and compared for equality
  └─ routing candidate digest        the kernel candidate digest, plus route
     │                               identity, reference observation, trusted cost
     │                               source and fee total
     └─ routing receipt digest       mandate, registry snapshot, evaluation state,
                                     every outcome, the ranking, the selected
                                     candidate, the handoff state and instant, and
                                     the final re-verification receipt digest
```

Tested in `kernel/test/commitment.test.ts` and
`router/test/commitment-hierarchy.test.ts`. The candidate-field half is driven off
the exported `CANDIDATE_FIELDS`, so a field added without a mutation case fails
rather than escaping commitment silently.
