# ADR 0015 — Replay quarantine and reconciliation

**Status:** accepted, Phase 5R
**Amends:** [replay-semantics.md](../replay-semantics.md)

## Context

The Phase 5 architecture pressure test found the most serious defect in the
repository on the replay path (finding F-1).

`replay-semantics.md` §6 stated the safety rule correctly:

> `RELEASE` requires *observing* failure. An attempt that cannot tell whether its
> transaction landed must not release, because releasing a mandate whose
> transaction later settles authorizes a second execution of an already-executed
> trade.

It then described the fail-closed alternative, and that description was false:

> Waiting for the reservation to expire is the fail-closed choice, and the
> reservation is clamped to the mandate's own expiry so nothing is held past the
> point where the authorization is dead anyway.

The clamp was one-directional. `applyTransition` lowered a reservation to the
mandate's expiry and never raised it, so a caller choosing any hold shorter than
the mandate's remaining validity — 300 seconds against an hour, say — got a
`RECLAIM` at t+301 that returned the authorization to `UNUSED` with 3 299 seconds
of validity left. `RECLAIM` therefore did by timer exactly what `RELEASE` was
forbidden from doing by observation.

The window opens under ordinary operation. A process crash plus a short hold is
enough; no adversary is required.

## Decision

**The passage of time never restores permission. Only an observation does.**

A fifth replay status, and two transitions replacing `RECLAIM`:

```
                RESERVE                     COMMIT (settlement observed)
     UNUSED ──────────────▶ RESERVED ──────────────────────▶ CONSUMED
       ▲                      │  │                              ▲
       │  RELEASE             │  │  QUARANTINE                  │
       │  (failure observed)  │  │  (reservation expired,       │
       └──────────────────────┘  │   outcome unestablished)     │
       ▲                         ▼                              │
       │                    QUARANTINED ──────────────────────-─┘
       │                         │        RECONCILE(SETTLED)
       └─────────────────────────┘
            RECONCILE(FAILED)

     UNKNOWN ── not a state to transition from; must be established first
```

- **`QUARANTINE`** replaces `RECLAIM`. It requires the reservation to have
  expired, exactly as `RECLAIM` did, and moves the record to `QUARANTINED`
  instead of `UNUSED`. It marks the authorization as needing reconciliation; it
  decides nothing about what happened.
- **`QUARANTINED` is refused by the verifier**, with its own reason code
  `MANDATE_QUARANTINED`. It is distinct from `MANDATE_RESERVED` because the
  operational response differs: a reservation resolves itself, a quarantine needs
  someone to go and look.
- **`RECONCILE` is the only exit**, and it carries the outcome it established:
  `SETTLED` consumes the authorization, `FAILED` returns it to `UNUSED`.
- **`ReconciledOutcome` has no `UNKNOWN` member.** A reconciliation that could
  not establish the outcome applies no transition and the record stays
  quarantined. An enum member meaning "still don't know" would be a place for a
  caller to launder its uncertainty into a decision.
- **A quarantined record admits no other transition**, enforced once at the top of
  `applyTransition` rather than case by case. In particular `RELEASE` cannot act
  on it: `RELEASE` claims an observation that the quarantine exists to record
  nobody has.

`isAvailable(record)` is exported so a caller cannot accidentally treat
`QUARANTINED` as usable by testing `!== CONSUMED`.

## Consequences

- A crash with an unknown outcome now costs the authorization until someone
  reconciles it. That is a deliberate liveness cost paid for a safety property,
  and it is the same trade the reserve-before-signing order already makes.
- Operators acquire a real obligation: quarantined records accumulate and need a
  reconciliation path. The pressure test's observability section already called
  for a `RECLAIM` counter that pages; it becomes a `QUARANTINED` depth gauge, and
  it is now a queue with a defined drain rather than an alarm on a silent
  self-clearing defect.
- Reconciliation itself is not built here. It needs chain observation, which is
  Phase 6. What Phase 5R guarantees is that its absence fails closed: with no
  reconciliation, a quarantined authorization simply stays unavailable.
- `MANDATE_QUARANTINED` is a new reason code. The wire code table gains
  `QUARANTINED: 5`, appended rather than inserted, so no existing code moves.
