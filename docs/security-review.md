# Internal security review

> **Status:** living internal engineering review, updated 2026-09-25 for
> Phase 5. This is not a third-party audit.

## Current dependency review

`npm audit --json` was re-run against the committed lockfile on 2026-09-25,
after Phase 5 added `packages/jev`. It reported 15 total dependencies (13
production, 3 development) and zero info, low, moderate, high or critical
vulnerabilities. Phase 5 introduced no third-party dependency: the Jev client
uses the platform `fetch`. There are therefore no findings to remediate or accept in this
review. CI runs `npm audit --audit-level=high`; a high or critical advisory is a
release failure. Lower-severity findings, if introduced, must be recorded here
with reachability and resolution rather than silently ignored.

The router has only `@mandate/kernel` and `@mandate/registry` as runtime
dependencies. A structural test enforces that set and scans production source
for network, filesystem, implicit clock, randomness, model and Jev imports.

`@mandate/jev` adds no third-party runtime dependency: it depends on
`@mandate/kernel`, `@mandate/registry` and `@mandate/router` and uses the
platform `fetch`. A structural test enforces that set, confines network access
to one module, confines the credential read to one environment variable in that
same module, forbids library writes to stdout and stderr, and asserts that the
kernel, registry and router neither declare nor import `@mandate/jev`.

## Threats and controls

### Provider substitutes an asset, token, issuer, chain or venue

- **Affected component:** provider boundary and candidate construction.
- **Control:** strict parsing, representation-first registry enumeration,
  registry admissibility, trusted-state reconciliation and kernel verification.
- **Evidence:** `provider.test.ts`, `candidate.test.ts`, `security.test.ts` and
  the mainnet-routing replay.
- **Residual risk:** registry or authoritative source compromise remains outside
  the router's ability to detect.
- **Status:** controlled within Phase 4 scope.

### Provider understates or omits costs

- **Affected component:** cost model and ranking.
- **Control:** every supported component must be known and exactly match
  independently supplied trusted cost state. Unknown is never zero.
- **Evidence:** malicious-zero-fee, unknown-cost, unit and overflow tests.
- **Residual risk:** a compromised trusted cost adapter can still supply a
  false fee. Production fee-source authentication is future adapter work.
- **Status:** controlled for normalized trusted inputs.

### Quality offsets a mandate violation

- **Affected component:** selection.
- **Control:** registry and kernel PASS are prerequisites to ranking; quality is
  not a weighted authorization score.
- **Evidence:** the cheapest-invalid-route tests and all six mainnet routing
  worlds.
- **Residual risk:** none known in the deterministic decision path.
- **Status:** controlled.

### Candidate or receipt tampering

- **Affected component:** candidate identity and audit.
- **Control:** domain-separated canonical binary encodings commit to kernel and
  route-specific fields; the winner is reverified after ranking.
- **Evidence:** digest mutation, order-independence, replay and final-verifier
  failure tests.
- **Residual risk:** receipts are commitments, not signatures or durable
  storage. Execution binding remains Phase 6.
- **Status:** controlled for Phase 4; atomic transaction binding remains open.

### Resource exhaustion

- **Affected component:** provider parsing and sorting.
- **Control:** 256 candidates, 8 steps per route and 128-byte identifier limits;
  bounds are checked before verification.
- **Evidence:** oversized candidate/step tests and maximum-size benchmark.
- **Residual risk:** callers can repeatedly invoke the bounded operation; API
  rate limiting is outside the pure router.
- **Status:** bounded per invocation.

### Secrets enter the repository

- **Affected component:** repository and CI.
- **Control:** ignored secret paths, tracked-path denial checks, credential
  content patterns and CI invocation. Tests use a public synthetic private key
  only for deterministic signatures.
- **Evidence:** `credentials:scan` and `repository:junk`.
- **Residual risk:** heuristic content scanning is not a substitute for secret
  rotation after a real disclosure.
- **Status:** controlled by current repository gates.

## The external-model trust boundary (Phase 5)

Jev is the first **untrusted, non-deterministic, external** dependency in a
decision path. It is treated as hostile by construction, and the controls below
are the reason its hostility is affordable.

```text
              ┌──────────── trusted, deterministic ────────────┐
  registry ─▶ candidate construction ─▶ kernel ─▶ closed set ─┐ │
              └───────────────────────────────────────────────┘ │
                                                                │ projection
                                     ┌──────────────────────────▼─────────┐
                                     │ UNTRUSTED: TypeSafe Jev            │
                                     │ returns one string                 │
                                     └──────────────────────────┬─────────┘
                                                                │ name
              ┌───────────────────── local array lookup ────────▼─────────┐
              │ closedSet[index]  ─▶ kernel re-verification ─▶ handoff    │
              └───────────────────────────────────────────────────────────┘
```

Nothing crosses the boundary inward except a string that is looked up in a
local array. There is no deserialization of model output into a domain object.

### Model output is treated as authoritative

- **Affected component:** the advisory decision path.
- **Control:** Jev receives a projection, never a candidate. Its answer is a
  name resolved by exact array lookup; no field of any response is read as an
  address, amount, quantity, side, representation, chain, issuer, price, cost
  or constraint. An out-of-set name falls back. Everything handed off is
  re-verified by the kernel.
