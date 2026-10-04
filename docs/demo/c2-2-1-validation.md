# C2.2.1 — Judge Acceptance Hotfix

> **Status: implemented locally.** Presentation and provider-budget fix only.
> No protocol, Room, settlement-architecture, Solidity, or live-connector
> changes. No broadcasts by the agent.

## Why

Manual C2.2 browser acceptance exposed three issues:

1. Planning Room accepted allocations looked like they contradicted Draft
   authority maxima (plan `$600` vs max `$800`).
2. Multi-agent receipts collapsed authorization and settlement evidence, so
   Yield could read as settled when only Stock had `LIVE_TESTNET`.
3. The advanced judge DRAFT prompt failed with
   `INCOMPLETE (max_output_tokens)` because every request kind shared a
   1,200-token output budget.

## What shipped

| Area | Change |
| --- | --- |
| Plan vs authority | Current plan (`budget`) labelled separately from Maximum authority (`maxAllocation`); Review / Configure / AllocationPanel |
| Receipt | Per-agent settlement evidence: Stock may be `LIVE_TESTNET`; Yield/others `OFFCHAIN_ONLY` with no live connector |
| OpenAI provider | Bounded `max_output_tokens` by request kind (DRAFT 4000, OPPORTUNITY 2400, NEGOTIATION 2000, DECISION 1600, POLICY_STRESS 1200) |
| Security demo | “Try an unauthorized action”; refused cases show pre-execution BLOCKED copy |
| Authoring | Exact advanced judge prompt regression; per-trade remains `UNSUPPORTED` |

## Non-claims / frozen surfaces

Unchanged by design:

- `settleSpine`, SendGate, SettlementJournal, reservation lifecycle
- Gate / portfolio EIP-712, compiler precedence, C2.0 / C2.1 review gate
- `validateDraft`, plan / allocation digests, Room V2 authority semantics
- Contracts and frozen judge digest
- No fake Yield transaction; no silent model→local fallback

## Automated validation

- `npm run typecheck`
- `npm test` (repo packages)
- `npm run check`
- `npm run web:demo:check`
- `npm run audit:security`
- `npm run credentials:scan`
- `npm run repository:junk`
- `apps/web` lint / typecheck / test / production build
- Focused: provider, authoring C2 acceptance, authority-review, c2-2-1-acceptance

## Manual acceptance (operator)

Prefer stop-before-send. Do **not** broadcast a new transaction for acceptance
if an existing settled session is sufficient.

| Flow | Prompt / path | Expect |
| --- | --- | --- |
| A | Let the Stock agent manage $800. | $800 authority · Agent plan · authorize · truthful Stock receipt |
| B | I have $2,000. Let Stock and Yield decide how to split it. | Current plan ≠ Maximum authority; Yield OFFCHAIN_ONLY |
| C | I have $5k. Stock $2k, Yield $1k, no perps, Swap remainder, no trade above $500, approved venues only. | No max_output_tokens failure; per-trade NOT SUPPORTED |
| G | Try an unauthorized action (Security demo) | BLOCKED · valid agent · no tx · no settlement |
| I | Existing SETTLED `?session=` hard refresh + backend restart | Same receipt · no Execute · no new signature |

## Evidence budgets (OpenAI)

| Kind | `max_output_tokens` |
| --- | --- |
| DRAFT | 4000 |
| OPPORTUNITY | 2400 |
| NEGOTIATION | 2000 |
| DECISION | 1600 |
| POLICY_STRESS | 1200 |

Constructor `maxOutputTokens` still overrides every kind. Incomplete responses
still fail closed. `MAX_STREAM_BYTES` unchanged.

## Non-claims

Does not prove mainnet settlement, Yield onchain settlement, NVDA stock-token
purchase, or per-trade limit enforcement. Fixture qualification remains on the
receipt.
