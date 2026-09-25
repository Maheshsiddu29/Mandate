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

There is intentionally no deployment job.

