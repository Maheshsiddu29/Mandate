# ADR 0018 — Observed execution outcomes as the only replay resolution

**Status:** accepted, Phase 5R.1
**Amends:** [ADR 0015](0015-replay-quarantine-and-reconciliation.md),
[replay-semantics.md](../replay-semantics.md)
**Closes:** post-remediation audit findings N-3, N-4, N-5, N-7

## Context

ADR 0015 established the rule the replay state machine rests on: **the passage of
time never restores an authorization**, only an observation does. A lapsed
reservation quarantines, and only `RECONCILE`, carrying the outcome it
established, leaves that state.

The independent post-remediation audit found that the code did not enforce the
rule it stated, in four distinct ways.

**N-5 — `RELEASE` restored permission on a bare command.** The documented rule was
that `RESERVED → UNUSED` via `RELEASE` happens "only when failure is observed".
Nothing in the API required, carried or recorded such an observation. A caller
that had observed nothing restored the authorization by naming a transition, and
the resulting record was indistinguishable from one restored on real evidence. The
quarantine path had been hardened against exactly this — and the reservation path,
which is the common one, had not.

**N-3 — an unrecognized reconciliation outcome defaulted to FAILED.** `RECONCILE`
compared its outcome against `SETTLED` and fell through to the restore path for
*everything else*. TypeScript's `ReconciledOutcome` is a union of string literals;
unions are erased at run time, so a value arriving from JSON, a database row or a
mistyped call site was just a string. `'settled'`, `'UNKNOWN'`, `''`, `0`, `{}`,
`null` and `undefined` all returned a quarantined authorization to `UNUSED` — the
single most dangerous transition in the system, reached by any value that was not
exactly `'SETTLED'`. The deliberate absence of an `UNKNOWN` member, which ADR 0015
argued for at length, was defeated by the absence of a runtime check.

**N-4 — `applyTransition` was not total.** It switched on a caller-controlled
string with no `default`. An unrecognized transition — including the `RECLAIM` that
ADR 0015 had removed — matched no case, fell out of the switch, and the function
returned `undefined` from a signature promising a `Result`. A caller doing
`if (!result.ok)` on `undefined` throws; one doing `result.ok` reads `undefined` as
falsy and may take either branch depending on how it was written.

**N-7 — `ReplayError.KEY_MISMATCH` was unreachable.** Nothing in the module
compared a record's key against anything. A security-shaped error code that cannot
fire asserts an invariant that is not enforced, which is worse than no code at
all: a reader, or an auditor, reasonably concludes key reconciliation happens.

## Decision

### 1. One transition applies an outcome, and it requires validated evidence

The vocabulary becomes **`RESERVE`, `QUARANTINE`, `RECONCILE`**. `COMMIT` and
`RELEASE` are removed.

`RECONCILE` is valid from `RESERVED` or `QUARANTINED` and requires an
`ExecutionObservation`:

```ts
interface ExecutionObservation {
  outcome: 'SETTLED' | 'FAILED';
  observedAtUnixSeconds: UnixSeconds;   // when
  sourceId: Identifier;                  // who observed it
  reference: Bytes32;                    // what was observed
}
```

`SETTLED → CONSUMED`, `FAILED → UNUSED`. Nothing else moves a record out of
`RESERVED` or `QUARANTINED`.

Collapsing three transitions into one is the answer to the audit's question about
whether `RELEASE` becomes redundant with a validated `FAILED` outcome. It does —
and so does `COMMIT` with a validated `SETTLED` one. Keeping either would mean
maintaining two paths to the same state with different evidentiary standards,
which is the inconsistency the finding pointed at. The state machine is strictly
smaller afterwards:

