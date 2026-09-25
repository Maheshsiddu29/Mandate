# Jev API characterization

> **Status: documented surface recorded 2026-09-25. Live run: PERFORMED
> 2026-09-25.** Every figure in §3 is a measurement from that run, taken from
> one machine on one network with a sample of six successful requests. It is a
> characterization, not a service-level claim, and §3 states its own sample
> size so it cannot later be quoted as one.

Phase 5 begins with characterization rather than integration, because
[mandate-design.md §11.5](mandate-design.md#115-open-questions) recorded the
API, latency profile and cost as unknown and instructed Phase 5 not to assume
capabilities.

## 1. Method

The harness is `packages/jev/scripts/characterize.ts`, run with:

```bash
TYPESAFE_API_KEY=… npm run jev:characterize
```

It performs a deliberately modest number of ordinary requests. It does **not**
stress, fuzz, flood or vulnerability-test TypeSafe's service: error behaviour
is observed from ordinary mistakes (a wrong model name, a malformed body, a
bad key) made once each, not from repetition.

Probes, one request each unless stated:

| Probe | What it establishes |
| --- | --- |
| `models` | which model names and pinned versions the account can use |
| `choice` × N | success shape, alias resolution, confidence, probabilities, usage, latency |
| `malformed` | response to a structurally invalid request body |
| `unauthorized` | response to a syntactically valid but wrong key |
| `unknown-model` | response to a model name the account cannot use |
| `timeout` | client behaviour when the deadline is shorter than the response |

Add `-- --write-fixtures` to record the first successful exchange as a `LIVE`
fixture.

Latency is wall-clock around the HTTP call only, measured with
`performance.now()`, and reported as p50, p95 and maximum over the successful
`choice` probes. The sample is small by design. **A handful of requests from
one machine on one network is not a production SLA**, and the run records its
own sample size so that no later document can quote the numbers as one.

The API key is read from `TYPESAFE_API_KEY` and from nowhere else. It is never
written to stdout, to a fixture, to a receipt, to an error message or to this
document.

## 2. Documented surface

Recorded from TypeSafe's published documentation on 2026-09-25 and reproduced
in [jev-integration.md §1](jev-integration.md#1-the-external-api-as-documented).
The properties Phase 5 depends on:

- `POST /v1/systemone` with `state`, `model`, `questions`;
- `GET /v1/models` listing the names the account may send;
- a `choice` question takes a `criteria` map of at most **255** options and
  returns `choice`, `probabilities` and `confidence`;
- `usage` reports `input_tokens` and `output_tokens`;
- `401`, `422`, `429` and `529` are documented; other statuses are not;
- aliases (`jev-latest`, `jev-preview`) move, and the response's `model` field
  reports the versioned ID that served the request.

Not documented, and therefore not assumed anywhere in the integration: a rate
limit figure, an error response body schema, a request size limit, a latency
target, and any validation rule on `criteria` keys.

## 3. Observed behaviour

**A live run completed on 2026-09-25.** Every number below is a measurement
from that run. The run is reproducible with the command in §1; the raw report
it printed is not committed, because benchmark output is not a repository
artifact.

Environment: Node v22.21.0, darwin/arm64, Apple M3 Pro, one machine on one
domestic network.

| Measurement | Value | Sample size |
| --- | --- | --- |
| Account models returned by `GET /v1/models` | `jev-latest`, `jev-preview` | 1 request |
| Model requested | `jev-latest` | — |
| Model returned | `jev-1.13.0` | 6 of 6 responses |
| Success rate | 1.000 | 6 of 6 |
| p50 latency | 94.2 ms | 6 |
| p95 latency | 249.9 ms | 6 |
| Maximum observed latency | 249.9 ms | 6 |
| Mean input tokens | 1592 | 6 |
| Mean output tokens | 75 | 6 |
| Confidence range observed | 1.00 – 1.00 | 6 |
| Malformed-request status | `422` | 1 |
| Unauthorized status | `401` | 1 |
| Unknown-model status | `400` | 1 |
| Rate limiting encountered | none | 22 requests to the service on 2026-09-25 |

The rate-limit row counts every request this repository sent on the day, not
just the harness's eleven: the §3.1 probe and three status re-checks are
included, because a rate-limit observation is only meaningful against the true
request count. No `retry-after`, `x-ratelimit-*` or `ratelimit-*` response
header was present on any of them, so the service exposes no quota to a client
and a limit can only be discovered by hitting it. This repository did not try.

Two results deserve to be read carefully rather than quoted.

**`400` is not a documented status.** §2 records `401`, `422`, `429` and `529`
as the documented set. An unusable model name returns `400`, which the client
maps to `UNEXPECTED_STATUS` and therefore to deterministic fallback. The
behaviour is correct — the seam fails closed on a status nobody anticipated —
but the documented surface is now known to be incomplete, and no code should
be written that enumerates statuses as if it were complete.

**The confidence range in the table is an artifact of the probe, not a property
of the model.** The harness sends one identical payload six times, and that
payload has a dominant answer: the cheapest route is also the most reliable
one. A model that returned anything other than `1.00` on it would be wrong.
The table reports what the harness measured; §3.1 reports what the harness
cannot see.

### 3.1 Whether confidence discriminates — exploratory

The table above cannot answer the question that matters for using confidence
as a control: does it ever leave `1.00`? Six identical requests cannot, by
construction.

A separate exploratory probe, **not part of `jev:characterize` and not wired
into any command**, sent three constructed worlds twice each, varying only the
candidate projection and holding everything else at the harness payload:

| World | Choice | Confidence | Sample |
| --- | --- | --- | --- |
| Costs differ by one atom; quality varies | `route_000` | 1.00, 1.00 | 2 |
| Cheapest route is the worst quality; dearest is the best | `route_000` | 0.97, 0.98 | 2 |
| Every candidate identical in every field | `ABSTAIN` | 0.60, 0.57 | 2 |

Three findings, on a sample of six:

- **Confidence does discriminate.** It is `1.00` only where the answer is
  dominant, falls slightly where cost and quality disagree, and falls to around
  `0.6` where the candidates are indistinguishable. The distribution ADR 0013
  said had to be observed before a threshold could be chosen is no longer
  unobserved — though six requests is not yet a calibration.
- **`ABSTAIN` is exercised live.** On exact ties the model abstained rather
  than picking arbitrarily, which is the behaviour the closed choice set was
  designed to make available. Until this run, abstention had only been observed
  against stubs.
- **The service is not deterministic.** Identical payloads returned different
  confidence values (`0.97` vs `0.98`, `0.60` vs `0.57`) and different
  probability vectors. Nothing in the integration assumes determinism, and no
  fixture asserts a particular choice — this run is why that was the right
  decision, not a reason to revisit it.

These six requests are labelled exploratory because the harness does not
produce them. Reproducing them means constructing the worlds by hand as
described above. They are recorded here rather than dropped, because reporting
only the `1.00 – 1.00` row would leave a reader to conclude that confidence
carries no signal, and that conclusion is false.

### Consequences for configuration

The operational timeout and any confidence threshold can now be chosen from
measured numbers. **Neither default has been changed in this run**, because
both are policy decisions rather than implementation details:

- `timeoutMs` remains **2000 ms**. Measured p95 is 249.9 ms and the maximum
  observed is the same, so the current default is roughly 8× the slowest
  response seen. It is a *policy* choice about how long a trading path may wait
  for optional advice, not a claim about how long Jev takes. The measurement
  supports lowering it; lowering it is a decision for the repository owner, and
  a sample of six from one network is thin evidence for a tail bound.
- `minimumConfidence` remains `null` — no threshold. §3.1 shows the
  distribution is non-degenerate, which is what
  [ADR 0013](adr/0013-jev-fallback-and-confidence-policy.md) required before a
  threshold could be defensible. It does not by itself say where the threshold
  belongs; a run that saw `0.57` twice out of six has not found the boundary
  between "advice worth taking" and "advice worth discarding".

## 4. Recorded fixtures

Contract-regression fixtures live in `packages/jev/test/fixtures/`. Each
records its capture date, the requested and returned model, the sanitized
request, the sanitized response, usage, an observed latency and a digest.

A recorded response is a test of **adapter compatibility and parsing**. It is
not ground truth about what the model should answer: the model behind an alias
changes, and a fixture that asserted a particular choice would be asserting
that an external service never improves.

Fixtures whose `captureClass` is `SCHEMA_DERIVED` were constructed from the
published schema and are **not** recordings of a real response. They exercise
the parser and nothing more, and they are labelled as such in the file itself.

`npm run jev:fixtures:validate` enforces the distinction rather than trusting
it: a `SCHEMA_DERIVED` fixture may not carry an observed latency and must say
in its own note that it is not a recording, and a `LIVE` fixture must record
both an observed latency and the returned model. Every fixture is digest-pinned
and scanned for credential-shaped content.

**This repository holds 4 `SCHEMA_DERIVED` fixtures and 1 `LIVE` fixture.**
The live one is `live-choice-001.json`, recorded on 2026-09-25 from the first
successful probe of the run described in §3: requested `jev-latest`, served by
`jev-1.13.0`, 146.9 ms observed. Its request and response are the real bodies.
No credential appears in either — the key travels in an `authorization` header,
which is not part of a fixture, and the validator scans every file for
credential-shaped content regardless. The validator prints the live and
schema-derived counts on every run rather than letting them pass unnoticed.