- **Evidence:** `adversarial.test.ts` runs seventeen hostile behaviours,
  including a returned candidate object, an attacker address, an altered
  amount and an inverted side; `equivalence.test.ts` asserts the closed-set
  digest is identical across every behaviour and that every handoff is a member
  of the deterministic admissible set carrying a kernel `PASS`.
- **Residual risk:** none known within the closed-set design. A compromised
  model can still degrade execution quality inside the mandate's bounds.
- **Status:** controlled, and measured — `corpus/jev-evaluation-v1` reports
  zero unsafe handoffs in all five modes.

### Prompt injection through route-provider text

- **Affected component:** request construction.
- **Control:** no provider-authored string reaches the request. Every string in
  a Jev body originates in `question.ts` as a module constant or a numeric
  template; advisory context is normalized against two closed vocabularies and
  anything unrecognized becomes `UNKNOWN`, the no-signal value.
- **Evidence:** `injection.test.ts` asserts hostile strings are absent from the
  payload, and separately that a model which obeys them completely — modelled
  as one always choosing the deterministically worst option — still produces
  only an already-valid candidate.
- **Residual risk:** a future field added to the projection could reintroduce
  the path. An allowlist test over every key in the payload fails on any
  undeclared field, which converts that risk into a failing test.
- **Status:** controlled at two independent layers.

### Credential disclosure

- **Affected component:** the Jev client, logs, fixtures and receipts.
- **Control:** the key is read from `TYPESAFE_API_KEY` in one module and
  nowhere else; a key containing whitespace or control characters is refused
  rather than interpolated into a header; the client refuses to call without
  one instead of calling unauthenticated; library code writes nothing to stdout
  or stderr; error bodies are discarded and failure details carry a status code
  only; the credential scanner gained TypeSafe key-assignment,
  TypeSafe-shaped-token and literal-bearer-token patterns.
- **Evidence:** `client.test.ts` asserts the key appears in no result a caller
  could log and that exactly three headers are sent; `fixtures.test.ts` and
  `jev:fixtures:validate` scan every fixture for credential-shaped content;
  `receipts.test.ts` scans the receipt.
- **Residual risk:** heuristic content scanning does not replace rotation after
  a real disclosure, and the vendor publishes no key format, so the
  token-shape pattern is a best guess.
- **Status:** controlled by repository gates and structural tests.

### Data disclosure to an external service

- **Affected component:** the candidate projection.
- **Control:** `JevCandidateView` carries twelve declared fields, built
  individually rather than by spreading an internal object. No private key,
  signature, authorization envelope, mandate digest, principal or agent
  identity, contract address, representation, issuer, chain, venue, route or
  provider identifier, or state identifier is sent.
- **Evidence:** `projection.test.ts` walks every key in the request and fails
  on any key outside the declared allowlist, and separately asserts specific
  identity values from the evaluation are absent from the serialized payload.
- **Residual risk:** the all-in cost and deviation are exact integers, so a
  request discloses the economics of a pending order to a third party. That is
  inherent to asking for advice about it and is accepted; it is why the
  projection is minimized rather than convenient.
- **Status:** controlled, and enforced by an allowlist rather than a denylist.

### External-service availability affecting execution

- **Affected component:** the decision path.
- **Control:** every failure — DNS, connection, read timeout, 401/403, 404,
  422, 429, 5xx, invalid JSON, schema mismatch, unavailable model, out-of-set
  choice, unsupported cardinality, confidence-policy rejection and a transport
  that throws or never settles — maps to one stable reason code and selects the
  deterministic candidate. The decision path enforces its own deadline rather
  than trusting the transport's. No retry occurs inside a decision.
- **Evidence:** `selection.test.ts` covers every reason code and asserts one
  identical selection across all of them; the hanging-transport test asserts
  the path does not block.
- **Residual risk:** a permanently broken integration is invisible to users by
  design and visible only in metrics, so the fallback counters have to be
  watched.
- **Status:** controlled; the monitoring obligation is real and is recorded
  here rather than assumed.

### Stale decision across model latency

- **Affected component:** execution handoff.
- **Control:** the selected candidate is re-verified against the trusted state
  and clock current at handoff, not those the closed set was built from. A
  halt, a price move past the mandate bound, a corporate-action epoch change or
  an expiry occurring during inference rejects.
- **Evidence:** the state-change tests in `adversarial.test.ts` and the
  `market-change-during-decision` corpus scenario, which rejects in all five
  modes including deterministic-only.
- **Residual risk:** the handoff state is supplied by the caller. Binding it to
  chain-observed state at submission is Phase 6 work (INV-13).
- **Status:** controlled off-chain; atomic binding remains open.

## Solidity analysis

There are no Solidity contracts. Slither and Foundry are therefore not
installed or represented as having run. As soon as Solidity is introduced,
the release gate must add `forge build`, `forge test`, invariant suites and
`slither .`, with every finding fixed, justified or recorded as residual risk.

