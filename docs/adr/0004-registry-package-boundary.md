# ADR 0004: Registry package boundary and purity

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

Phase 2 adds the layer that answers two questions the kernel deliberately
cannot: *what real financial asset did the principal mean*, and *which concrete
tokenized representations may legitimately be considered for satisfying that
mandate*.

[ADR 0003](0003-kernel-language-and-dependency-boundary.md) fixed the kernel's
dependency boundary and stated the direction later phases must respect: "later
phases add those as separate packages that depend on the kernel — never the
reverse." [architecture §5](../architecture.md#5-structural-rules) makes the
same point as a structural rule rather than a convention.

Two questions had to be settled before any registry code was written.

1. **Where does the registry live?** Folding it into `packages/kernel` would be
   the smallest diff. It would also make the kernel aware of data-provider
   infrastructure, and the kernel is the component that must stay portable
   enough to be reimplemented in Solidity for the execution gate.
2. **Is the registry allowed to perform I/O?** A registry is conventionally a
   thing that reads a database or calls an API. That convention is the reason
   registries are hard to test and impossible to replay.

## Decision

**A separate package, `packages/registry` (`@mandate/registry`), which depends
on `@mandate/kernel` and which performs no I/O.**

### Dependency direction

```
registry  ──▶  kernel          permitted, and the only permitted direction
kernel    ──▶  registry        forbidden, structurally
```

The kernel keeps its own dependency allowlist unchanged (`@noble/hashes`,
`@noble/curves`). The registry's runtime dependency allowlist is exactly one
entry: `@mandate/kernel`. It adds no third-party dependency of its own, so the
audited surface of the two safety-relevant packages together remains the two
crypto packages ADR 0003 allows.

Enforcement is structural, not remembered:

- the kernel's `structure.test.ts` already asserts that every non-relative
  import in `packages/kernel/src` starts with `@noble/`, which makes a kernel →
  registry import fail. Phase 2 adds an explicit assertion naming the registry,
  so the *intent* is legible in the test output rather than inferred from a
  generic rule;
- the registry's own `structure.test.ts` asserts the registry imports nothing
  outside itself and `@mandate/kernel`;
- both tests assert the reverse direction by scanning the *other* package's
  sources, so the check survives someone reading only one package.

### Purity

**The registry performs no network access, no filesystem access, no clock read,
no randomness and no environment read.** It is a set of pure functions over
values, exactly like the kernel.

A registry decision is therefore a function of its inputs alone:

```
decide(requirements, representationId, snapshot) -> decision
```

and never of mutable global process state, which is what makes
[§registry snapshots](../registry-semantics.md#7-snapshots-and-reproducibility)
replayable.

Consequences of this that are deliberate:

- **the registry does not load its own data.** A `RegistrySnapshot` is
  constructed from values. Phase 3 adapters do the I/O, normalize what they
  observed, and hand the registry a snapshot. There is no code path in the
  registry that can reach a provider;
- **there is no "real" and "simulation" registry.** A synthetic world and a
  mainnet fixture both become a `RegistrySnapshot` and flow through the same
  resolution and admissibility logic. Two decision engines that are supposed to
  agree are a vulnerability, not a convenience
  ([design §10.5](../mandate-design.md#105-differential-verification));
- **development fixtures and world builders ship as a labelled subpath**,
  `@mandate/registry/testing`, rather than as test-tree-only code, because
  Phase 4's route and simulation work needs them. Everything under that subpath
  is pure and is labelled synthetic.

### The one thing the registry may not decide

The registry decides **membership** and **admissibility against supplied
requirements**. It does not authorize. The deterministic verifier remains the
sole authorization authority
([design §22.2](../mandate-design.md#222-the-one-structural-commitment)), and
the registry's own output is an input to it, re-checked from scratch.

This is why the registry's bridge to the kernel
([`toRepresentationState`](../registry-semantics.md#8-the-kernel-bridge)) emits
kernel `TrustedState` rather than anything resembling a verdict, and why it
fails rather than emitting a permissive value when a field cannot be
established.

## Consequences

**Accepted costs.**

- Two packages to keep in step, and a bridge module between them whose types
  must be maintained by hand. A shared type would be smaller; it would also put
  registry concepts into the component that has to be reimplemented on-chain.
- The registry cannot be handed a directory and told to load it. Every caller
  supplies values. This is more work at the edges and is the property that makes
  replay possible.
- A caller that wants live data must write an adapter. Phase 2 ships none, and
  says so rather than shipping a stub that looks like one.

**Gained.**

- The kernel stays reimplementable without dragging in a registry.
- Registry decisions are reproducible from a recorded snapshot, which is what
  lets a Phase 2 decision vector be a permanent compatibility contract.
- "No live API calls in the registry" is machine-checked rather than asserted.
