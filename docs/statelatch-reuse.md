# StateLatch / EquityGuard reuse assessment

Assessment of the prior codebase for reuse in Mandate.

> **Status: Phase 0 assessment, complete.** The prior repository was located
> locally and inspected. Nothing has been copied into Mandate; this document
> records what is worth carrying over, in what form, and what must not be.

## 1. What was inspected

| | |
| --- | --- |
| **Location** | `/Users/mahesh/Desktop/Stocklana2026/EquityGuard` |
| **Inspected at** | Phase 0, on the `main` branch |
| **Naming history** | The product was renamed across its life — StateLatch, then EquityGuard, then StateGuard — while the repository directory and Rust crate kept the `equity_guard` name |
| **Platform** | Solana. Native Rust on-chain program (no Anchor), TypeScript clients on `@solana/kit`, Token-2022 `ScaledUiAmount`, Jupiter `route_v2` composition |
| **Web** | Next.js 16 / React 19 site with a design-token system and a live demo |

### Approximate volume

| Area | Lines |
| --- | --- |
| On-chain program source (`programs/equity_guard/src`) | ~2,800 |
| On-chain program tests | ~6,800 |
| Guard client (`packages/guard-client/src`) | ~1,900 |
| Representation state (`packages/representation-state/src`) | ~4,200 |
| Jupiter composition (`packages/jupiter/src`) | ~1,700 |
| TypeScript tests (96 test files) | ~17,100 |
| Web app components and routes | ~9,700 |
| Shared design system | ~1,300 |
| Scripts (devnet, observation, evidence, research, demo) | ~12,600 |

The ratio worth noting: roughly 24,000 lines of tests against roughly 10,600
lines of product source. That ratio, and what it was spent on, is the single
most valuable thing in the prior repository.

## 2. What Mandate is, relative to the prior project

The prior project solved **one** problem well: a tokenized equity's on-chain
economic state can change between quote and settlement, so move the check into
execution time and fail atomically if it changed. It was corporate-action-aware
slippage protection for a single chain and a single instrument mechanism.

Mandate is a superset in scope and a different shape:

| | Prior project | Mandate |
| --- | --- | --- |
| Question | Did the protected state change between quote and execution? | Is this execution inside the authority a human granted? |
| Authorization | Implicit — the user signed a transaction | Explicit — a signed, machine-readable mandate |
| Asset identity | Mint address, with a registry of "same underlying" | Canonical financial identity, asset-class agnostic |
| Constraints | Economic state equality | Issuer, instrument type, backing, rights, jurisdiction, notional, deviation, venue, chain, freshness, expiry |
| Agent model | None — a human clicks | Bounded agent authority is the central primitive |
| Chain | Solana | EVM, Arbitrum-compatible first |

So the prior work is **an input to Mandate's execution gate and its state
model**, not a foundation Mandate is built on top of.

## 3. Reuse verdicts

Legend: **ADOPT** — carry the idea over deliberately. **PORT** — the artifact
is worth re-deriving in the new stack. **LIFT** — the artifact can be reused
largely as-is. **REBUILD** — same problem, different enough that copying costs
more than it saves. **REJECT** — do not carry over.

### 3.1 Concepts and methodology — the highest-value reuse

