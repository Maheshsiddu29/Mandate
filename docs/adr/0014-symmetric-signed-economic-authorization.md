# ADR 0014 — Symmetric signed economic authorization

**Status:** accepted, Phase 5R
**Supersedes nothing. Amends:** [ADR 0002](0002-canonical-mandate-encoding.md) (MCE schema v2),
[ADR 0011](0011-route-cost-and-fill-policy.md) (where the cost bound is enforced)

## Context

The Phase 5 architecture pressure test
([findings F-2 and F-4](../production-architecture-pressure-test.md)) found the
economic half of the authorization model incomplete and asymmetric.

**On BUY**, the kernel bounded `notional` — quantity times price — and nothing
else. Fees were established by the router, cross-checked against an independent
trusted cost source, and compared against `maxNotional` there. Two consequences
followed. The component documented as the only one that authorizes passed a route
whose fees were twice the mandate's cap, because it could not see them. And
`candidateDigest` committed to no fee, so anything reconstructed from that digest
— including the Phase 6 on-chain gate — inherited the same blind spot.

**On SELL** there was no bound at all. `maxNotional` is an upper bound, and a
seller's risk is on the lower side: the router refused only when fees reached the
entire notional, so a sale netting one atom of a 224 USD position was admissible.
Every check passed. There was no mandate field in which a principal could have
expressed the constraint they actually cared about.

`architecture.md` §4 assigned "is the amount within authority?" to the verifier
and explicitly not to the candidate engine. The implementation was the reverse.

## Decision

**A mandate carries a signed, side-appropriate cash-flow bound, and the kernel
enforces it.**

```
economicLimit : Amount          // in the same unit as maxNotional
```

Its meaning is derived from the mandate's `side`, never carried separately:

| Side | Kind | Rule |
| --- | --- | --- |
| BUY | `MAX_TOTAL_DEBIT` | `notional + feeTotal <= economicLimit` |
| SELL | `MIN_TOTAL_CREDIT` | `notional - feeTotal >= economicLimit` |

and the candidate carries the input the rule reads:

```
feeTotal : Amount               // every explicit route cost, summed
```

Four supporting rules:

1. **`maxNotional` stays.** It bounds gross exposure; `economicLimit` bounds cash
   flow. They are different constraints and a principal may want both — "buy at
   most this much exposure, and do not spend more than this in total". Both must
   name one unit, checked at parse time, or the mandate does not express a single
   authorization.
2. **The kernel is the only enforcement point.** `checkEconomicLimit` in
   `packages/kernel/src/verifier/checks.ts` is the sole site. The router no longer
   carries `TOTAL_COST_EXCEEDS_MANDATE` or `SELL_FEES_EXCEED_PROCEEDS`; it
   establishes `feeTotal` from trusted cost state and reports the kernel's verdict.
3. **Fees remain trusted or the candidate is not built.** The router's existing
   rule is unchanged and is what makes `feeTotal` meaningful: every component must
   be known and must match an independently supplied trusted cost exactly, in the
   notional's unit and scale. `UNKNOWN_COST` is never zero.
4. **A SELL whose fees reach the notional fails closed before the comparison.**
   `FEES_EXCEED_NOTIONAL` is its own reason code: a net debit has no defensible
   minimum credit to be compared against, and computing one would be inventing a
   number.

### Arithmetic

`addAmounts` and `subtractAmounts` require one unit and lift the coarser value to
the finer scale by a power of ten. That lift is exact, so **there is no rounding
direction to choose** — the only failure modes are a unit mismatch, an overflow
past `uint256` and, for subtraction, a negative result. All three reject.

This is deliberately unlike `notionalBounds`, which *must* round because
`quantity x price` is generally not representable at the target scale and accepts
a one-atom band. Addition and subtraction of same-unit amounts admit no such
ambiguity, and introducing a tolerance here would create a gap a fee could hide in.

## Schema consequences

MCE schema version 2, and the domain tags move with it:

| Object | v1 | v2 |
| --- | --- | --- |
| Mandate | `MANDATE.MANDATE.V1`, version 1 | `MANDATE.MANDATE.V2`, version 2, `+ economicLimit` |
| Candidate | `MANDATE.CANDIDATE.V1`, version 1 | `MANDATE.CANDIDATE.V2`, version 2, `+ feeTotal`, `+ referenceStateDigest` |
| Trusted state | `MANDATE.STATE.V1`, version 1 | `MANDATE.STATE.V2`, version 2, `+ registrySnapshotDigest` |

The tag changes as well as the version field, so a v1 digest and a v2 digest are
separated twice over. A v1 byte string cannot decode under a v2 tag, and a v2
byte string cannot decode under a v1 tag, so **no v1 digest can be reinterpreted
as a v2 authorization** even if the version field were somehow reused.

### What happens to v1 mandates

`parseMandate` accepts exactly the current version and returns
`UNSUPPORTED_MANDATE_VERSION` for anything else. A v1 mandate is therefore
**rejected, not migrated and not reinterpreted**.

This is acceptable here and would not be after launch. There are no outstanding
signed v1 mandates: the repository is pre-production, no key has signed a mandate
outside a test fixture, and the only v1 artifacts are corpus vectors, which are
regenerated. The alternative — accepting v1 by inferring an `economicLimit` from
`maxNotional` — was rejected outright, because inferring a bound the principal
never signed is exactly the "silently reinterpret an old digest" failure the
version field exists to prevent.

Once real mandates exist, a schema change needs a declared acceptance window with
one frozen parser and encoder per accepted version, and no re-encoding across
versions. That is recorded as a production-readiness requirement rather than
built now, because building a migration framework for a population of zero would
be guessing at its shape (pressure-test finding F-12).

## Consequences

- The verifier gains one check and three reason codes: `TOTAL_DEBIT_EXCEEDED`,
  `TOTAL_CREDIT_BELOW_MINIMUM`, `FEES_EXCEED_NOTIONAL`.
- The router loses two reason codes. There is now one economic authority, which
  removes a differential-consistency risk the pressure test flagged: the
  BUY all-in rule existed in one place and the SELL rule in another, and neither
  was the authoritative layer.
- `candidateDigest` commits to the fee total, so the Phase 6 gate can re-assert
  the all-in bound. This is the reason the change lands before Phase 6 rather
  than inside it.
- Every corpus digest changes. The verifier decision vectors move to
  `corpus/v2`, because the corpus is a compatibility contract for a schema and a
  v2 kernel cannot replay v1 vectors.
