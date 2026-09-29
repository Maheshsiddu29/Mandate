# Phase 7F.1 — Portfolio hardening

> **Status: implemented locally, offline, awaiting independent review.** This
> phase changes only `packages/portfolio`, its tests, its versioned receipt
> corpus and Phase 7F documentation. Frozen Core, ledger, control, Phase 6,
> Solidity and Phase 7E paths are unchanged. No transaction was sent.

Phase 7F.1 closes four independently reproduced gaps in the original Phase 7F
implementation. The regression baseline is committed before the fixes in
`hardening-regressions.test.ts`.

## 1. Exact value binding at every authority boundary

The invariant is:

```text
VERIFIED_CANDIDATE == COMPILED == RESERVED == ADMITTED == SIGNED
```

Equality is canonical value equality, never object identity, a TypeScript
brand, or a caller-supplied boolean/set. Verification now produces a complete
`VerificationTranscript`: the principal signature, verifier time and
availability, candidate, signed proposals and signed releases. Reservation
and pre-sign re-run the deterministic verifier against the compiled mandate
and bindings, select the exact child digest, and re-screen its signed proposal
at the current boundary time. The candidate digest commits every candidate
field; the child digest commits that candidate digest; the Core action nonce
commits the child digest.

At signing, the check additionally requires the exact active reservation,
action, generation, execution authorization and `AttemptId`. Merely finding
some attempt for a reservation is insufficient. The signed proposal and
mandate must still be active, and a quote that became stale after verification
is refused before a key is used.

The mutation matrix covers zero/lower minimum output, quote timestamp and
staleness, recipient, router/venue, route, input amount and output
representation/Core target. Each mutation leaves the ledger untouched; the
byte-exact candidate reserves successfully.

## 2. Mandatory Portfolio custody construction

`guardGateCustody` is no longer a public Portfolio primitive. Portfolio code
exposes `createPortfolioGateSigner`, which captures the raw generic
`GateKeyCustody` and returns only a `GateSigner` wired to the transcript guard.
The generic `@mandate/evm-robinhood` APIs remain unchanged for non-Portfolio
use. Within the Portfolio construction path there is no raw-custody option.
Tests count custody key invocations: an unverified or mutated transcript admits
no signature, uses the key zero times and sends zero transactions.

## 3. Receipt V2 completeness

The Portfolio Mandate remains `PORTFOLIO_MANDATE.V1`. Only the receipt changes:
the old `PORTFOLIO_RECEIPT.V1` meaning is not mutated;
`PORTFOLIO_RECEIPT.V2` carries schema version 2.

The binary receipt encoding commits the complete canonical mandate, exact
candidate and child encodings, candidate/action/reservation/generation
commitments, release sequence and amounts, canonical asset/representation
decisions, and all execution evidence. Allocation entries and lots are sets
and are canonically sorted. The allocation log is an event stream: its order
is preserved, and every COMMIT/RELEASE/CLAIM field is encoded. No JSON enters
the digest.

## 4. Release and claim transcript semantics

The verifier independently enforces strictly increasing release sequences per
agent in allocation-log order. It also replays the ordered log, requiring
unique release and claim identifiers, existing lots, exact resources and
amounts, correct source/destination agent, remaining balance and feasible
ordering. A duplicate, replay, non-monotonic sequence or impossible reorder
fails closed.

There is deliberately no second allocation ledger. Sequence monotonicity is
therefore durable only inside one supplied transcript. A release from an older
completed process could be presented in a later process unless an integrator
persists a high-water mark. This residual replay risk cannot expand financial
authority: a release only reduces the releasing agent's offchain allocation,
and every resulting child is still bounded by signed scope and the Core ledger.
Durable cross-run sequence state would require an explicitly opened ledger or
persistence design phase.

## 5. Preserved properties

- Portfolio Mandate schema v1 is unchanged.
- Core remains the sole durable authority and reservation ledger.
- Model output remains advisory and outside authorization.
- The verifier remains pure, total, deterministic and model-free.
- No floating-point quantity participates in a decision.
- Refusals occur before key use and before transaction submission.

