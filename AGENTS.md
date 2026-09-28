# AGENTS.md

Operating rules for Claude Code and any other coding agent working in this
repository. **These rules override agent defaults.** Read this file before
making any change.

Human contributors follow the same rules except where a rule names agents
specifically.

---

## 1. Project purpose

Mandate is intent-aware execution infrastructure for AI agents transacting in
tokenized financial assets. It separates canonical financial asset identity
from token representation, expresses authorization as a machine-readable
financial mandate, and gates execution behind a deterministic verifier that has
final authority over whether an action is permitted.

The canonical specification is [docs/mandate-design.md](docs/mandate-design.md).
Read it before proposing architectural changes. If a change contradicts it,
either the change is wrong or the document needs updating first — resolve which
before writing code.

The repository has **Phase 7A frozen** — the Mandate Core v1 specification
([docs/core-v1](docs/core-v1/README.md)) — **Phase 7B implemented locally,
awaiting review**: `packages/core`, the Core types, canonical encodings and
validators
([docs/core-v1/implementation-7b.md](docs/core-v1/implementation-7b.md),
[ADR 0020](docs/adr/0020-mandate-core-package-and-encoding.md)) — and **Phase
7C implemented locally, awaiting review**: `packages/ledger`, the authority
graph and principal-wide global authority ledger, with an in-memory reference
store only
([docs/core-v1/implementation-7c.md](docs/core-v1/implementation-7c.md),
ADRs [0021](docs/adr/0021-authority-ledger-package-boundary.md)–[0023](docs/adr/0023-ledger-store-contract.md)). **Phase 6 is
frozen at `dc98df5`**; nothing in Phase 7 may modify
MCE v2, Candidate V3, the gate, its libraries, fixture or replay semantics, or
any canonical vector. Before it came **Phase 6R.2B** (secure gas optimization:
word-level identifier validation and a single-buffer encoder, externally
invisible, awaiting independent security and gas review;
[docs/phase-6r2b-report.md](docs/phase-6r2b-report.md)), after **Phase 6R.2A**
(gas attribution and architecture benchmark — measurement only;
[docs/phase-6r2a-gas-profile.md](docs/phase-6r2a-gas-profile.md)), after
**Phase 6R.1b** (final pre-optimization cleanup;
[docs/phase-6r1b-report.md](docs/phase-6r1b-report.md)), after **Phase 6R.1a**
(reconciliation coherence and fixture trust closure;
[docs/phase-6r1a-report.md](docs/phase-6r1a-report.md)), after **Phase 6R.1** (exact principal notional enforcement;
[docs/phase-6r1-report.md](docs/phase-6r1-report.md)), on top of
**Phase 6** — the onchain execution gate
(`contracts/`, `packages/execution-gate`, [ADR 0019](docs/adr/0019-onchain-execution-gate.md),
[docs/execution-gate.md](docs/execution-gate.md)), implemented and tested locally
against a labelled settlement fixture, **not deployed**, and awaiting review.
Before it came **Phase 5R.3** — Phase 5, the
production-architecture remediation, and the post-remediation audit fixes, all
recorded in
[docs/production-architecture-pressure-test.md](docs/production-architecture-pressure-test.md)
§24. Phase 5R.2 completes stored replay-record validation and local temporal
consistency for reconciliation evidence. Phase 5R.3 completes the explicit
public trust-boundary inventory and totality matrix for ordinary parsed/plain
values, plus parser/encoder fixed-width domain agreement. The canonical encoding is at **MCE v2** for
the mandate and trusted state
([ADR 0014](docs/adr/0014-symmetric-signed-economic-authorization.md)) and the
execution candidate is at **schema v3**
([ADR 0017](docs/adr/0017-layered-candidate-state-commitments.md)): a mandate
carries a signed side-appropriate economic bound; a candidate carries its fee
total, provenance of the state it was built against, and the registry snapshot
digest that state declared; trusted state must declare that snapshot digest. The
candidate's state provenance is committed for audit and is deliberately *not*
compared against the state being verified — only the registry snapshot is, because
only it is structural. Replay resolutions require a validated observed outcome
([ADR 0018](docs/adr/0018-observed-execution-outcomes.md)). Built as of Phase 5R.1: the mandate core kernel
(`packages/kernel`), the canonical asset and representation registry
(`packages/registry`), the read-only Robinhood external adapter
(`packages/adapter-robinhood`), the deterministic candidate/router package
(`packages/router`), the optional Jev advisory layer (`packages/jev`), and
verifier, registry, recorded-mainnet, mainnet-routing, simulation and
Jev-evaluation corpora are built. Phase 6 adds the execution gate and
`corpus/gate-v1`. A real venue integration, any deployment or chain write,
funding and web work are **not** built. Do not start a later phase until it is
explicitly opened, and never deploy or send a transaction without explicit
authorization.