```
                RESERVE                    RECONCILE(SETTLED, evidence)
     UNUSED ──────────────▶ RESERVED ──────────────────────────▶ CONSUMED
       ▲                      │  │                                  ▲
       │  RECONCILE(FAILED,   │  │  QUARANTINE                      │
       │   evidence)          │  │  (reservation lapsed,            │
       └──────────────────────┘  │   outcome unestablished)         │
       ▲                         ▼                                  │
       │                    QUARANTINED ────────────────────────────┘
       │                         │      RECONCILE(SETTLED, evidence)
       └─────────────────────────┘
          RECONCILE(FAILED, evidence)

     UNKNOWN ── not a state to transition from; it must be established first
```

### 2. Evidence is validated, and recorded on the record

`parseExecutionObservation` requires every field, defaults nothing, and refuses
unknown fields — a caller sending a shape this kernel does not understand has not
established what it thinks it has. `parseReconciledOutcome` matches `'SETTLED'` and
`'FAILED'` exactly, via `hasOwnProperty` so inherited names like `'toString'` and
`'constructor'` do not resolve.

The accepted observation is stored on the resulting record as `resolution`. A
`CONSUMED` or `UNUSED` record carrying `null` was not resolved by an observation,
so an unsubstantiated restore is visible in the store afterwards rather than
indistinguishable from a substantiated one.

**This is a validated assertion, not a proof.** Confirming that `reference` really
settled needs chain observation, which is Phase 6. What this decision buys now is
that the assertion must be complete, attributed, attached to a specific reference,
and recorded. Whatever performs a `RECONCILE` remains inside the trusted computing
base alongside the replay store, as ADR 0015 already stated.

### 3. `applyTransition` is total over plain values

Every caller-controlled field is parsed before any branch is taken: the transition
name (`parseReplayTransition`), the record's status, key and timestamps
(`MALFORMED_RECORD` otherwise), the instant, and the observation. The switch runs
over the *parsed* union and ends in a `never`-typed default, so adding a future
member without a case is a compile error rather than a silent fall-through.

`RETIRED_REPLAY_TRANSITIONS` — `RECLAIM`, `COMMIT`, `RELEASE` — is exported as
data, so their refusal with `UNKNOWN_TRANSITION` is a named, tested behaviour
rather than an accident of a switch statement. An integrator upgrading across this
change gets a typed error from a total function.

The totality claim here is scoped as the verifier's is (V-2): it covers parsed,
plain values — what `JSON.parse` can produce, plus the kernel's own value types. It
is not a defence against a hostile host object whose getters throw.

### 4. `KEY_MISMATCH` is removed

Key reconciliation — checking that a stored record's key is the key being
transitioned — belongs to the persistence layer that does the lookup, which is
Phase 6. The code is removed rather than left as a promise, and
`replay-semantics.md` names the obligation as the integrator's.

The error set is also made reachable-by-construction: a test asserts that every
member of `ReplayError` is produced by some call, so dead security-looking surface
cannot accumulate again.

## Consequences

**An unsubstantiated command cannot restore an authorization.** This is the
property the finding asked for, and it now holds on the reservation path as well
as the quarantine path.

**No branch defaults to FAILED.** Seventeen hostile outcome values are tested
explicitly — `'UNKNOWN'`, case variants, whitespace variants, `null`, `undefined`,
`0`, `''`, `{}`, `[]`, an arbitrary string, booleans and prototype property names —
and each leaves the authorization unavailable.

**`COMMIT` disappears from the integrator-facing vocabulary.** The happy path is
now `RESERVE → RECONCILE(SETTLED, evidence)`. This is a breaking API change and is
the point: the happy path previously asserted settlement with no evidence, which is
the same defect as `RELEASE` in the direction that is merely wrong rather than
dangerous.

**The liveness cost is unchanged.** An attempt that cannot establish its outcome
still cannot resolve its record, and the authorization stays unavailable until
someone observes what happened. ADR 0015 accepted that trade; nothing here
loosens it.

**Reconciliation is still not built.** It needs chain observation. What Phase 5R.1
guarantees is that its absence fails closed *and* that its presence must be
substantiated — previously only the first was true.
