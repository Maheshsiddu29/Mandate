# Continuous integration

The `deterministic-validation` GitHub Actions workflow is validation-only. It
does not publish, deploy, trade or use wallet credentials.

Every push and pull request runs on Node 22 and performs:

1. `npm ci` from the committed lockfile;
2. strict TypeScript checking and all deterministic tests;
3. offline Robinhood fixture validation;
4. Phase 3 and Phase 4 mainnet replay validation;
5. cross-surface validation;
6. Jev fixture validation, offline;
7. credential and repository-junk scanning;
8. regeneration followed by a clean-diff check for all corpora and generated
   reason-code documentation, including the Jev evaluation report;
9. `npm audit --audit-level=high`.

## External services are never required

The normal workflow has no dependency on Robinhood REST or RPC availability,
and none on TypeSafe. **No pull request can be blocked by an external model
being unreachable, rate limited or changed.**

The Jev integration is validated entirely offline:

- recorded and schema-derived response fixtures, digest-pinned
  (`npm run jev:fixtures:validate`);
- deterministic stubs for every selection mode;
- adversarial stubs for every hostile behaviour;
- the committed evaluation report, regenerated and diffed.

Two optional jobs exist for manual `workflow_dispatch` only. Both are isolated
from the required validation job and are allowed to fail: a Robinhood live
read, and `jev:characterize`. The Jev job reads `TYPESAFE_API_KEY` from a
repository secret and exits with code 2 when it is absent, so a run without
credentials is recorded as a skipped characterization rather than a pass. It
never runs on a push or a pull request, and the key never reaches the required
job.

## Solidity (Phase 6)

A separate `solidity` job validates the execution gate on every push and pull
request:

1. `npm ci`, then Foundry `v1.7.1`; `forge-std` is a git submodule pinned to
   `v1.16.2`, OpenZeppelin Contracts an exact-pinned npm devDependency (`5.6.1`);
2. `forge fmt --check`, `forge build --sizes` and `forge lint --deny notes` over
   the deployable code;
3. `npm run gate-corpus:generate`, which writes the ABI form of the committed
   differential corpus that `Differential.t.sol` replays;
4. the unit, fuzz and differential suites, then the stateful invariant suite;
5. Slither `0.11.6`, last, with `fail_on: low`: a finding not already reviewed
   and justified in code fails the job. Slither's build skips tests, so it runs
   after them.

The validation job's `generated:check` also regenerates `corpus/gate-v1` and
fails on any diff. Findings and their dispositions are in
[execution-gate.md §14](execution-gate.md#14-slither-findings).

There is intentionally no deployment job. Nothing in CI deploys a contract,
holds a key, or contacts a chain.

