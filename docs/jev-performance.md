# Jev-assisted latency

> **Observed 2026-09-25.** Environment-specific, not a product throughput
> claim. This benchmark measures the *local* cost only; the network and
> inference component is measured separately by the live characterization run
> and carried into [§3](#3-the-remote-half).

Node v22.21.0 on macOS arm64, Apple M3 Pro. Run it with
`npm run jev:benchmark`. Raw output is deliberately not committed.

## 1. Method

Three modes are run interleaved over the recorded NVDA trusted state, one
warm-up each:

```text
deterministicOnly              route()
advisoryPathDisabled           selectWithJev with no transport
advisoryPathStubbedTransport   selectWithJev with an instantly-returning stub
```

The stub returns without any I/O, so what the third mode adds over the first is
exactly the local cost Mandate puts around a Jev call: the evaluation/selection
split, the candidate projection, the request body, response parsing, the
advisory receipt, the selection receipt and the handoff re-verification.

## 2. Observed

Median wall clock, two runs:

| Candidates | Iterations | Deterministic | Advisory (stubbed) | Local overhead |
| --- | --- | --- | --- | --- |
| 10 | 20 | 13.1–13.4 ms | 14.6 ms | +1.3 to +1.4 ms |
| 100 | 10 | 115.1–118.6 ms | 116.7–118.7 ms | 0.0 to +1.6 ms |
| 254 | 5 | 288.1–294.4 ms | 292.8–294.9 ms | −1.6 to +6.8 ms |

**The local overhead is within run-to-run variance at every size measured.**
The −1.6 ms figure is not a speed-up; it is noise, and reporting it as an
improvement would be exactly the kind of overclaiming this repository forbids.
The honest statement is that the advisory layer's own arithmetic is small
relative to the deterministic work it wraps, and that the one structurally new
cost — a second kernel verification at handoff — is a single verification
against a set of up to 254, so it does not scale with the set.

## 3. The remote half

**The Jev call itself.** The benchmark's transport is a stub, so network and
inference time is zero here by construction. End-to-end latency is:

```text
end-to-end  =  deterministic routing
            +  local advisory overhead   (measured above, ~1–2 ms)
            +  Jev round trip            (measured 2026-09-25: p50 94 ms, p95 250 ms)
```

The third term now comes from a completed run of `npm run jev:characterize`;
[jev-characterization.md §3](jev-characterization.md#3-observed-behaviour)
carries the numbers and their sample size. The round trip dominates the local
overhead by roughly two orders of magnitude, which is the expected shape: the
advisory path is the deterministic path plus a network call.

**The sample is six requests from one machine on one network.** It is not a
tail bound and not an SLA. It is enough to say the advisory layer costs
something on the order of a tenth of a second when it works, and nothing when
it does not — the deadline bounds the loss, and the deterministic result was
computed before the call.

## 4. The framing that would be wrong

Deterministic code is faster than a model call. It has to be — the advisory
path *contains* the deterministic path and then adds a network round trip to
it. Nothing in Phase 5 is a benchmark of Jev against arithmetic, and a result
showing the advisory path winning would mean the measurement was broken.

The question worth answering is the budget one: how much latency does optional
advisory intelligence add to a trading path, and is that acceptable? The local
half is answered above. The remote half is now both bounded and measured: the
configured `timeoutMs` is the hard ceiling, defaulting to 2000 ms, and
exceeding it produces the deterministic result rather than a wait. Against a
measured p95 of 250 ms that ceiling is about 8× the slowest response observed.
The default has deliberately **not** been changed on the strength of six
requests — it is a policy choice about acceptable UX, and revising it is the
repository owner's call, recorded as an open question rather than silently
tuned.
