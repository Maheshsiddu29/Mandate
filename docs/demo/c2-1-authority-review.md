# C2.1 — Authority Review & Advanced Permissions UI

> **Status: Milestone C2.1 design, opened 2026-10-03 against HEAD
> `b097f243e51d0690885b91b595147bd8705f0535`.**
> Additive UI/authoring presentation on top of C2.0. Does not change
> frozen portfolio wire semantics, C1 settlement, or contracts.
> Trust boundary unchanged: the model drafts; the user reviews; the
> wallet signature grants authority.

```text
THE MODEL DRAFTS.
THE USER REVIEWS.
THE WALLET SIGNATURE GRANTS AUTHORITY.
```

---

## 1. Current Review flow

```text
PROMPT → DRAFTING → CONFIGURE
  (agents, allocation, open issues, advanced sheet)
  → ready = validation.ok && draft.issues.length === 0
  → APPROVE (read-only authority summary + wallet/demo sign)
  → run → …
```

Key modules:

| Piece | Path |
| --- | --- |
| Phase machine | `apps/web/components/demo/live/live-flow.ts` |
| Orchestrator | `apps/web/components/demo/live/live-lab.tsx` |
| Configure / Approve / Permissions | `apps/web/components/demo/live/stage-configure.tsx` |
| Allocation UI | `apps/web/components/demo/live/stage-planning.tsx` |
| Draft + issues | `packages/live-agents/src/authoring/draft-types.ts` |
| Compiler | `packages/live-agents/src/authoring/compiler.ts` |
| Validation | `packages/live-agents/src/authoring/draft-validator.ts` |
| Wallet draftKey | `packages/live-agents/src/wallet/challenges.ts` |

C2.0 already added a hierarchical `mw-authority-review` on Approve.
C2.1 deepens it into a production Review: blockers, unsupported,
conflicts, edit, and sign gating on the exact canonical draft.

---

## 2. Current MandateDraft shape

Unchanged from C2.0: `portfolio` · `agents[Role]` · `market` ·
`execution` · `issues[]` · `notes[]` · `provenance` · `evidence`.

No parallel UI authority object. Review derives a presentation model
from the draft + `classifyAllocation` + validation; edits write back
through `POST …/draft/field` (`USER` provenance) and existing plan APIs.

---

## 3. Blocking vs non-blocking issues

| Kind | Blocks sign? | Dismissible? |
| --- | --- | --- |
| `CONFLICT` | Yes | Only by choosing a value / editing (then resolve) |
| `AMBIGUOUS` | Yes when authority-relevant | Only by supplying the missing value |
| `NEEDS_CLARIFICATION` | Yes when it gates agents/limits | Guided edit or resolve after edit |
| `UNSUPPORTED` soft (per-trade, fee-bps) | Yes until explicit acknowledge | Acknowledge: “not in signed mandate” |
| `UNSUPPORTED` dangerous (recipient, calldata, ignore-limits, any-venue) | Yes | **Never** via dismiss — refuse |
| Validation `MISSING_VALUE` / allocation / CHILD ⊄ PARENT | Yes | Fill or edit |

Notes from the interpreter are non-blocking display.

---

## 4. Editable fields

All `DRAFT_FIELD_PATHS` except trusted execution secrets. In Review Edit:

- portfolio totals, reserve, max deployed, exposures, validity, autoReallocate
- per-agent enabled / maxAllocation / budget / maxExposure
- market sets (catalog ids), leverage, slippage, quote age

## 5. Read-only / non-editable

Never user-editable as free text:

- recipient addresses outside catalog
- Gate / adapter / token contract / chain ID
- calldata / signer / execution commitment / reservation digest

Catalog recipient ids remain the only execution.recipients path
(advanced permissions sheet), unchanged.

---

## 6. Unsupported instruction treatment

Show a dedicated section:

**Requested but not enforceable in this mandate version**

Each item: label, requested value (when known), status **Not supported**,
and the sentence: *This restriction will NOT be included in the signed
mandate.*

Dangerous items: no “accept anyway”; Authorize stays disabled.

Soft items: explicit **I understand — continue without this** that
calls `resolveIssue` after the user has seen the warning.

---

## 7. Ambiguity resolution

Inline on Review / Configure:

- “Half of what total?” → capital input → field set + issue resolved
- NEEDS_AGENT_SELECTION → agent chooser (existing) before Approve

## 8. Conflict resolution

Prominent **Needs your input** card. Capital form vs prompt:

`[$800] [$2,000] [Edit manually]`

Choice writes `portfolio.totalCapital` (and maxDeployed when appropriate)
with `USER`, removes the conflict issue, revalidates.

---

## 9. Provenance presentation

Primary rows: subtle chips (From your prompt / Entered manually /
Derived / Suggested). Collapsible **How this was interpreted** may
list path → value → source (+ evidence.sourceText). No CoT.

## 10. Advanced permission grouping

| Group | Fields shown when meaningful |
| --- | --- |
| Execution limits | leverage, slippage, quote age; leverage “Not granted” if Perps enabled and unset |
| Exposure | maxDerivative, maxIlliquid, agent maxExposure |
| Assets & venues | assets/venues/issuers when set; “Approved only” when full catalog |
| Mandate lifecycle | validity, autoReallocate, minUnallocated |
| Risk preference | from notes only, labelled **Advisory** |

Omit null noise; keep omission-matters cases visible.

## 11. Allocation review

Product language for FIXED / DYNAMIC / HYBRID / NEEDS_AGENT_SELECTION
(see C2.0 / Room V2). Planning Room before sign when required.
Single-agent: no Room; “Agent plan” copy preserved.

## 12. Sign-button gating

Authorize disabled while any Review blocker exists. Approve re-checks
`ready` (not only Configure). Server remains fail-closed.
Wallet `draftKey` invalidates typed data if the draft mutates.

## 13. Accessibility

Text states for enabled/disabled/not selected/conflict; semantic
headings; focusable controls; not color-only.

## 14. Mobile / demo quality

Compact cards; advanced collapsed; critical authority above the fold;
no JSON dumps or hash walls.

## 15. Trust boundary

```text
Review UI ─▶ field/plan APIs ─▶ MandateDraft
         ─▶ validateDraft ─▶ prepare ─▶ EIP-712 V2
Extraction / model / Jev: never authority.
```

## 16. Non-goals

Protocol redesign; new wire fields for per-trade/fee; C1 changes;
browser broadcast; parallel authority types; CoT display.

## 17. Test plan

Web: Review model from draft, blockers, conflict/ambiguity/unsupported
rendering, soft vs dangerous unsupported, edit validation strings,
sign disabled while blocked, provenance labels, allocation modes,
$800≠$2500 regression strings.

Authoring: dangerous issues not resolvable; capital conflict resolution
updates draft; review blockers helper; draftKey still fails on mutation.

Manual judge prompts 1–8 as in the milestone.

---

## Implementation sketch

| Module | Role |
| --- | --- |
| `authority-review.ts` (web) | Pure presentation + blocker list from draft JSON |
| `issue-policy.ts` (live-agents) | Dangerous vs soft unsupported; resolve rules |
| `ApproveStage` | Full Review IA + inline resolve + edit entry |
| `live-lab.tsx` | Wire blockers into Approve sign gate; conflict actions |
