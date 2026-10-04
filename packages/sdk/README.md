# `@mandate/sdk`

Thin developer SDK over the existing Mandate authorization boundary.

> **Mandate isn't only the demo application.**  
> Any agent can use the same authorization boundary through this package.

```text
Agents propose. Mandate authorizes. Markets settle.

A valid agent signature proves who proposed an action.
It does not prove the action is authorized.
```

## 1. What the SDK is

A **facade** above existing Mandate packages:

- natural-language mandate compilation (`@mandate/live-agents`)
- authority review / fail-closed signability (C2.1 issue policy + draft validation)
- V3 delegated authorization **preparation** (caller/wallet signs)
- deterministic proposal screening (`@mandate/portfolio` `screenProposal`)
- authority reservations (portfolio → control → ledger)
- execution preparation and reconciliation (injected `@mandate/live-settlement` adapters)

## 2. What it is not

- Not a second verifier, control engine, or ledger
- Not a wallet or key manager — the SDK never holds the principal private key
- Not a transaction broadcaster — prepare/reconcile do not send
- Not a marketplace, cross-chain router, or production brokerage API
- Not a silent binder of demo defaults (`$800`, NVDA, MDUSD/MDEMO, testnet principals)

## 3. Installation / workspace usage

This package is private to the Mandate monorepo:

```bash
npm install   # workspaces include packages/sdk
```

```ts
import { createMandateClient, liveLabDomainBindings } from '@mandate/sdk';
```

## 4. Five-minute example

```ts
import { createMandateClient, liveLabDomainBindings } from '@mandate/sdk';

const mandate = createMandateClient({
  principal: '0x…',           // your principal address
  chainId: 46630,             // example: Robinhood Chain testnet
  now: () => protocolNow,     // required for review / screen / reserve
  bindings: liveLabDomainBindings(), // opt-in; do not assume demo markets
  session,                    // LiveSession with V3 host, when preparing V3 auth
});

const draft = await mandate.compile({
  instruction: 'Let the Stock agent manage $800',
});

const review = mandate.review(draft);
if (!review.signable) {
  console.log(review.issues, review.blockers);
  return;
}

const prepared = await mandate.prepareDelegatedAuthorization(review);
if (!prepared.ok) {
  console.log(prepared.code, prepared.message);
  return;
}

// Application asks its wallet to sign `prepared.prepared.typedData` here.
// The SDK does not sign.

const authorization = await mandate.acceptAuthorization({
  prepared: prepared.prepared,
  signature, // from the wallet
  draft: review.draft,
});

// After portfolio authority is active in your process:
mandate.attachAuthority({ mandate, signature, core, bindings });

const decision = await mandate.screen({ proposal: agentProposal });
if (!decision.authorized) {
  console.log(decision.reasons);
  return;
}

const reservation = await mandate.reserve(decision);
if (!reservation.ok) {
  console.log(reservation.reasons);
  return;
}

const execution = await mandate.prepareExecution(reservation);
// Explicit integration-specific execution boundary.
// No SDK surprise broadcast.
```

See also `src/examples/agent-integration.ts`.

## 5. Authority lifecycle

```text
compile → review → prepareDelegatedAuthorization → (wallet signs)
  → acceptAuthorization → attachAuthority
  → screen → reserve → prepareExecution → reconcile
```

| Step | Authority effect |
| --- | --- |
| `compile` | None — draft only |
| `review` | None — fail-closed gate (`signable`) |
| `prepareDelegatedAuthorization` | None — typed data for the wallet |
| `acceptAuthorization` | Activates mandate version when signature verifies |
| `screen` | Deterministic authorization decision |
| `reserve` | Ledger reservation through control |
| `prepareExecution` | Exact execution material; **broadcasts = 0** |
| `reconcile` | Evidence-only; **never resends** |

## 6. Error / refusal handling

Screening returns a discriminated result:

```ts
if (decision.authorized) {
  // decision.kind === 'AUTHORIZED'
} else {
  // decision.kind === 'REFUSED'
  // decision.reasons — stable portfolio / registry / ledger reason codes
}
```

Do not reduce refusals to a bare boolean without reasons.

## 7. Signing boundary

- `prepareDelegatedAuthorization` prepares EIP-712 typed data (V3) for the **caller’s wallet**
- Fields include principal, chainId, verifyingContract / Gate, typedData, digest, expiry, generation, bounded capacity — only when present in the current V3 implementation
- `acceptAuthorization({ prepared, signature })` verifies the wallet signature through the existing LiveSession path
- The SDK never imports MetaMask/Phantom UI and never stores a principal key

## 8. Side-effect boundary

These methods must not broadcast:

`compile`, `review`, `screen`, `reserve`, `prepareDelegatedAuthorization`, `prepareExecution`

`prepareExecution` requires an injected `SettlementBackend` (e.g. `createV3SettlementBackend`), which uses dry-run / prepare-only settlement paths. There is **no** public `broadcast` / `send` method on the SDK client for C3.

## 9. Evidence classes

Settlement evidence labels come from `@mandate/live-settlement` (`SettlementEvidence` / `EvidenceClass`), including classes such as `LIVE_TESTNET`, `DRY_RUN`, `SUBMITTED_UNCONFIRMED`, `FAILED`, `REFERENCE_MODEL`, and `NOT_SUBMITTED`. The SDK re-exports the type; it does not invent new evidence semantics.

## 10. Current limitations

- Facade over the Live Lab / portfolio stack — not a standalone protocol reimplementation
- Chain / market bindings are **injected**; Quickstart examples may use Robinhood Chain testnet (46630) and Live Lab bindings explicitly
- Current live Stock settlement proof uses **valueless MDUSD/MDEMO fixture assets** on Robinhood Chain Testnet
- **Do not imply production stock trading**
- V3 preparation requires a `LiveSession` configured with a V3 challenge host (from `@mandate/live-settlement`)
- Session restore / ledger `RESTORE` accounting are different concepts; the SDK does not expose ledger capacity restore as “restore”
- No marketplace, cross-chain, or mainnet deployment surface
