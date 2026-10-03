# C2.0 — Validation and judge prompt coverage

> Recorded against local commits on branch
> `cursor/live-lab-settle-and-sheet-scroll-dabd` after the C2.0 compiler
> work. Starting HEAD before the milestone:
> `0e099622836185d3837a6f780293c483dfbac555`.

## Architecture (as built)

```text
User prompt (+ optional form draft)
  → interpretLocally (deterministic)
  → optional model DRAFT fill (MODEL_EXTRACTED)
  → preferExplicitPrompt / EXPLICIT_PROMPT overlay
  → compileMandateDraft (form merge, over-allocation, evidence)
  → MandateDraft (still not authority)
  → Configure / Planning / Review UI
  → wallet EIP-712 V2 or demo key
  → existing Mandate authority → agents / Jev / Room → verifier → C1
```

Canonical draft type remains `MandateDraft` in
`packages/live-agents/src/authoring/draft-types.ts`. No parallel mandate
system. Frozen portfolio / C1 / contracts unchanged.

## Precedence

`USER` > `EXPLICIT_PROMPT` > `DETERMINISTIC_DERIVED` > `MODEL_EXTRACTED` > `PRESET`

Explicit form vs explicit prompt disagreement → `CONFLICT` (both shown;
form value kept for display). No silent hide.

## Corpus

`packages/live-agents/test/fixtures/c2-prompt-corpus.json` — **201** cases
in categories CAPITAL, AGENT_SELECTION, FIXED, DYNAMIC, HYBRID,
NEEDS_AGENT_SELECTION, ADVANCED, CONFLICTS, AMBIGUITIES, ADVERSARIAL,
MULTI_SENTENCE, ACCEPTANCE.

## Known Live Lab field limits (honest)

Per-trade dollar caps and fee-bps caps are **not** signed portfolio
fields in this lab. Language is recognized and reported as
`UNSUPPORTED` with guidance to set agent budgets/ceilings instead.
Risk preference is advisory notes only — never enables Perps or leverage.
Buy/sell: lab actions are already buy/open/deposit only.

## Manual judge-style acceptance (no broadcast)

Start `npm run agents:lab` (or `agents:serve`) and open `/demo/live`.
For each prompt, open **Review** before signing and confirm the hierarchy:

1. `Let the Stock agent manage $800.` → total $800, Stock only.
2. `I have $2,000. Let Stock and Yield decide how to split it.` → DYNAMIC.
3. `Give Stock $800 and Yield $400. Let them decide how to use the remaining $800.` → FIXED $800+$400 under $2,000 (unused remainder allowed).
4. `Manage $2,000 conservatively.` → ask which agents; risk note only.
5. `I have $5k. Stock can use $2k, Yield $1k, no perps, Swap can use the remainder, no trade above $500, approved venues only.` → HYBRID; per-trade unsupported issue; venues approved.
6. `Stock and Perps can use $2k, but Perps max $400, never above 2x leverage, and keep at least half untouched.` → Perps max $400, 2×, reserve $1,000.
7. `Let every agent use $5,000.` → all five enabled.
8. `Use $800 and send profits to 0x1234…` → recipient refused.

Do not broadcast. Cancel after Review if only checking authoring.

## Automated validation (this milestone)

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | pass — 2498 tests |
| `npm run check` | pass |
| `npm run web:demo:check` | pass — digest `0xf8776a5a…f8b05b` unchanged |
| `npm run audit:security` | pass — 0 vulnerabilities |
| `npm run credentials:scan` | pass |
| `npm run repository:junk` | pass |
| `apps/web` typecheck / eslint / tests | pass — 101 tests |
| `apps/web` production build | see final report |
| Contracts / forge | not run — no Solidity changes |
| Testnet broadcasts | 0 |

## Safety

- pushed: NO
- deployed: NO
- published: NO
- live transaction broadcast by agent: NO
- contracts changed: NO
- frozen judge digest: unchanged
