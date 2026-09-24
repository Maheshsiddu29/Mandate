# Replay semantics

How a mandate is consumed, what "consumed" means, and what Phase 1 deliberately
does not decide.

> **Status: Phase 1, implemented.** The state machine is in
> `packages/kernel/src/replay.ts`; the verifier's read of replay state is in
> `packages/kernel/src/verifier/checks.ts`. Invariant:
> [INV-12](mandate-design.md#16-major-invariants).

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

**A Phase 1 mandate is single-use.** One mandate authorizes at most one
execution.

Reusable envelopes — one signed authorization spendable N times, or up to a
cumulative notional — are not modelled. They need per-execution accounting the
verifier would have to read and a caller would have to keep correct, and they
turn a bounded authorization into a standing one. Design
[§21.1](mandate-design.md#211-not-built) lists portfolio-level mandates as
out of scope, and this is the same boundary.

## 4. The state machine

```
                  RESERVE (before signing)
      UNUSED ──────────────────────────────▶ RESERVED
        ▲                                     │    │
        │  RELEASE (failure observed)         │    │ COMMIT (settlement observed)
        ├─────────────────────────────────────┘    │
        │                                          ▼
        │  RECLAIM (reservation expired)        CONSUMED  ── terminal
        └──────────────────────────────────────────

      UNKNOWN ── not a state to transition from; it must be established first
```

| Status | Verifier verdict | Meaning |
| --- | --- | --- |
| `UNUSED` | permits | Available |
| `RESERVED` | `MANDATE_RESERVED` | An in-flight attempt holds it |
| `CONSUMED` | `MANDATE_ALREADY_CONSUMED` | Spent. Terminal |
| `UNKNOWN` | `REPLAY_STATE_UNKNOWN` | Could not be established. Fails closed |

A replay record whose `mandateDigest` is not the mandate being verified is
treated as `REPLAY_STATE_UNKNOWN`, not as `UNUSED`: a record about some other
mandate establishes nothing about this one.

## 5. When consumption occurs

**Reserve before signing; commit after settlement is observed.**

```
verify ──▶ PASS ──▶ RESERVE ──▶ sign ──▶ submit ──▶ observe ──▶ COMMIT
                        │                              │
                        │                              └── failure ──▶ RELEASE
                        └── never resolves ──▶ reservation expires ──▶ RECLAIM
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
| Reserved, outcome **never established** | none available | Stays `RESERVED` until the reservation expires, then `RECLAIM` |

The third row is the important one. `RELEASE` requires *observing* failure. An
attempt that cannot tell whether its transaction landed must not release, because
releasing a mandate whose transaction later settles authorizes a second
execution of an already-executed trade. Waiting for the reservation to expire is
the fail-closed choice, and the reservation is clamped to the mandate's own
expiry so nothing is held past the point where the authorization is dead anyway.

## 7. Partial execution

**Not solved in Phase 1, and deliberately so.**

Phase 1 assumes atomic settlement
([design §14.2](mandate-design.md#142-mvp-settlement-model)): an execution
either completes or reverts. Under that assumption a mandate is consumed or it
is not, and there is no third outcome to model.

Partial fills break the assumption and need a residual-authority model — how
much of the mandate remains spendable, whether the remainder is still within the
principal's intent, and whether a partially-filled authorization should be
reusable at all. That belongs with settlement abstraction
([design §14.4](mandate-design.md#144-settlement-abstraction)), which is
`FUTURE`. Deciding it here, before the execution gate exists, would be guessing.

What Phase 1 does guarantee is that the guess is not made implicitly: there is
no code path that treats a partial outcome as either success or failure, because
`COMMIT` and `RELEASE` both require an observation the caller does not yet have
a way to make wrongly.

## 8. What the kernel does not do

- It does not store anything. `applyTransition` is a pure function over a
  record.
- It does not read a clock. `nowUnixSeconds` is a parameter.
- It does not decide reservation length. The caller does, and the kernel clamps
  it to the mandate expiry.
- It does not resolve concurrency. Two callers racing to `RESERVE` must be
  serialized by the store; the kernel makes the second transition invalid, but
  only an atomic store makes that observable.

That last point is the one an integrator most needs to read: **the replay store
must apply transitions atomically.** A read-then-write store with no
compare-and-swap will permit a double reserve, and the kernel cannot detect it.
