# Jev evaluation report v1

`report.json` is the deterministic output of the Phase 5 advisory-layer
evaluation. Generate it with `npm run jev:evaluate`; ordinary tests reproduce
it and fail on drift.

Thirteen scenarios run in five modes, including a fully adversarial one. The
safety counters — selections outside the closed set, excluded candidates
selected, handoffs without a final kernel PASS — are measured, not asserted.

The representation, price, multiplier, contract identity and corporate-action
epoch come from recorded Phase 3 Robinhood mainnet snapshots for AAPL, NVDA,
TSLA, QQQ, CRWD and MSFT. Route fees, alternate venues, advisory venue-quality
signals and every adversarial mutation are synthetic.

Jev is simulated by stubs. Stub token counts measure the harness rather than
the service, and the report deliberately carries no latency figure. Real
measurements belong in [docs/jev-characterization.md](../../docs/jev-characterization.md).

Methodology: [docs/jev-evaluation.md](../../docs/jev-evaluation.md).
