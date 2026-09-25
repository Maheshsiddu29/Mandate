# Continuous integration

The `deterministic-validation` GitHub Actions workflow is validation-only. It
does not publish, deploy, trade or use wallet credentials.

Every push and pull request runs on Node 22 and performs:

1. `npm ci` from the committed lockfile;
2. strict TypeScript checking and all deterministic tests;
3. offline Robinhood fixture validation;
4. Phase 3 and Phase 4 mainnet replay validation;
5. cross-surface validation;
6. credential and repository-junk scanning;
7. regeneration followed by a clean-diff check for all corpora and generated
   reason-code documentation;
8. `npm audit --audit-level=high`.

The normal workflow has no dependency on Robinhood REST or RPC availability.
An optional Robinhood live-read job exists only for manual `workflow_dispatch`,
is isolated from the required validation job, and is allowed to fail. It still
performs reads only.

There is intentionally no deployment job.