The dependency directions are `adapter → registry → kernel`,
`router → registry → kernel`, `jev → router → registry → kernel`,
`execution-gate → kernel`, `core → kernel` and `ledger → core → kernel`, never the reverse, and it is enforced by structural tests
([ADR 0004](docs/adr/0004-registry-package-boundary.md),
[ADR 0012](docs/adr/0012-jev-closed-set-authority-boundary.md)). The kernel,
registry and router perform no I/O; the Robinhood adapter and the Jev client
own network access, each confined to a single module and each reachable only
through an explicit command.

---

## 2. Git rules

### 2.1 Permitted

- Read repository state: `git status`, `git log`, `git diff`, `git show`.
- Create, modify and delete files in the working tree.
- Stage changes: `git add`.
- Create **local** commits.
- Create and switch **local** branches.

### 2.2 Forbidden — without exception

Agents **MUST NEVER**:

- **push** — `git push` in any form, to any remote, including `--dry-run`
  against a remote that would be modified;
- **force-push** — `git push --force`, `--force-with-lease`, or any variant;
- **merge** — `git merge`, or any operation that integrates branches on a
  remote;
- **create a pull request** — `gh pr create` or any equivalent;
- **publish** — packages, releases, deployments, artifacts, or anything to an
  external registry or host;
- **modify remote Git state** — tags on a remote, remote branches, repository
  settings, the `origin` remote itself, or anything reachable only by writing
  to a remote;
- **rewrite history that has already been reviewed** — no rebase, amend, reset
  or filter over commits the repository owner has seen.

**The repository owner reviews local commits and performs all pushes.** An
agent that believes a push is needed says so in its report and stops.

### 2.3 Destructive changes

- Do not delete or rewrite existing user work without an explicit need, and
  state the need in the report when there is one.
- Before overwriting or deleting a file, read it.
- Prefer additive changes. When something must be removed, remove it in its own
  commit with the reason in the commit message.

---

## 3. Commit rules

### 3.1 Granularity

**Every development phase MUST contain multiple meaningful commits.**

- Never create one giant commit for an entire phase.
- Never create fake granularity with meaningless one-line commits.
- A commit is one coherent engineering unit: a component, a documented
  decision, a group of tests that belong together, a refactor. It should be
  reviewable on its own and should leave the repository in a consistent state.

### 3.2 Format