| Item | Verdict | Notes |
| --- | --- | --- |
| **Execution-time verification rather than quote-time** | **ADOPT** | The core insight. State is checked where execution happens, atomically, not where the decision was made. It is why Mandate has an execution gate ([design §14.3](mandate-design.md#143-the-execution-gate)) rather than trusting an off-chain PASS |
| **Clock is part of economic state** | **ADOPT** | Stored bytes can be unchanged while their *meaning* changes at a scheduled instant. The prior project learned this the expensive way with `ScaledUiAmount` activation timestamps. Recorded as [INV-10](mandate-design.md#16-major-invariants) and [design §13.5](mandate-design.md#135-scheduled-transitions-and-the-clock) |
| **Refusal window around a scheduled transition** | **ADOPT** | Refusing execution inside an inclusive interval around a scheduled activation, with the phase before and after treated as protected state. The leading candidate mechanism for corporate-action epochs ([design §13.4](mandate-design.md#134-corporate-action-epoch)) |
| **`UNKNOWN` is a state, not an exception** | **ADOPT** | Already an architecture rule. Prevents the most common fail-open bug: a `catch` that treats "could not determine" as "fine" |
| **Fail-closed on unparseable or unsupported input** | **ADOPT** | Including: an adapter kind with no understood semantics is refused rather than falling back to a generic check |
| **No floating-point equality in a safety decision** | **ADOPT** | The prior project compared multipliers by stored bytes and rejected non-normal floats. [INV-16](mandate-design.md#16-major-invariants) |
| **Cross-representation comparison in a common economic unit** | **ADOPT** | Its `INV-VAL-01` forbade comparing raw output amounts across issuers and required exact rational arithmetic with one-sided rounding, so a substitution cost is never understated. Directly reusable reasoning for [design §12.3](mandate-design.md#123-ranking) |
| **No silent rerouting between issuers** | **ADOPT** | Its `I-7`. Becomes [INV-14](mandate-design.md#16-major-invariants) |
| **Commitment binding of the downstream action** | **ADOPT** | A hash commitment over every security-relevant field of the protected action — program, accounts, flags, order, data — so any post-verification mutation fails. The mechanism behind [INV-13](mandate-design.md#16-major-invariants) |
| **The gate checks its own position** | **ADOPT** | Ordering is not left to the transaction builder's good behaviour; the gate reads the instruction list and verifies what it precedes |
| **Consent as a single-use, expiring, bound capability** | **ADOPT** | Consent that is opaque, single-use, slot-expiring and bound to one exact disclosure — a structurally identical copy is not consent. Directly applicable to mandate nonce consumption and to reauthorization |
| **Provenance is a required field; conflicts fail closed** | **ADOPT** | Its `StateSource` distinguished chain-only, API-only, agreement and conflict, and never reconciled a conflict. Becomes [INV-17](mandate-design.md#16-major-invariants) |
| **Invariant enumeration with an evidence column** | **ADOPT** | Each invariant stated with its enforcement level (on-chain / client / both / operational / limitation) and the tests establishing it. Mandate's §16 adopts the structure |
| **Differential and conformance testing** | **PORT** | A shared corpus of decision vectors exercised against independent implementations. Applies directly to off-chain verifier versus on-chain gate ([design §10.5](mandate-design.md#105-differential-verification)) |
| **Property testing over seeded corpora** | **PORT** | Used for rounding one-sidedness, consent semantics and plan authenticity. The methodology ports; the properties are Solana-specific |
| **Adversarial-stub testing** | **PORT** | Its malicious-builder and mutation-matrix tests are the model for Mandate's adversarial-Jev test establishing [INV-3](mandate-design.md#16-major-invariants) |
| **Capture isolation discipline** | **ADOPT if capture is built** | Live evidence capture is append-only and single-writer; analysis runs only on sealed snapshots. Relevant only if Mandate records live market observation |

### 3.2 Documentation structure

| Item | Verdict | Notes |
| --- | --- | --- |
| `docs/invariants.md` with a test-obligation table | **PORT** | Structure adopted in [design §16](mandate-design.md#16-major-invariants); contents are Solana-specific |
| `docs/security-invariants.md` enumeration with status levels | **PORT** | The on-chain / client / both / operational / limitation taxonomy is genuinely good and is the right target for Mandate once components exist |
| `docs/threat-model.md` with a known-limitations section | **PORT** | Particularly the discipline of writing down what is *not* protected. [Design §17.6](mandate-design.md#176-honest-statement-of-limits) follows it |
| ADR format | **ADOPT** | Two ADRs existed and were short and useful. Mandate should adopt ADRs from Phase 1 |
| Demo-boundary disclosure doc | **ADOPT** | Explicit documentation of the seam between live and engineered data |
| `AGENTS.md` | **PORT — done** | Mandate's [AGENTS.md](../AGENTS.md) is a rewrite in the same spirit: the same git boundary, commit discipline, honesty requirements and phase reporting gate, restated for Mandate's scope |

### 3.3 Code

| Item | Verdict | Reason |
| --- | --- | --- |
| On-chain guard program (`programs/equity_guard`) | **REBUILD** | Native Solana Rust, Token-2022 account model, Instructions sysvar, LiteSVM harness. Mandate's gate is EVM. Nothing survives the port except the design ideas already listed in §3.1 |
| `packages/guard-client` (ABI encode/decode, deployment pinning, snapshots) | **REBUILD** | Same reason. One idea ports explicitly: refusing to build against a deployment whose recorded program identity or ABI version is not the pinned one, re-checked immediately before signing |
| `packages/jupiter` (route composition, grammar validation) | **REJECT** | Jupiter-specific. Mandate must not preserve Solana/Jupiter assumptions. The transferable idea — a venue adapter validating a transaction against a fixed grammar rather than trusting a builder — is already in [design §12.5](mandate-design.md#125-venue-adapters) |
| `packages/representation-state` — `registry.ts` | **PORT** | Its underlying-to-representation registry with an explicit "membership is not equivalence" doc comment is the closest prior art to Mandate's representation registry. The *model* ports; the Solana `Address` types and the two hardcoded issuers do not |
| `packages/representation-state` — `types.ts`, `normalize.ts`, `compare.ts` | **PORT** | `SAFE`/`TRANSITION`/`PAUSED`/`UNKNOWN`, the calibrated-versus-uncalibrated policy distinction, and exact rational comparison are all reusable reasoning |
| `packages/representation-state` — `decision.ts` | **PORT** | A pure decision function returning outcomes as values with reason codes, never throwing. Structurally what Mandate's verifier is, over a much narrower constraint set |
| `packages/representation-state` — `execution-plan.ts`, `consent.ts` | **PORT** | Runtime-provenance authenticity (a plan is authentic because it was created by the factory, not because its content hashes correctly), single-use consumption, slot-based freshness. Strong ideas; the code is Solana-bound |
| `packages/representation-state` — `xstocks-adapter.ts`, `ondo-adapter.ts`, `xstocks-api.ts` | **REJECT** | Issuer- and Solana-specific. The independent-adapters-with-no-shared-semantics rule ports; the adapters do not |
| `scripts/observation/*`, `scripts/devnet/*`, `scripts/evidence/*` | **REBUILD** | Solana RPC and devnet tooling. The capture-isolation discipline is the reusable part |
| `apps/web` components and routes | **PORT** | See §3.4 |
| `apps/shared/design-system` (tokens, base, layout, components, motion) | **LIFT** | See §3.4 |
| Root tooling: `tsconfig.json`, `clippy.toml`, `rustfmt.toml`, CI workflow | **PORT** | Strict TS config and the CI shape (fmt → lint → typecheck → test → build, plus a pinned dependency audit) are worth copying as patterns once Mandate has code to check |

### 3.4 Web, design and demo

This is where the largest volume of directly reusable work sits, because it is
the least chain-specific.

| Item | Verdict | Notes |
| --- | --- | --- |
| Design token system (`apps/shared/design-system/tokens.css`) | **LIFT, re-palette** | Every colour, type step, space, radius, shadow and motion curve resolves through one token file, so a palette change is a one-file change. Structure lifts directly; the EquityGuard blue palette and `--eg-` prefix do not |
| Typography (Geist Sans / Geist Mono, self-hosted woff2, OFL licensed) | **LIFT** | Self-hosted, licence included. No reason to redo |
| Accessible semantic colour pairs | **ADOPT** | The token file carries darkened variants of success/blocked specifically because the primary pair reached only ~4.1:1 on its own tinted background. That contrast work is worth keeping as a rule |
| `base.css`, `layout.css`, `components.css`, `motion.css` | **LIFT, re-prefix** | Framework-agnostic CSS |
| Route shell, nav, footer, skip-to-content, page backdrop | **PORT** | Standard scaffolding, already accessible |
| Reveal/scroll and atmosphere components | **PORT, optional** | Presentation only. Carries dependencies (`motion`, `lenis`, `ogl`); take only what earns its weight |
| Docs diagram components (`docs-diagrams.tsx`, `diagram-shell.tsx`) | **PORT** | A pattern for rendering architecture diagrams in-page. Mandate has more to explain than the prior project did |
| Demo experience components | **PORT — structure only** | The valuable structure is a demo that shows a *refusal* as the headline result, with the reason visible. Mandate's demo shows the same shape over a richer constraint set. The Phantom/Solana wallet integration does not port |
| Next.js app scaffolding, metadata, sitemap, robots, manifest | **LIFT** | Ordinary but real work |
| Demo-boundary disclosure in the UI | **ADOPT** | The hard visual separation between live read-only data and engineered demo data |

## 4. What must not be carried over

Stated explicitly, because these are the failure modes of reuse.

1. **Solana and Jupiter assumptions.** Token-2022 `ScaledUiAmount`, mints and
   ATAs, the Instructions sysvar, `route_v2` grammar, LiteSVM, `@solana/kit`.
   Mandate's first target is EVM. Where a Mandate concept resembles a Solana
   one, it must be re-derived from the EVM environment's actual semantics, not
   translated.
2. **Prior naming.** StateLatch, EquityGuard, StateGuard, `equity_guard`,
   `--eg-` CSS prefixes, `EQUITYGUARD_*` environment variables and domain
   separators. The prior project renamed itself twice and still carries all
   three names internally; Mandate should not inherit that.
3. **Hackathon-specific metrics and claims.** Compute-unit baselines, "4,658
   CU to pass", test-vector counts, deployment addresses, release-candidate
   manifests, evidence bundles, milestone identifiers (`M9D-B2`, `M11C`).
   None of it describes Mandate, and importing any of it would be a false
   claim under [AGENTS.md §5](../AGENTS.md#5-honesty-requirements).
4. **Compatibility layers.** No adapter, shim or translation layer exists to
   bridge the prior codebase to Mandate. There is no consumer of one. Reuse
   here means re-deriving a design, not maintaining an interface.
5. **The single-instrument scope freeze.** The prior `AGENTS.md` explicitly
   forbade "EquityIntent, solver networks, generalized intent schemas,
   generalized SDKs" — correct for that project's scope, and the opposite of
   Mandate's thesis. Do not import that scope freeze; Mandate needs its own,
   which is [design §21](mandate-design.md#21-explicit-non-goals-for-the-mvp).
6. **Its threat model's conclusions.** Its threat rows are about Solana
   transaction composition. Mandate's threat model is its own
   ([design §17](mandate-design.md#17-threat-model-overview)); the prior one is
   useful as a structural template only.

## 5. Where reuse saves the most time

Ordered by expected saving:

1. **Design and web** (~11,000 lines of CSS, components and scaffolding). The
   token system, typography, layout, accessibility work and demo structure lift
   or port with palette and prefix changes. This is the largest single saving
   and carries the least risk.
2. **Test methodology.** Differential corpora, property tests over seeded
   inputs, adversarial stubs, mutation matrices and the invariant-to-test
   obligation table. Knowing *what kinds of tests* establish an execution-safety
   invariant is worth more than any individual test.
3. **Representation-state modelling.** `SAFE`/`TRANSITION`/`PAUSED`/`UNKNOWN`,
   provenance and conflict handling, exact cross-representation comparison, and
   the registry's deliberately weak membership claim. Re-derived in Mandate's
   type system rather than copied.
4. **Documentation structure.** Invariants with evidence columns, security
   invariants with enforcement levels, threat models with known-limitations
   sections, ADRs, demo-boundary disclosure.
5. **Engineering rules.** Already applied — [AGENTS.md](../AGENTS.md).

Notably, the on-chain program — the prior project's hardest and most novel
engineering — is the *least* reusable artifact, because it is Solana-native.
Its ideas reuse completely; its code does not reuse at all.

## 6. Actions for later phases

| Phase | Action |
| --- | --- |
| 1 | Adopt the ADR format. Build the verifier against the prior `decision.ts` shape: pure, outcomes as values, reason codes, never throws. Establish the differential decision-vector corpus from the start rather than retrofitting it |
| 2 | Re-derive the representation registry from `registry.ts`'s model, with the membership-is-not-equivalence rule preserved in the type system and not only in a comment |
| 3 | Re-derive state normalization from `types.ts` / `normalize.ts`: `UNKNOWN` as a value, provenance required, conflicts fail closed, exact arithmetic |
| 5 | Model the adversarial-Jev test on the prior malicious-builder and mutation-matrix suites |
| 6 | Re-derive the execution gate from the prior guard's ideas — commitment binding over every security-relevant field, self-position checking, read-only and side-effect free, deployment identity pinned and re-checked before signing — implemented natively for EVM |
| 8 | Lift the design token system and typography; re-palette and re-prefix. Port the route shell, diagram components and the refusal-first demo structure. Port the demo-boundary disclosure |

## 7. Licensing and provenance

Before any file is copied rather than re-derived, confirm ownership and
licensing of each artifact, and in particular:

- the Geist font files carry their own OFL licence, which must travel with them;
- third-party web components adapted into the prior project (scroll and
  atmosphere effects) may carry their own terms.

Copied files record their origin in a comment. Re-derived designs are credited
here and do not need per-file attribution.
