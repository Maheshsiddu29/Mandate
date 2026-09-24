# ADR 0009: Corporate-action epoch authority

- **Status:** Accepted
- **Date:** 2026-09-24
- **Implements:** [design §13](../mandate-design.md#13-corporate-actions)

## Context

The Phase 1 verifier compares a mandate's required corporate-action epoch with
trusted state, but deliberately did not decide who assigns the epoch. A manually
incremented registry counter would work mechanically and would be weaker than
the state Robinhood now exposes.

The 2026-09-24 investigation found that `/corporate-actions` is a current
processed-action surface whose `id` repeats the Stock Token UID; it is not a
globally unique action sequence. In contrast, each Stock Token emits the
documented ERC-8056 `UIMultiplierUpdated(oldMultiplier,newMultiplier,effectiveAt)`
event, and its current `uiMultiplier()` is directly readable at a named block.

## Decision

For Robinhood Stock Tokens, the corporate-action epoch is the `effectiveAt`
Unix second of the latest effective onchain `UIMultiplierUpdated` event whose
resulting multiplier equals the contract's current `uiMultiplier()` at the
observation block.

The derivation is strict:

1. verify the log topic, contract address, ABI data and non-removed status;
2. ignore events whose effective time is later than the observation block;
3. order effective events by effective time, block number and log index;
4. require the latest effective event's `newMultiplier` to equal the current
   onchain multiplier;
5. use its `effectiveAt` as the epoch;
6. if there is no event, accept epoch zero only when the multiplier is the
   documented initial `1e18`; otherwise the epoch is unknown and fails closed.

Two distinct multiplier results with one effective timestamp are a conflict and
fail closed rather than sharing an epoch. Duplicate staging/activation logs with
the same old multiplier, new multiplier and effective timestamp are one logical
change and are permitted.

A future event or `/assets.pendingMultiplier` is pending state, not the current
epoch. It is retained with its effective time for later policy and UX, but Phase
3 does not silently invalidate a mandate before the change is effective. Once
the event is effective and `uiMultiplier()` reflects it, the epoch advances and
the unchanged Phase 1 verifier rejects a mandate authorized against the prior
epoch.

## Consequences

Epoch assignment is a verified deterministic derivation from issuer-controlled
onchain state, not a Mandate-operated counter and not a ticker-based API guess.
It is replayable at a fixed block and makes an old authorization stale after a
multiplier-changing action without changing the kernel.

The scheme covers actions reflected through the multiplier, which is the
implemented Robinhood representation model. A future issuer action that changes
financial terms without an ERC-8056 multiplier event must not be forced into
this epoch. The adapter will report it as unsupported/unknown until a new
authority rule is reviewed. Process dates remain advisory scheduling context
and are not substituted for an effective onchain state transition.