Conventional prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`,
`ci:`, `perf:`.

The subject line says what changed. The body says what and why — the reasoning
that is not recoverable from the diff. Commit messages are part of the audit
trail of the project's design, not a changelog obligation.

### 3.3 Never commit

- generated artifacts, build output, compiled binaries;
- logs, captures, evidence data, benchmark output;
- scratch files, research junk, one-off scripts that are not part of the
  product;
- dependency directories;
- secrets, private keys, keystores, private RPC URLs, API tokens;
- editor and OS files.

Keep the repository clean. If a file is useful only to the agent while working,
it goes in a scratch directory outside the repository, not in `tmp/` inside it.

---

## 4. Engineering rules

### 4.1 Scope discipline

- Implement what the current phase calls for. Do not build ahead.
- Do not add directories, packages, modules or abstraction layers that no
  current code justifies. A directory is created when it holds real code.
- Scope changes require explicit human approval. If a task appears to require
  going beyond the phase, say so and stop rather than expanding silently.
- Do not build: speculative abstraction layers, generalized plugin systems,
  microservices, message queues, orchestration infrastructure, or a database
  before a real persistence requirement appears.

### 4.2 Safety-critical code

The deterministic verifier and anything it depends on are safety-critical.

- The verifier is **pure**: no network, no filesystem, no clock reads, no
  randomness, no environment. Time is a parameter.
- The verifier is **total**: every input produces a verdict. It does not throw
  to signal a financial decision.
- The verifier is **model-free**: its dependency graph must not contain an
  inference client, directly or transitively.
- **Fail closed.** There is no "proceed anyway" path. `UNKNOWN` is a value that
  causes rejection, never a value that is skipped.
- **No floating-point equality in a safety decision.** Values that gate
  execution are compared in exact representations.
- **Every quantity carries its unit and decimals.** Unit-less quantities must
  not be representable.
- **Every observed value carries provenance and an observation time.**
- **Economic authority lives in the verifier.** A component that does not
  authorize must not carry an economic permission. The router establishes costs
  and ranks on them; `checkEconomicLimit` decides
  ([ADR 0014](docs/adr/0014-symmetric-signed-economic-authorization.md)).
- **Every counted collection is bounded by its parser, at the width of the count
  its encoder writes.** A parser that accepts more than the encoder can
  represent turns a refusal into a thrown error, which is how totality was
  broken before Phase 5R.
- **The passage of time never restores an authorization.** Only an observed
  outcome does
  ([ADR 0015](docs/adr/0015-replay-quarantine-and-reconciliation.md)).
- **Handoff state is explicit and required.** Reusing evaluation state for the
  handoff re-verification must be a visible decision, never a default
  ([ADR 0016](docs/adr/0016-pipeline-time-and-handoff-freshness.md)).

### 4.3 Model output

- Model output — including Jev's — is **advisory, never authoritative**.
- A model never supplies a contract address, a chain ID, an amount, or a
  constraint value.
- A model may not add a candidate to a candidate set, or relax any constraint.
- The system's permitted-execution set must be identical whether a model is
  present, absent, failed or adversarial. Where this can be tested, test it
  with a deliberately adversarial stub.

**As built (Phase 5).** A model is consulted only after the admissible set is
closed. It receives a projection, never a candidate. It returns a name that is
resolved by exact lookup into a local array, and the result is re-verified by
the kernel against current state before handoff. Extending this is governed by
[ADR 0012](docs/adr/0012-jev-closed-set-authority-boundary.md): any change that
would let model output become a value rather than an index is a product
decision, not an implementation detail.

### 4.4 Code quality

- Small modules, explicit errors, clear boundaries.
- No uncontrolled `any` in TypeScript; no `unwrap`/`expect` in Rust production
  paths unless logically impossible and justified in a comment.
- Comments explain *why*, not *what*. Public interfaces are documented.
- No secrets, private endpoints or magic constants in source. Configuration via
  environment variables, typed and validated at the boundary.
- Match the surrounding code's naming, structure and comment density.

### 4.4a Toolchain and validation

TypeScript on Node 22, run directly through Node's type stripping. There is no
build step; `tsc` runs as a typecheck only.

```bash
npm run typecheck     # tsc --noEmit, strict
npm test              # node --test over packages/**/test/*.test.ts
npm run check         # both
npm run corpus:generate   # regenerate corpus/v2/vectors.json
npm run docs:generate     # regenerate docs/reason-codes.md
npm run robinhood:fixtures:validate  # verify pinned real-data digests
npm run mainnet-replay:validate      # replay registry + kernel corpus
npm run robinhood:cross-surface      # validate compatible REST/onchain facts
npm run mainnet-routing:validate     # candidate-set routing replay
npm run routing-simulation:generate  # seeded router safety metrics
npm run jev:fixtures:validate        # offline Jev fixture integrity
npm run jev:evaluate                 # regenerate the advisory evaluation report
npm run jev:benchmark                # local advisory latency cost
npm run jev:characterize             # LIVE: requires TYPESAFE_API_KEY, never in CI
```

Solidity (Phase 6) uses Foundry `v1.7.1` and solc `0.8.37`; `forge-std` is a git
submodule and OpenZeppelin Contracts an exact-pinned npm devDependency:

```bash
npm run contracts:fmt        # forge fmt --check
npm run contracts:build      # forge build --sizes
npm run contracts:lint       # forge lint --deny notes, deployable code only
npm run gate-corpus:generate # corpus/gate-v1 plus its ABI form for Differential.t.sol
npm run contracts:test       # corpus ABI, then forge test (unit, fuzz, differential, invariants)
npm run contracts:slither    # slither . — fails on any finding not reviewed in code
```

Run Slither after tests: its build skips test contracts and leaves a cache that
`forge test` then treats as fresh (`forge build --force` recovers). No command
deploys; `contracts/script/DeployMandateGate.s.sol` is manual only and refuses
every known mainnet.

The Core package's runtime dependencies are fixed to `@mandate/kernel` and
`@noble/hashes` at the kernel's pinned version
([ADR 0020](docs/adr/0020-mandate-core-package-and-encoding.md)). It performs
no I/O, names no venue, and declares no `any`, `unknown` or `Record` type;
`structure.test.ts` enforces all of it. `npm run core-corpus:generate`
regenerates `corpus/core-v1` (part of `generated:check`), and
`npm run core:benchmark` measures encoding cost.

The ledger package's runtime dependencies are fixed to `@mandate/core` and
`@mandate/kernel` ([ADR 0021](docs/adr/0021-authority-ledger-package-boundary.md)).
It performs no I/O, reads no clock, names no venue, implements no domain
module and declares no `any`, `unknown` or `Record` type; its store is an
interface with an in-memory reference implementation only.
`structure.test.ts` enforces all of it. `npm run ledger:benchmark` measures its
hot paths.

The execution-gate package's runtime dependencies are fixed to
`@mandate/kernel`, `@noble/curves` and `@noble/hashes` at the kernel's pinned
versions ([ADR 0019](docs/adr/0019-onchain-execution-gate.md)); it performs no
I/O, and `structure.test.ts` enforces both, plus that its error vocabulary matches
the Solidity gate's.

`jev:characterize` is the only command that contacts TypeSafe. It refuses to
run without a credential and exits with code 2, so a blocked run is never
mistaken for a passing one. Never commit the key.

Both generated artifacts are committed and have tests asserting the committed
file matches what the generator produces. If one of those tests fails, decide
whether the behaviour change was intended before regenerating.

The kernel's runtime dependencies are fixed by
[ADR 0003](docs/adr/0003-kernel-language-and-dependency-boundary.md) to exactly
`@noble/hashes` and `@noble/curves`. The registry's are fixed by
[ADR 0004](docs/adr/0004-registry-package-boundary.md) to exactly
`@mandate/kernel`. Adding any other runtime dependency to either requires a new
ADR, and each package's `structure.test.ts` fails without one.

The Robinhood adapter's runtime dependencies are fixed to `@mandate/registry`
and `@mandate/kernel`. Live capture and checks are explicit commands; normal
tests and `npm run check` remain offline.

The router's runtime dependencies are fixed to `@mandate/registry` and
`@mandate/kernel`. It performs no I/O and contains no inference dependency.

The Jev package's runtime dependencies are fixed to `@mandate/kernel`,
`@mandate/registry` and `@mandate/router`, with no third-party package. Network
access is confined to `src/client.ts`, the credential is read from
`TYPESAFE_API_KEY` in that same module and nowhere else, and library code
writes nothing to stdout or stderr. `structure.test.ts` enforces all four, and
additionally asserts the kernel, registry and router neither declare nor import
`@mandate/jev`.

`npm run corpus:generate` regenerates the verifier corpus and
`npm run registry-corpus:generate` the registry corpus; `npm run docs:generate`
regenerates both reason-code documents. All four artifacts are committed with
tests asserting the committed files match what the generators produce.

Node's type-stripping loader does not support TypeScript parameter properties,
enums, namespaces or decorators. Use plain declarations.

### 4.5 Testing

Tests are part of the implementation, not a follow-up.

- A feature is not done without tests that exercise its **failure modes**. In
  this system the rejections are the product.
- Every reason code a component can produce has a test that produces it.
- Fixtures are deterministic. No network in unit tests.
- No coverage-only tests.
- Where the same decision exists in more than one implementation (off-chain
  verifier and on-chain gate, or two language implementations), test both
  against a shared corpus of decision vectors and assert they agree.

### 4.6 Documentation

- [docs/mandate-design.md](docs/mandate-design.md) is the canonical
  specification. Other documents summarize and link to it; they do not
  duplicate it.
- Documentation in `docs/` is updated in the **same commit** as the code it
  describes.
- Capability claims carry honest status labels. Never describe planned work as
  implemented.

---

## 5. Honesty requirements

These are not style preferences. Violating them produces a product claim that
is false.

- **Never claim a component works when it does not.** Phase 0 has no
  implementation; no document may imply otherwise.
- **Never claim a demonstration proves something it does not.** A testnet
  execution against engineered state is not proof of behaviour under a real
  corporate action. Say what was actually demonstrated.
- **Never claim two representations of the same underlying are economically or
  legally equivalent.** They are not, and the whole architecture depends on not
  asserting it.
- **Never present simulated, replayed or engineered data as live.** Where a
  demo shows both, the seam between them is disclosed explicitly.
- **Report validation honestly.** A check that could not run is reported as
  blocked, never as passed. Failing tests are reported with their output.
- **Do not import claims, metrics or benchmark numbers from a prior project.**
  See [docs/statelatch-reuse.md](docs/statelatch-reuse.md).

---

## 6. Phase reporting gate

Work proceeds phase by phase. At the end of each phase the agent stops and
reports:

1. files created, changed and deleted;
2. important decisions made, and assumptions that need approval;
3. local commits in order, with hashes;
4. validation commands run and their actual results, including failures and
   anything blocked;
5. `git status`;
6. unresolved questions and risks;
7. recommended scope for the next phase.

The agent then waits for explicit human approval before starting the next
phase. Do not begin the next phase in the same session on the agent's own
initiative.

---

## 7. Definition of done

A change is done when:

- it stays within the current phase's scope;
- failure-mode tests exist for new behaviour and pass;
- formatting, lint, typecheck, test and build commands available in the
  repository have been run, with results reported honestly;
- documentation in `docs/` reflects the change, in the same commit;
- no secrets, generated artifacts, scratch files or dead code are committed;
- the working tree is clean;
- changes are committed locally in meaningful units — **and not pushed**;
- the phase report has been delivered and the human has approved.
