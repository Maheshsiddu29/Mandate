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

The repository is currently at the end of **Phase 2**: the mandate core kernel
(`packages/kernel`), the canonical asset and representation registry
(`packages/registry`), and both decision-vector corpora (`corpus/v1`,
`corpus/registry-v1`) are built. Routing, chain adapters, live market data, Jev,
execution contracts and web work are **not** built. Do not start a later phase
until it is explicitly opened.

The dependency direction is `registry → kernel`, never the reverse, and it is
enforced by structural tests in both packages
([ADR 0004](docs/adr/0004-registry-package-boundary.md)). Neither package
performs I/O.

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

### 4.3 Model output

- Model output — including Jev's — is **advisory, never authoritative**.
- A model never supplies a contract address, a chain ID, an amount, or a
  constraint value.
- A model may not add a candidate to a candidate set, or relax any constraint.
- The system's permitted-execution set must be identical whether a model is
  present, absent, failed or adversarial. Where this can be tested, test it
  with a deliberately adversarial stub.

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
npm run corpus:generate   # regenerate corpus/v1/vectors.json
npm run docs:generate     # regenerate docs/reason-codes.md
```

Both generated artifacts are committed and have tests asserting the committed
file matches what the generator produces. If one of those tests fails, decide
whether the behaviour change was intended before regenerating.

The kernel's runtime dependencies are fixed by
[ADR 0003](docs/adr/0003-kernel-language-and-dependency-boundary.md) to exactly
`@noble/hashes` and `@noble/curves`. The registry's are fixed by
[ADR 0004](docs/adr/0004-registry-package-boundary.md) to exactly
`@mandate/kernel`. Adding any other runtime dependency to either requires a new
ADR, and each package's `structure.test.ts` fails without one.

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
