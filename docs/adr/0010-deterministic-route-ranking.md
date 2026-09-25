# ADR 0010: Deterministic route ranking

- **Status:** accepted
- **Date:** 2026-09-24
- **Phase:** 4

## Context

Routing must choose between executions without allowing execution quality to
compensate for a failed mandate constraint. A weighted score would blur that
boundary and would require arbitrary weights for unlike quantities.

## Decision

Routing has two separate stages. Registry admissibility and the kernel verifier
first exclude candidates. Only candidates with a kernel `PASS` are ranked.

The remaining candidates are ordered lexicographically:

1. economic value: lower all-in cost for `BUY`, higher net proceeds for `SELL`;
2. lower absolute execution deviation in basis points;
3. newer quote observation time;
4. fewer explicit route steps;
5. lexicographically smaller routing-candidate digest.

The final digest comparison is a stable tie-break, not a quality claim. Input,
map, object-construction and provider order cannot affect the result.

The selected candidate is passed through the kernel verifier again after
ranking. Only a second `PASS` may become an execution handoff.

## Consequences

- A mandate-invalid route can never offset an exclusion with a good price.
- The ranking can be reproduced without a model or wall clock.
- The comparison remains honest about the dimensions actually available in
  Phase 4; no liquidity or certainty score is fabricated.
- Future policy can add a dimension only by versioning and documenting the
  ordering, because changing the order can change the selected execution.

