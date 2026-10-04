# C2.0 — Natural-Language Mandate Compiler

> **Status: Milestone C2.0 design, opened 2026-10-03 against HEAD
> `0e099622836185d3837a6f780293c483dfbac555`.**
> Additive only. Extends Live AI Lab authoring in `packages/live-agents`
> and the `/demo/live` review surface. Does not change frozen
> `kernel` / `core` / `ledger` / `control` / `portfolio` wire semantics,
> C1 settlement, contracts, or `MANDATE_JUDGE_DEMO.V1`.

```text
NATURAL LANGUAGE MAY AUTHOR A MANDATE.
ONLY THE REVIEWED + SIGNED STRUCTURED MANDATE GRANTS AUTHORITY.

The model drafts. The human authorizes.
Unspecified ≠ unlimited.
Unmentioned agent ≠ enabled.
```

---

## 1. Current prompt → compose path

```text
User prompt
  → POST /sessions/:id/draft
  → LiveSession.interpret
  → interpretPrompt (model | stub)
       · callModel(DRAFT_SCHEMA)
       · parseDraftInterpretation   (strict JSON)
       · preferExplicitPrompt       (local regex wins on explicit amounts/agents)
       · draftFromInterpretation    (catalog admission)
  → validateDraft                   (conflicts + protocol CHILD ⊆ PARENT)
  → Configure / Planning / Approve UI
  → MandateVersions.prepare → wallet EIP-712 V2 (or demo key)
  → ACTIVE mandate → agents / Room / verifier → (C1) settlement
```

Canonical modules:

| Step | Path |
| --- | --- |
| Orchestrator | `packages/live-agents/src/authoring/prompt-to-draft.ts` |
| Draft types | `packages/live-agents/src/authoring/draft-types.ts` |
| Field edits | `packages/live-agents/src/authoring/draft-fields.ts` |
| Conflicts | `packages/live-agents/src/authoring/conflicts.ts` |
| Validator | `packages/live-agents/src/authoring/draft-validator.ts` |
| Allocation intent | `packages/live-agents/src/allocation/intent.ts` |
| Session | `packages/live-agents/src/session.ts` |
| Model instructions | `packages/live-agents/src/runtime/prompts.ts` (`DRAFT`) |
| Web compose | `apps/web/components/demo/live/stage-compose.tsx` |
| Web review/sign | `apps/web/components/demo/live/stage-configure.tsx` (`ApproveStage`) |

There is **no parallel compose draft type**. The editable object is
already `MandateDraft`.

---

## 2. Current structured draft representation

`MandateDraft` (`draft-types.ts`):

```text
portfolio   PortfolioDraft   — capital, reserve, deploy caps, exposures, validity, autoReallocate
agents      { [Role]: AgentDraft } — enabled, maxAllocation, maxExposure, budget
market      MarketDraft      — catalog sets + leverage / slippage / quote age
execution   ExecutionDraft   — reviewed recipients only
issues      DraftIssue[]     — AMBIGUOUS | CONFLICT | NEEDS_CLARIFICATION | UNSUPPORTED
notes       string[]         — display-only explanations
provenance  { [path]: FieldSource }
```

Amounts are decimal USDC text (`"800"`, `"12.5"`), never floats.
Unset is `null` and **blocks authorization**. A draft carries no
signature, digest or version.

---

## 3. Current supported mandate fields

| Area | Fields |
| --- | --- |
| Capital | `totalCapital`, `maxDeployed`, `minUnallocated`, `deployAll` |
| Exposure | `maxDerivative`, `maxIlliquid` |
| Time | `validityMinutes` |
| Reallocation | `autoReallocate` (`null` ≡ false at sign) |
| Per agent | `enabled`, `maxAllocation`, `maxExposure`, `budget` |
| Market sets | `assets`, `issuers`, `representations`, `venues`, `chains` |
| Bounds | `maxLeverage`, `maxSlippageBps`, `maxQuoteAgeSeconds` |
| Execution | `recipients` (catalog ids only) |

Protocol actions available in the Live Lab are buy/open/deposit only
(`STOCK_BUY`, `SWAP_EXACT_IN`, `NFT_BUY`, `YIELD_DEPOSIT`, `PERP_OPEN`).
There is no sell action in the reviewed scopes.

---

## 4. Current advanced permission fields

Advanced permissions UI (`PermissionsBody` in `stage-configure.tsx`)
exposes Capital, Risk, Markets, Execution, Agent limits — every real
draft path. Guardrails list what `validateDraft` will enforce.

**Not present as Live Lab mandate fields today** (and must not be
silently invented as protocol authority):

