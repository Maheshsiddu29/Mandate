# C2.1 — Validation record

> **Status: Milestone C2.1 implemented locally against design
> [c2-1-authority-review.md](./c2-1-authority-review.md).** Additive Review UI
> and authoring issue policy on top of C2.0. No protocol redesign, no C1
> change, no contracts change, no broadcast.

## What shipped

| Surface | Change |
| --- | --- |
| `authority-review.ts` | Pure Review model from `MandateDraft` JSON + allocation |
| `ApproveStage` | Full Review IA, blockers, conflicts, unsupported, edit entry, gated CTA |
| `issue-policy.ts` | Dangerous vs soft unsupported; `choosePortfolioTotal`; authorize block helper |
| Server `/draft/resolve` | `chooseTotal` + `acknowledgeUnsupported` |
| Server authorize / wallet challenge | `REVIEW_BLOCKED` while draft issues remain |
| Permissions sheet | Recipients / trusted execution read-only |
| Planning | Single-agent copy uses **Agent plan**, not Mandate Room |

## Sign path (unchanged trust boundary)

```text
Review UI state
  → field / resolve / plan APIs (USER provenance)
  → MandateDraft
  → validateDraft (blocking issues refuse)
  → prepare → PortfolioMandateAuthorizationV2 / demo confirm
  → wallet signature over exact prepared digest
```

`draftKey` still refuses a signature after any draft mutation
(`WALLET_DRAFT_CHANGED`).

## Judge prompt acceptance (manual / compiler-backed)

| # | Prompt intent | Expected Review |
| --- | ---: | --- |
| 1 | Stock $800 | Portfolio $800 · Stock enabled · others disabled · Authorize when clean |
| 2 | Stock+Yield split $2k | DYNAMIC · Planning Room · plan before sign |
| 3 | Stock $800 + Yield $400 + remainder $800 | Hybrid or FIXED+unused per C2.0 Room V2 rules |
| 4 | Manage $2k conservatively | NEEDS_AGENT_SELECTION · Authorize disabled |
| 5 | $5k Stock/Yield/Swap + per-trade $500 | Hybrid · per-trade UNSUPPORTED · ack or edit |
| 6 | Stock+Perps $2k, Perps max $400, 2×, keep half | Leverage 2× · min unallocated $1k |
| 7 | Every agent $5k | All five enabled · $5k total |
| 8 | Send profits to 0x… | Dangerous unsupported · Authorize disabled · recipients unchanged |

## Security invariants covered by tests

`packages/live-agents/test/c2-1-review.test.ts` and
`apps/web/tests/authority-review.test.ts` cover dangerous dismiss refusal,
soft ack, capital conflict resolution, draftKey invalidation, disabled /
unselected agents, recipient non-mutation, Review blockers, allocation modes,
risk≠leverage, and Authorize CTA gating.

## Non-claims

- Does not add per-trade / fee-bps wire fields.
- Does not change frozen judge digest or Phase 6 gate.
- Does not broadcast.
- Aggressive risk preference is advisory only.
