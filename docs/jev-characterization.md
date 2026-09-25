# Jev API characterization

> **Status: documented surface recorded 2026-09-25. Live run: NOT PERFORMED.**
> No number in this file is a measurement until §3 says a run completed. Until
> then the repository has no latency, availability or usage figure for Jev, and
> no document may present one.

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

**No live run has been performed in this repository.**

The following table is the shape the run fills in. Every cell is empty on
purpose; an estimate here would be indistinguishable from a measurement once
the file is read a month from now.

| Measurement | Value | Sample size |
| --- | --- | --- |
| Account models returned by `GET /v1/models` | — | — |
| Model requested | — | — |
| Model returned | — | — |
| Success rate | — | — |
| p50 latency | — | — |
| p95 latency | — | — |
| Maximum observed latency | — | — |
| Mean input tokens | — | — |
| Mean output tokens | — | — |
| Confidence range observed | — | — |
| Malformed-request status | — | — |
| Unauthorized status | — | — |
| Unknown-model status | — | — |
| Rate limiting encountered | — | — |

### Consequences for configuration

The operational timeout and any confidence threshold must be chosen from the
numbers above. Until the run completes:

- `timeoutMs` defaults to **2000 ms**, which is a *policy* choice about how
  long a trading path may wait for optional advice, not a claim about how long
  Jev takes. It is configurable and is expected to be revised against measured
  p95.
- `minimumConfidence` defaults to `null` — no threshold — because the
  confidence distribution has not been observed. See
  [ADR 0013](adr/0013-jev-fallback-and-confidence-policy.md).

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

**At the time of writing this repository holds 4 `SCHEMA_DERIVED` fixtures and
0 `LIVE` fixtures**, because no account access was available. The validator
prints that fact on every run rather than letting it pass unnoticed.