- per-trade dollar cap
- fee-bps cap as a mandate field
- risk preference enum
- buy/sell toggles (lab is already buy-side only)

When a prompt asks for those, C2.0 records a structured
`UNSUPPORTED` / `NEEDS_CLARIFICATION` issue rather than inventing wire
fields that the frozen portfolio scope cannot enforce. Agent budgets and
`maxAllocation` remain the enforceable capital ceilings.

---

## 5. Current allocation intent semantics

`classifyAllocation` (`allocation/intent.ts`):

| Intent | When | Planning |
| --- | --- | --- |
| `NEEDS_AGENT_SELECTION` | any `enabled === null` | none — ask principal |
| `FIXED` | every enabled agent has a human budget | none |
| `DYNAMIC` | no enabled agent has a human budget | Room over deployable |
| `HYBRID` | some fixed, some pool | Room over remainder |

Human budget provenance: `INTERPRETED` | `USER` (extended in C2.0 — see §11).
`PLANNED` budgets stay in the delegated pool.
Protocol compile still signs `allocationMode: 'DYNAMIC'` on the mandate
object; FIXED/HYBRID live in draft + `InitialAllocationPlan`.

---

## 6. Current agent-capital semantics

Five roles: `stock`, `swap`, `nft`, `yield`, `perps`.

- `enabled === false` → no authority, no policy entry.
- `enabled === null` → undecided; cannot sign.
- `budget` → max usable this plan (not an obligation).
- `maxAllocation` → signed ceiling; without `autoReallocate`, signed max ≈ budget.
- Fill-from-preset **never** sets `AUTHORITY_CHOICES`
  (`agents.*.enabled`, `portfolio.autoReallocate`).
- When total capital is stated and no separate deploy cap is named, the
  compiler derives `maxDeployed = total − reserve` so a model or balanced
  fill cannot invent a smaller deployable envelope (Scenario C: "$5k" must
  not become "$2,500 available").
- `withinStatedCapital` fills `maxDeployed` from stated total − reserve when
  the principal already named total capital (the $800 vs balanced $2,500
  regression, and the inverse $5k vs balanced $2,500 case).
- Agent `budget` (planned) and `maxAllocation` (signed Up to) stay distinct.
  `"Stock $2k"` sets the planned budget only; balanced fill may still apply
  an $800 preset ceiling, which blocks signing until the principal raises
  the ceiling or reduces the budget — authority is never expanded silently,
  and a preset conflict must not clip the requested budget or dump the
  freed remainder onto a delegated agent (Scenario C: Stock/Yield stay
  $2k/$1k with Swap remainder $2k, never Stock/Yield $800 and Swap $3,400).
- An unsupported per-trade amount never becomes any agent's
  `maxAllocation` / `maxExposure`. Fill-from-preset also skips a ceiling
  whose value equals that unsupported per-trade amount (so balanced
  Swap `$500` cannot masquerade as `"no trade above $500"`).

---

## 7. Current model extraction mechanism

- One `DRAFT` call via `AgentModelProvider.interpretMandateDraft`.
- Closed `DRAFT_SCHEMA`; `parseDraftInterpretation` refuses extra keys
  (no `signature`, no raw addresses).
- Instructions (`prompts.ts`): leave unstated as `null`; never invent;
  never enable unnamed agents; report issues.
- Offline / tests: `interpretLocally` regex parser → same admission path.
- `preferExplicitPrompt`: local explicit amounts and agent choices overlay
  the model so a model cannot replace `"$800"` with a preset-shaped `$2,500`,
  clip a stated budget to a ceiling, invent a fixed budget for a delegated
  remainder agent, or turn an unsupported per-trade amount into an
  aggregate ceiling.

---

## 8. Existing deterministic validators

| Layer | Function |
| --- | --- |
| Field parse | `parseFieldValue` |
| Draft conflicts | `portfolioConflicts`, `agentConflicts` |
| Full validation | `validateDraft` → protocol `validatePortfolioMandate` + `checkPortfolioMandate` |
| Allocation | `classifyAllocation`, `initialAllocationOf` |
| Authorize gate | `MandateVersions.prepare` / `authorize` / `commit` |

Fail closed: missing values, unresolved issues, CHILD ⊄ PARENT, catalog
outsiders, synthetic ALLOWED.

---

## 9. Trust boundary

```text
prompt / model  ──►  MandateDraft (advisory structured data)
                         │
                         ▼
                  principal review + edit
                         │
                         ▼
              signed PortfolioMandate (+ plan digest)
                         │
                         ▼
              agents / Jev / Planning Room   (advisory only)
                         │
                         ▼
              deterministic verifier + ledger
                         │
                         ▼
              C1 settlement (unchanged)
```

