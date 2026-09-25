# ADR 0016 — Pipeline time authority and handoff freshness

**Status:** accepted, Phase 5R
**Amends:** [architecture.md](../architecture.md) §5c-bis, [jev-integration.md](../jev-integration.md)

## Context

Two related pressure-test findings, F-5 and F-9.

**F-5.** Both `decide.ts` and `security-review.md` described the execution-handoff
re-verification as being against "the state that is current at handoff, not the
state the closed set was built from". It was not. `selectEvaluated` re-verified
against `context.trustedState` and `context.clock` — the identical objects
`evaluateRoutes` had decided over — so the check was a tautology for a
deterministic verifier and `FINAL_REVERIFICATION_FAILED` was unreachable through
`route()`. `selectWithJev` accepted an optional `handoffState` that defaulted to
the same. The mechanism worked when supplied; nothing required supplying it.

**F-9.** The evaluation clock is a caller parameter with no constraint. Rewinding
it turned an already-stale price back into a pass, defeating every freshness
bound, `notBefore` and `expiresAt` in the mandate.

Both findings share a cause: the orchestrator was inside the trusted computing
base and was the only component inside it that was neither pure, bounded nor
checked.

## Decision

### 1. Handoff state is mandatory and separate

`RouteRequest` gains a required `handoff: { trustedMarketState, clock }`, distinct
from the evaluation inputs. `selectEvaluated` takes it as a parameter rather than
reading it from the evaluation. `selectWithJev` requires it.

If fresh trusted state cannot be obtained, there is no handoff state to supply,
and the call fails with `INVALID_INPUT` rather than silently reusing evaluation
state. **Absent fresh state means no execution handoff**, which is the fail-closed
reading and was the intended one all along.

### 2. Pipeline time is monotonic, and the router enforces it

The kernel stays pure and continues to accept an explicit evaluation instant:
that is what makes a verdict reproducible from its recorded inputs, and it is not
negotiable.

Authority over that instant is now stated rather than assumed:

| Stage | Who supplies the time | Constraint |
| --- | --- | --- |
| Evaluation | orchestrator | none the kernel can check |
| Handoff | orchestrator | **must be at or after the evaluation instant** |
| Execution | chain (`block.timestamp`) | Phase 6 |

`evaluateRoutes`/`selectEvaluated` reject a handoff instant earlier than the
evaluation instant with `HANDOFF_TIME_REGRESSED`. The router is the pipeline, so
the pipeline invariant belongs there — not in the kernel, which sees one instant
per call and cannot know it is the second of two.

A provider-supplied timestamp is never a candidate for the evaluation clock.
`quoteObservedAtUnixSeconds` is used only as the subject of a freshness
comparison, and a quote from the future is `QUOTE_FROM_FUTURE`. This was already
true and is now asserted by a test rather than by inspection.

### 3. What remains unclosed, and why

A caller that rewinds *both* the evaluation and the handoff instant consistently
still defeats every age bound. No pure verifier can detect this, and no off-chain
component can either: an orchestrator that lies about the time is
indistinguishable from one running on a machine whose clock is wrong.

This is therefore **explicitly owned by Phase 6** under INV-10. `block.timestamp`
at the gate closes it by construction, because the chain's clock is not the
orchestrator's to choose. Until then the orchestrator's clock is a named member of
the trusted computing base rather than an unexamined assumption, which is the
difference this ADR makes.

## Consequences

- `route()` and `selectWithJev` both take more inputs, and a caller that has only
  one state snapshot must now say so explicitly by passing it twice. That is
  intended: passing it twice is a visible decision, whereas defaulting to it was
  invisible.
- `FINAL_REVERIFICATION_FAILED` becomes reachable, and is tested for a halt, a
  price move, a representation pause, an epoch change and an expiry between
  evaluation and handoff.
- One new router reason code: `HANDOFF_TIME_REGRESSED`.
- The three documents that described the re-verification as unconditional are
  corrected rather than left to contradict the code.
