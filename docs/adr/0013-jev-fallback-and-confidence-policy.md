# ADR 0013: Jev fallback and confidence policy

- **Status:** accepted
- **Date:** 2026-09-25
- **Phase:** 5

## Context

An advisory call to an external service has many more failure modes than
success modes: DNS failure, connection and read timeouts, `401`, `404`, `422`,
`429`, `5xx`, invalid JSON, a schema that drifted, a model the account cannot
use, a name that is not in the set, and a well-formed answer the caller does
not trust enough to act on.

Each of these needs a decision, and the decisions are not obviously the same.
A `401` is an operator error; a `429` is transient; a low confidence value is
the model working correctly and telling the caller so. The temptation is to
treat some of them as errors that fail the request.

Separately, TypeSafe reports a `confidence` derived from the returned
probability distribution, and recommends act / confirm / do-not-act bands while
stating that the thresholds are domain-specific. Choosing a threshold before
measuring the distribution would be inventing a number.

## Decision

**Every Jev problem maps to one stable reason code and one behaviour:
deterministic fallback.** The codes are listed in
[jev-integration.md §6](../jev-integration.md#6-selection-modes-fallback-and-confidence).
None of them fails a transaction, and none of them relaxes a check. The
deterministic result was already computed before the call and is always
available.

**`ABSTAIN` is a first-class outcome, distinct from failure.** It is an
explicit option in every choice set. It means *use the deterministic router
result*; it does not mean `NO_VALID_ROUTE`, which is a question the
deterministic engine settled before Jev was consulted. Its selection mode is
`JEV_ABSTAINED`, so an abstaining model is distinguishable in metrics from a
broken one.

**The default confidence policy is no threshold.** `minimumConfidence` defaults
to `null`: any in-set choice is accepted and the confidence is recorded. The
observed distribution over the evaluation corpus is published first; a
threshold may then be introduced with the data that justifies it.

**A configured threshold produces fallback, never rejection.** Below the
threshold the outcome is `FALLBACK` with `CONFIDENCE_BELOW_THRESHOLD` and the
deterministic candidate is selected. Low confidence in advice is not evidence
about safety, and the safe answer is the one the deterministic pipeline already
produced. The comparison is inclusive (`confidence >= minimumConfidence`) and
both sides of the boundary are pinned by test.

**The timeout is the operational bound, and it is configurable.** TypeSafe does
not accept a token budget as a request parameter, so a budget cannot be
enforced ahead of the call; `usage` is observed afterwards and recorded. The
deadline is what protects the trading path, and exceeding it is an abstention
in effect: `TIMEOUT`, then the deterministic result.

**Failure is never retried inside a routing decision.** A retry spends the
latency budget that exists to keep the trading path responsive, and the
fallback is already correct. Retry and backoff belong to the characterization
harness, not to the decision path.

## Consequences

- The decision path has exactly two outcomes that matter operationally: the
  model's choice, or the deterministic choice. Everything else is bookkeeping
  that lands in a receipt.
- Metrics can distinguish abstention from failure from low confidence, which is
  what makes a later threshold defensible.
- No confidence threshold ships in Phase 5. That is reported as a deliberate
  absence, not as a completed calibration.
- A permanently broken integration is invisible to users and visible in
  metrics. That is the intended asymmetry, and it means the fallback counters
  must actually be watched.
- Not retrying means a single transient `429` costs the advisory layer for that
  decision. Accepted: the deterministic answer is not degraded by it.