**Extraction is outside the execution trust boundary.** Prompt/model
output must never supply recipient addresses, Gate, adapter, calldata,
signer, reservation digest, or chain-derived state. Catalog ids only;
unknown mandatory identities fail closed. Jev remains advisory scoring
and has **no** role in mandate extraction.

---

## 10. Proposed MandateDraft representation

**Reuse `MandateDraft`.** Do not invent a parallel type.

C2.0 adds:

1. Richer `FieldSource` tags (below).
2. Optional `evidence: { [path]: { sourceText: string } }` on the draft
   (span only — never model chain-of-thought).
3. A pure compiler entry point `compileMandateDraft({ prompt, form?, interpretation? })`
   that runs: extract → admit → merge form → derive → conflict → clarify.
4. Clarification records as `DraftIssue` with kind `NEEDS_CLARIFICATION`
   / `CONFLICT` / `AMBIGUOUS` / `UNSUPPORTED` (existing vocabulary).

Conceptual mapping from the milestone sketch:

| Sketch | Existing |
| --- | --- |
| `capital.totalAtoms` | `portfolio.totalCapital` (USDC text ↔ atoms via `parseUsdc`) |
| `agents.*.enabled` | `agents.*.enabled` |
| `allocation.mode` | derived by `classifyAllocation` |
| `advanced.*` | `market.*` + portfolio exposures / validity |
| `ambiguities` / `conflicts` / `unsupported` | `issues[]` |

---

## 11. Field provenance design

Extend `FieldSource` (backward-compatible; old `INTERPRETED` retained):

| Tag | Meaning |
| --- | --- |
| `USER` | Explicit form edit (EXPLICIT_FORM) |
| `EXPLICIT_PROMPT` | Deterministic parse of unambiguous prompt language |
| `MODEL_EXTRACTED` | Model fill where local parser left null |
| `DETERMINISTIC_DERIVED` | Computed from explicit inputs (e.g. half of known total) |
| `PRESET` | Safe envelope fill the principal requested |
| `INTERPRETED` | Legacy local/model admission (treated as human for budgets) |
| `PLANNED` | Accepted Planning Room proposal |

Optional evidence:

```ts
{ sourceText: "Stock manage $800" }  // concise span, never CoT
```

Human budget set for allocation intent:
`USER | EXPLICIT_PROMPT | DETERMINISTIC_DERIVED | INTERPRETED`.

---

## 12. Precedence rules

```text
USER (explicit form)
  > EXPLICIT_PROMPT (unambiguous)
  > DETERMINISTIC_DERIVED
  > MODEL_EXTRACTED
  > PRESET (safe default)
```

**But:** when two *explicit* sources disagree materially
(form `USER` vs prompt `EXPLICIT_PROMPT` on the same authority-bearing
field), emit `CONFLICT` and **do not silently apply precedence**.
The principal must choose.

Precedence applies when one side is absent, a default, or a safe
derivation that an explicit value may replace.

---

## 13. Ambiguity rules

A field is left unset (`null`) with an `AMBIGUOUS` or
`NEEDS_CLARIFICATION` issue when:

- percentage / half / remainder lacks a known base total;
- vague risk language without a bound ("be safe", "trade a little");
- amount grammar fails exact USDC parse;
- agent set is empty after "manage $X" with no roles named →
  `NEEDS_AGENT_SELECTION` (enabled stays null).

Never invent a reasonable-looking value.

---

## 14. Conflict rules

Raise `CONFLICT` (blocking) for:

- form total vs prompt total (both explicit, different);
- deploy-everything vs keep-unallocated;
- over-allocation: Σ fixed budgets > deployable;
- enable + disable same agent;
- "no leverage" + "max 2x" (contradiction);
- auto-reallocate true + "never move budgets";
- allow and block the same catalog member when both are stated.

Do not silently reduce allocations to fit.

---

## 15. Safe defaults

- Unset stays unset; fill-from-preset is explicit principal action.
- `autoReallocate` unset ≡ false at authorization (no silent grant).
- Unmentioned agent: not enabled (and when ≥2 agents are positively
  named, unnamed agents are explicitly `enabled: false`).
- Risk preference language may become a note; it **never** enables
  Perps, raises leverage, widens venues, or sets `autoReallocate`.
- Reviewed catalog bounds remain the ceiling (`REVIEWED_BOUNDS`).

---

## 16. Clarification behavior

Ask the **minimum** structured question:

