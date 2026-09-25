# Router performance baseline

> **Observed 2026-09-24.** Performance numbers are environment-specific and are
> not product throughput claims.

The benchmark uses Node v22.21.0 on macOS arm64 with an Apple M3 Pro. Each size
receives one warm-up followed by sequential in-process `route` calls over the
recorded NVDA trusted state. Every candidate passes the registry and initial
kernel verifier, so the measurement includes candidate construction, hashing,
verification, sorting, final re-verification and receipt construction.

- 10 candidates, 20 iterations: 14.725 ms median, 19.088 ms maximum.
- 100 candidates, 10 iterations: 127.840 ms median, 133.833 ms maximum.
- 256 candidates, 5 iterations: 319.517 ms median, 340.391 ms maximum.

The observed growth is compatible with bounded per-candidate verification plus
sorting. No optimization is warranted at this scale. The 256-candidate hard
limit prevents an untrusted provider from expanding work without bound.

Run `npm run router:benchmark` to measure the current machine. Raw benchmark
output is deliberately not committed.
