# ADR 0011: Route cost and fill policy

- **Status:** accepted
- **Date:** 2026-09-24
- **Phase:** 4

## Context

A venue or route provider can omit a fee, label an unknown cost as zero, or
offer a partial fill that cannot satisfy the execution semantics assumed by the
Phase 1 verifier. Treating either case optimistically would make the router an
authorization bypass.

## Decision

Phase 4 accepts only `FILL_OR_KILL` quotes. `ALLOW_PARTIAL` is represented but
excluded before candidate construction. Partial settlement accounting remains
future work.

Every cost component used by the Phase 4 route must be present as an exact,
unit-bearing amount:

- explicit venue fee;
- execution fee;
- settlement fee;
- route fee.

An absent component is `UNKNOWN`, never zero, and excludes the quote. Funding
conversion and bridge costs are not Phase 4 components because those route
types are not implemented. Adding them later requires making them explicit,
not defaulting them.

For `BUY`, total economic cost is quoted notional plus known fees. For `SELL`,
net proceeds are quoted notional minus known fees; fees at or above proceeds
exclude the route. All arithmetic is integer fixed-point arithmetic in the
notional unit and scale, and overflow or unit mismatch excludes the route.

## Consequences

- A malicious provider cannot win by omitting fees.
- Unknown cost produces an explained no-route outcome rather than a false cheap
  route.
- The initial router deliberately does not support partial execution.
- Stablecoin conversion and bridge economics remain Phase 7 work.

