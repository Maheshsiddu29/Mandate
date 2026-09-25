# Internal security review

> **Status:** living internal engineering review, updated 2026-09-24 for
> Phase 4. This is not a third-party audit.

## Current dependency review

`npm audit --json` was run against the committed lockfile on 2026-09-24. It
reported 13 total dependencies and zero info, low, moderate, high or critical
vulnerabilities. There are therefore no findings to remediate or accept in this
review. CI runs `npm audit --audit-level=high`; a high or critical advisory is a
release failure. Lower-severity findings, if introduced, must be recorded here
with reachability and resolution rather than silently ignored.

The router has only `@mandate/kernel` and `@mandate/registry` as runtime
dependencies. A structural test enforces that set and scans production source
for network, filesystem, implicit clock, randomness, model and Jev imports.

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

## Solidity analysis

There are no Solidity contracts. Slither and Foundry are therefore not
installed or represented as having run. As soon as Solidity is introduced,
the release gate must add `forge build`, `forge test`, invariant suites and
`slither .`, with every finding fixed, justified or recorded as residual risk.

