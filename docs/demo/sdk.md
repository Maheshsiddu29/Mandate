# C3 — Thin Mandate SDK (`@mandate/sdk`)

> **Status: local developer facade, awaiting review.**  
> Not a new protocol phase. No Solidity, V2, or C2.3 authority-semantics changes.

Mandate isn't limited to the bundled demo agents. External agents can integrate
the same authorization boundary using [`@mandate/sdk`](../../packages/sdk/README.md):

```text
external application
      │
      ▼
@mandate/sdk          (facade only)
      │
      ├── @mandate/live-agents     compile, review gate, V3 challenge types
      ├── @mandate/portfolio       screenProposal, runPortfolio / reserve
      ├── @mandate/control         (via portfolio reservation)
      ├── @mandate/ledger          (via portfolio / control)
      └── @mandate/live-settlement prepare / reconcile adapters (injected)
```

```text
Agents propose. Mandate authorizes. Markets settle.
VALID AGENT ≠ VALID ACTION
```

## Public surface

| API | Delegates to |
| --- | --- |
| `createMandateClient` | Facade constructor |
| `compile` | `compileLocalPrompt` |
| `review` | issue-policy + `validateDraft` + `classifyAllocation` |
| `prepareDelegatedAuthorization` | `LiveSession.spineChallengeV3` |
| `acceptAuthorization` | `LiveSession.authorizeWithWallet` |
| `screen` | `screenProposal` |
| `reserve` | `runPortfolio` → `reserveChild` (execute: null) |
| `prepareExecution` | injected `SettlementBackend` (dry-run) |
| `reconcile` | injected `SettlementBackend` → `reconcileAttempts` |

## Guarantees

- No private principal key in the SDK
- No surprise broadcasts (`prepareExecution` / `reconcile` → `broadcasts: 0`)
- No demo fixture defaults baked into SDK core
- Fail-closed: missing authority, unresolved issues, and portfolio refusals never become `AUTHORIZED`
- Current Stock settlement proof remains valueless MDUSD/MDEMO fixture assets on Robinhood Chain Testnet — not production stock trading

See [packages/sdk/README.md](../../packages/sdk/README.md) for the quickstart.