| Situation | Question |
| --- | --- |
| Capital known, agents unset | Which agents may use this capital? |
| Form vs prompt capital | Which total should Mandate authorize? |
| "Give Stock half" without total | Half of what total portfolio capital? |
| Over-allocation | Which budgets should shrink? |

Optional advanced settings are not interrogated by default.

---

## 17. Unsupported language behavior

Record `UNSUPPORTED` and leave fields unset / narrowed:

- unknown assets/venues outside catalog;
- raw `0x` addresses, calldata, "send to …";
- options, bonds, prediction markets (no agent);
- "use any venue" / "enable everything" without naming agents
  (does not broaden; may need clarification);
- synthetic ALLOWED;
- fee-bps / per-trade caps as mandate authority (not in Live Lab wire);
- absolute timestamps from the model as expiry authority
  (duration intent only → `validityMinutes`).

---

## 18. Adversarial prompt corpus strategy

Committed fixtures under
`packages/live-agents/test/fixtures/c2-prompt-corpus.json` (≥150 cases),
evaluated by a deterministic runner over `interpretLocally` /
`compileMandateDraft` with scripted model overlays where needed.

Categories: CAPITAL, AGENT_SELECTION, FIXED, DYNAMIC, HYBRID,
NEEDS_AGENT_SELECTION, ADVANCED, CONFLICTS, AMBIGUITIES, ADVERSARIAL,
MULTI_SENTENCE, ACCEPTANCE (A–H from the milestone).

Expectations never depend on live-model nondeterminism.

---

## 19. UI changes

- **Review (`ApproveStage`)**: hierarchical authority summary —
  portfolio capital → each agent (enabled / max / budget) → advanced
  limits (per-trade N/A noted only if issue raised; venues; auto
  reallocation; unused capital; leverage; slippage; quote age; validity).
- **Provenance UX**: keep "From your prompt" / "Edited" / "Default";
  add labels for `EXPLICIT_PROMPT`, `MODEL_EXTRACTED`,
  `DETERMINISTIC_DERIVED`. Optional evidence under disclosure, not main UI.
- Clarification issues surface on Configure before sign.
- No model reasoning shown.

---

## 20. Non-goals

- Parallel mandate system or new protocol wire fields without ADR.
- Giving Jev extraction authority.
- Silent enable-all / unlimited leverage from risk words.
- Trusting model wall-clock for absolute expiry.
- Changing C1 settlement, contracts, or frozen judge digest.
- Per-trade / fee-bps protocol enforcement that the Live Lab scope
  does not have (surface as unsupported, do not fake).
- Browser broadcast or any chain write.

---

## 21. Implementation phases

| Phase | Work |
| --- | --- |
| 0 | This document |
| 1–3 | Provenance tags, evidence, `compileMandateDraft`, precedence/conflict merge with form |
| 4–9 | Capital language, agents, allocation modes, unused capital, auto-realloc, risk-as-note |
| 10–16 | Leverage, agent ceilings as trade-like bounds, slippage, assets/venues, exposures, freshness/expiry; unsupported for fee/per-trade/sell |
| 17–19 | Model path + deterministic overrides + clarifications |
| 20–21 | Review UI + provenance labels |
| 22–23 | Corpus + invariant tests |
| 24–27 | Jev boundary, Room semantics preserved, acceptance prompts, backward compat |
| 28–31 | Perf (one DRAFT call), validation commands, manual steps |

---

## 22. Tests

- Expand `prompt-to-draft.test.ts` for acceptance prompts A–H.
- Corpus runner ≥150 cases.
- Invariants listed in milestone Phase 23 (agent max ≤ total unless
  conflict; disabled gets zero; omitted never enabled; explicit
  prohibition beats model; form/prompt conflict visible; no recipient /
  Gate / calldata from prompt; leverage never from risk alone; etc.).
- Existing `$800` Stock / prefer-explicit / `$2,500` regressions stay green.
- No test broadcasts.

---

## 23. Migration / backward compatibility

- Existing sessions with `INTERPRETED` provenance remain readable;
  budget human-set includes that tag.
- Signed historical mandates unchanged.
- Simple prompt `"Let the Stock agent manage $800."` must keep
  total/maxDeployed/stock max = 800; balanced preset fill must not
  replace it.
- C1 settlement path untouched.
- Frozen judge demo digest unchanged.

---

## Core invariant (restated)

Natural language and models may populate a draft.
Only a principal-reviewed, signed structured mandate grants authority.
Every child authority remains a subset of that signed parent.

---

## Validation record

See [c2-validation-report.md](c2-validation-report.md) for corpus size,
manual acceptance steps, and the as-built precedence / field limits.
