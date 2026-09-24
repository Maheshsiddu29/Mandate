# ADR 0003: Kernel language and dependency boundary

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

Phase 0 specified the verifier's properties
([design §10.1](../mandate-design.md#101-the-contract)) and the structural rule
that its dependency graph must contain no inference client, no network client
and no clock
([architecture §5](../architecture.md#5-structural-rules)). It did not choose a
language, and [AGENTS.md §4.1](../../AGENTS.md#41-scope-discipline) forbids
introducing languages without architectural justification.

Three constraints bear on the choice:

- the first execution environment is EVM (Arbitrum-compatible), so the
  authorization path needs keccak-256 and secp256k1 recovery;
- the kernel will later be consumed by SDKs, MCP/tool interfaces and a web
  demo ([design §22.1](../mandate-design.md#221-mandate-network));
- the same decision logic must eventually be reproduced in Solidity for the
  execution gate, which makes the *encoding* portability question (ADR 0002)
  more important than the kernel's own language.

## Decision

**TypeScript on Node 22, strict mode, as a workspace package with no runtime
dependency that can reach a network or a model.**

Rationale: it is the language the gate's off-chain callers, the SDK surface and
the demo will all be written in, so a TypeScript kernel is consumed directly
rather than through a binding layer. The portability that actually matters —
the digest and the decision vectors — is secured by ADR 0002 and the corpus,
not by the kernel's implementation language.

### Dependency allowlist

The kernel package may depend on exactly two runtime packages:

| Package | Why | Why not hand-rolled |
| --- | --- | --- |
| `@noble/hashes` | keccak-256 | Writing a hash function for financial infrastructure is unjustifiable risk for ~150 lines saved |
| `@noble/curves` | secp256k1 signature recovery | Same, more so |

Both are audited, zero-dependency, and contain no network or filesystem access.
Both are pure functions, so neither violates verifier purity.

Any other runtime dependency requires a new ADR. This is enforced by a
structural test, not by convention: the test walks the kernel's resolved
dependency tree and fails on any package outside the allowlist, and separately
greps kernel sources for forbidden imports (`node:http`, `node:https`,
`node:fs`, `node:net`, `node:child_process`, `Date.now`, `Math.random`, and
inference-client package names).

### Arithmetic

All safety-critical arithmetic uses `bigint`. `number` is permitted only for
array indices, byte offsets and decimal-place counts, each of which is bounded
and checked. No `Number`, no floats, no `parseFloat` in any path reaching a
verdict.

### Structure

```
packages/kernel/        the verifier and everything it needs
corpus/v1/              cross-implementation decision vectors
```

The kernel has no dependency on adapters, registries, model clients, chain
clients or UI, and later phases add those as separate packages that depend on
the kernel — never the reverse.

## Consequences

**Accepted costs.**

- TypeScript's type system is erased at runtime. Branded types (used for trust
  levels and units) are a **compile-time** aid and not a runtime security
  boundary. Every trust and unit constraint that matters is therefore *also*
  checked at runtime, and this ADR is the record that the duplication is
  deliberate rather than redundant.
- `bigint` arithmetic is slower than `number`. Irrelevant at this scale, and
  correctness is the requirement.
- Node's TypeScript type-stripping runs the sources directly without a build
  step, which keeps the toolchain small but means type errors are caught by
  `tsc --noEmit` in CI rather than at run time. Typecheck is therefore part of
  the validation gate, not optional.

**Gained.**

- The kernel is importable by the future SDK, MCP interface and demo without a
  binding layer or a second implementation.
- The "no network, no model" rule is machine-checked rather than asserted.
- Two dependencies is a small enough surface to audit.
