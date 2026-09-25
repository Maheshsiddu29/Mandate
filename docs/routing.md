# Deterministic routing

> **Status:** Phase 4 design. The router is deterministic, offline and
> model-free. It constructs no transaction and submits nothing.

## Boundary

The router consumes a parsed mandate, an opened registry snapshot, trusted
market state, an explicit clock, and untrusted route-provider output. It makes
no network, filesystem, environment, randomness or implicit-clock reads.

```text
mandate -> registry representations -> provider quotes -> strict parsing
        -> registry admissibility -> kernel verification -> ranking
        -> kernel re-verification -> selection receipt
```

The provider proposes routes; it does not establish token identity or authorize
execution. Discovery is limited to representation identifiers enumerated from
the registry for the mandate's canonical asset. A same-symbol token has no path
into the candidate set.

## Candidate model

A routing candidate binds the kernel execution candidate to the route
identifier, provider identity/class, fill policy, quote time, known cost
components and ordered route steps. Its canonical binary encoding is domain
separated from kernel objects. Changing a security-relevant field changes its
digest.

Phase 4 route steps are explicit but simple. The supported step kind is
`TRADE`; `FUNDING`, `CONVERSION`, `BRIDGE` and `SETTLEMENT` are reserved for
future implementations and are rejected if a provider claims them without a
supporting implementation.

## Admissibility and ranking

Registry exclusions and kernel violations are reported per route. They are not
quality penalties. Only kernel-PASS candidates enter the ranking described in
[ADR 0010](adr/0010-deterministic-route-ranking.md).

Unknown fees and partial fills follow the fail-closed policy in
[ADR 0011](adr/0011-route-cost-and-fill-policy.md).

## Receipts

Every routing result is `SELECTED`, `NO_VALID_ROUTE`, or `INVALID_INPUT` and
has a deterministic receipt. The receipt commits to the router version,
mandate, registry snapshot, trusted state, every route outcome, ranking inputs,
selected candidate, final verifier receipt and explicit evaluation time.

`SELECTED` means the preferred candidate passed a second kernel verification.
It is not an executed trade and not a transaction authorization beyond the
existing mandate-verifier decision.

## Resource limits

- at most 256 provider quotes;
- at most 8 route steps per quote;
- identifiers use the kernel's 128-byte ASCII limit;
- metadata is an enum/classification vocabulary, not arbitrary text;
- duplicate route or candidate identities reject the whole input.

These limits are checked before expensive registry and verifier work.

The seeded simulation methodology and committed metrics are in
`corpus/routing-simulation-v1`. Performance methodology is documented in
[router-performance.md](router-performance.md), and current controls and
residual risks are maintained in [security-review.md](security-review.md).
