/**
 * Canonical SDK example shown on /docs/sdk.
 *
 * Method names must match `@mandate/sdk` exports and MandateClient methods.
 * Keep this string in sync with packages/sdk/README.md and packages/sdk/src/client.ts.
 */

export const SDK_PUBLIC_EXPORTS = [
  "createMandateClient",
  "liveLabDomainBindings",
  "reviewMandateDraft",
  "createV3SettlementBackend",
] as const;

export const SDK_CLIENT_METHODS = [
  "compile",
  "review",
  "prepareDelegatedAuthorization",
  "acceptAuthorization",
  "attachAuthority",
  "screen",
  "reserve",
  "prepareExecution",
  "reconcile",
] as const;

export const SDK_QUICKSTART = `import { createMandateClient, liveLabDomainBindings } from "@mandate/sdk";

const mandate = createMandateClient({
  principal: "0x…",           // your principal address
  chainId: 46630,             // Robinhood Chain testnet example
  now: () => protocolNow,     // required for review / screen / reserve
  bindings: liveLabDomainBindings(), // opt-in; do not assume demo markets
  session,                    // LiveSession with V3 host, when preparing V3 auth
});

const draft = await mandate.compile({
  instruction: "Let the Stock agent manage $800",
});

const review = mandate.review(draft);
if (!review.signable) {
  return review.issues;
}

const prepared = await mandate.prepareDelegatedAuthorization(review);
if (!prepared.ok) {
  return prepared;
}

// Application asks its wallet to sign prepared.prepared.typedData.
// The SDK does not sign and does not hold the principal key.

const authorization = await mandate.acceptAuthorization({
  prepared: prepared.prepared,
  signature, // from the wallet
  draft: review.draft,
});

// After portfolio authority is active in your process:
mandate.attachAuthority({ mandate, signature, core, bindings });

const decision = await mandate.screen({ proposal: agentProposal });
if (!decision.authorized) {
  return decision.reasons;
}

const reservation = await mandate.reserve(decision);
if (!reservation.ok) {
  return reservation.reasons;
}

const execution = await mandate.prepareExecution(reservation);
// Explicit integration-specific execution boundary.
// prepareExecution / reconcile do not broadcast.`;
