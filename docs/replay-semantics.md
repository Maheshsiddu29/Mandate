# Replay semantics

How a mandate is consumed, what "consumed" means, and what Phase 1 deliberately
does not decide.

> **Status: Phase 5R, implemented.** The state machine is in
> `packages/kernel/src/replay.ts`; the verifier's read of replay state is in
> `packages/kernel/src/verifier/checks.ts`. Invariant:
> [INV-12](mandate-design.md#16-major-invariants).
>
> **Corrected in Phase 5R.** Until then this document described a fail-closed
> property the code did not implement: `RECLAIM` returned a lapsed reservation
> to `UNUSED` while the authorization was still live, so a timer did what
> `RELEASE` is forbidden from doing. `RECLAIM` is replaced by `QUARANTINE` and
> `RECONCILE` ([ADR 0015](adr/0015-replay-quarantine-and-reconciliation.md)).
> The original finding is F-1 in
> [the architecture pressure test](production-architecture-pressure-test.md).

## 1. Pure verification and stateful consumption are separate

The verifier is pure ([design §10.1](mandate-design.md#101-the-contract)). It
never mutates anything and never consults a store. Replay state reaches it as an
explicit, provenance-carrying input, exactly like market state:

```
verify(mandate, authorization, candidate, trustedState, clock, expectedDomain)
                                     │
                                     └── trustedState.replay : Observed<ReplayState>
```

Consumption is a separate, stateful step the caller performs. The kernel defines
the *rules* as pure transitions so they are testable and reproducible; the
*store* lives outside the kernel and may be a database, a chain, or a file.

This split is why the kernel can be used by a simulator, a replay harness and a
live executor without a second "simulation verifier".

## 2. Mandate identity, nonce, and the replay key

Three distinct things, often confused:

| Concept | What it is | What it is for |
| --- | --- | --- |
| `mandateId` | An opaque 32-byte caller-chosen label | Human and system reference; correlation in logs and tickets |
| `nonce` | A `uint64` inside the mandate | Lets a principal author two otherwise-identical mandates that are independently spendable |
| **replay key** | **`keccak256(MCE(mandate))` — the mandate digest** | **The only thing consumption is keyed on** |

**The replay key is the mandate digest.** Since the digest covers every field,
including the nonce:

- two mandates differing only in nonce have different keys, so a principal can
  deliberately authorize the same trade twice;
- changing *any* term produces a different key, so an amended mandate cannot
  reuse a spent one's consumption record;
- the key is stable across authorization schemes, because the digest is
  chain-agnostic (ADR 0001).

Two alternatives were rejected:

- **Keying on `mandateId`.** A principal could reissue the same id with
  different terms and ride a previous authorization's record — or, worse, an id
  collision between two principals would make one spend the other's.
- **Keying on `nonce` alone.** Nonces collide across principals.

## 3. Single-use

**A mandate is single-use.** One mandate authorizes at most one
execution.

Reusable envelopes — one signed authorization spendable N times, or up to a
cumulative notional — are not modelled. They need per-execution accounting the
verifier would have to read and a caller would have to keep correct, and they
turn a bounded authorization into a standing one. Design
[§21.1](mandate-design.md#211-not-built) lists portfolio-level mandates as
out of scope, and this is the same boundary.

## 4. The state machine

```
                RESERVE                     COMMIT (settlement observed)
     UNUSED ──────────────▶ RESERVED ──────────────────────▶ CONSUMED
       ▲                      │  │                              ▲
       │  RELEASE             │  │  QUARANTINE                  │
       │  (failure observed)  │  │  (reservation expired,       │
       └──────────────────────┘  │   outcome unestablished)     │
       ▲                         ▼                              │
       │                    QUARANTINED ────────────────────────┘
       │                         │        RECONCILE(SETTLED)
       └─────────────────────────┘
            RECONCILE(FAILED)

     UNKNOWN ── not a state to transition from; it must be established first
```

| Status | Verifier verdict | Meaning |
| --- | --- | --- |
| `UNUSED` | permits | Available |
| `RESERVED` | `MANDATE_RESERVED` | An in-flight attempt holds it |
| `CONSUMED` | `MANDATE_ALREADY_CONSUMED` | Spent. Terminal |
| `QUARANTINED` | `MANDATE_QUARANTINED` | An attempt lapsed with its outcome unestablished. Unavailable until reconciled |
| `UNKNOWN` | `REPLAY_STATE_UNKNOWN` | Could not be established. Fails closed |

`QUARANTINED` is distinct from `RESERVED` because the operational response
differs: a reservation resolves itself, a quarantine needs someone to go and
look. `isAvailable(record)` is exported so a caller cannot treat a quarantine as
usable by testing for anything other than `CONSUMED`.

A replay record whose `mandateDigest` is not the mandate being verified is
treated as `REPLAY_STATE_UNKNOWN`, not as `UNUSED`: a record about some other
mandate establishes nothing about this one.

## 5. When consumption occurs

**Reserve before signing; commit after settlement is observed.**

```
verify ──▶ PASS ──▶ RESERVE ──▶ sign ──▶ submit ──▶ observe ──▶ COMMIT
                        │                              │
                        │                              └── failure ──▶ RELEASE
                        └── never resolves ──▶ reservation expires ──▶ QUARANTINE
                                                                          │
                                                        reconciliation ──▶ RECONCILE
```

Reserving *before* signing is the conservative order. Two concurrent attempts
under one mandate cannot both reserve, so only one reaches a signature. The
alternative — consume after settlement — leaves a window in which two attempts
both verify, both sign and both submit.

The cost of this order is that an attempt which dies between reserve and commit
leaves the mandate reserved. That is the correct failure: the mandate is
unavailable until the reservation expires, which is a liveness cost, not a
safety one.

## 6. Retry after a failed execution

| What happened | Correct transition | Result |
| --- | --- | --- |
| Verification rejected | none — nothing was reserved | Mandate stays `UNUSED`; fix and retry |
| Reserved, then the transaction was **observed to fail** | `RELEASE` | Back to `UNUSED`; retry permitted |
| Reserved, then settlement **observed to succeed** | `COMMIT` | `CONSUMED`; no retry |
| Reserved, outcome **never established** | `QUARANTINE` once the reservation lapses | `QUARANTINED`; unavailable until reconciliation establishes the outcome |
| Quarantined, reconciliation **observed settlement** | `RECONCILE(SETTLED)` | `CONSUMED`; no retry |
| Quarantined, reconciliation **observed failure** | `RECONCILE(FAILED)` | Back to `UNUSED`; retry permitted |
| Quarantined, reconciliation **could not establish the outcome** | none | Stays `QUARANTINED` |

The fourth row is the important one, and it is where this document was wrong
before Phase 5R. `RELEASE` requires *observing* failure: an attempt that cannot
tell whether its transaction landed must not release, because releasing a
mandate whose transaction later settles authorizes a second execution of an
already-executed trade.

The old text then claimed that waiting for the reservation to expire was the
fail-closed alternative, on the grounds that the reservation was clamped to the
mandate's own expiry. **The clamp was one-directional.** `applyTransition`
lowered a reservation to the mandate expiry and never raised it, so a caller
choosing a 300-second hold against an hour of remaining validity got a `RECLAIM`
at t+301 that returned the authorization to `UNUSED` with 3 299 seconds left —
doing by timer exactly what `RELEASE` was forbidden from doing by observation. A
crash and a short hold were enough; no adversary was required.

So a lapsed reservation now **quarantines**. The passage of time marks an
authorization as needing attention; it never decides what happened.
`ReconciledOutcome` has no `UNKNOWN` member, because an enum value meaning
"still don't know" would be a place for a caller to launder uncertainty into a
decision — a reconciliation that establishes nothing applies no transition at
all.

The cost is a real liveness one: an unresolved crash holds the authorization
until someone reconciles it. That is the same trade the reserve-before-signing
order already makes, and it is the correct direction for a safety control.

**Reconciliation itself is not built.** It needs chain observation, which is
Phase 6. What Phase 5R guarantees is that its absence fails closed: with no
reconciliation, a quarantined authorization simply stays unavailable.

## 7. Partial execution

**Not solved, and deliberately so.**

The current phases assume atomic settlement
([design §14.2](mandate-design.md#142-mvp-settlement-model)): an execution
either completes or reverts. Under that assumption a mandate is consumed or it
is not, and there is no third outcome to model.

Partial fills break the assumption and need a residual-authority model — how
much of the mandate remains spendable, whether the remainder is still within the
principal's intent, and whether a partially-filled authorization should be
reusable at all. That belongs with settlement abstraction
([design §14.4](mandate-design.md#144-settlement-abstraction)), which is
`FUTURE`. Deciding it here, before the execution gate exists, would be guessing.

What the kernel does guarantee is that the guess is not made implicitly: there is
no code path that treats a partial outcome as either success or failure, because
`COMMIT` and `RELEASE` both require an observation the caller does not yet have
a way to make wrongly.

## 8. What the kernel does not do

- It does not store anything. `applyTransition` is a pure function over a
  record.
- It does not read a clock. `nowUnixSeconds` is a parameter.
- It does not decide reservation length. The caller does, and the kernel clamps
  it down to the mandate expiry. Since Phase 5R the length no longer affects
  safety, only how soon an unresolved attempt is flagged for reconciliation:
  a lapsed reservation quarantines rather than releasing.
- It does not resolve concurrency. Two callers racing to `RESERVE` must be
  serialized by the store; the kernel makes the second transition invalid, but
  only an atomic store makes that observable.

That last point is the one an integrator most needs to read: **the replay store
must apply transitions atomically.** A read-then-write store with no
compare-and-swap will permit a double reserve, and the kernel cannot detect it.

## 9. What an operator has to do

Quarantined records accumulate and need somewhere to go. This is a real
operational obligation the previous design hid, because the previous design
cleared them silently — and unsafely.

- **Alert on quarantine depth, not just on rate.** Each quarantined record is an
  authorization whose transaction may or may not have executed.
- **Reconciliation is chain observation**, so it arrives with Phase 6. Until
  then a quarantined mandate stays unavailable and the principal reauthorizes if
  they still want the trade. That is fail-closed and it is also inconvenient,
  which is the honest description.
- **A `RECONCILE` is an assertion about the world.** Whatever performs it is as
  trusted as the replay store itself, and belongs in the trusted computing base
  alongside it.
