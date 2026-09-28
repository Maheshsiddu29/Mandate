/**
 * The Lighter Venue Signer's adapter descriptor and `AdapterRef`
 * (Phase 7E.1; signer-architecture.md §10; enforcement-adapters.md §2).
 *
 * The `adapterDigest` content-addresses everything that decides what the
 * adapter does with an authorization: the chain, the transaction allowlist,
 * the fixed self-trade behaviour, the pre-execution requirements it
 * evaluates, its finality ladder and release level, the submission and
 * resubmission policy, and the exact official SDK its key custody wraps. An
 * `ExecutionAuthorization` and every `ADMIT_ATTEMPT` bind this exact ref, so a
 * changed adapter — a wider allowlist, another SDK build, a resubmission
 * policy — is a different adapter and can never reinterpret an existing
 * attempt (DOM-2 applied to adapters).
 */

import { ByteWriter } from '@mandate/kernel';
import { keccakDigest, validateAdapterRef, type AdapterRef, type AdapterRefInput } from '@mandate/core';

export const ADAPTER_ID = 'lighter-venue-signer';
export const ADAPTER_VERSION = 1;

/**
 * The transaction shapes the signer will ever sign. Everything else — withdraw,
 * transfer (any destination), public-pool mint/burn, stake, sub-account and
 * pool creation, API-key change, leverage, margin and account configuration,
 * modify, grouped and triggered orders — is refused before the key is used.
 * This is a **software** restriction: a Lighter API key itself is broad
 * (venue-evidence.md L-ACC-6), and a stolen key is not bound by it.
 */
export const ALLOWED_TX_TYPES = ['CREATE_ORDER', 'CANCEL_ORDER'] as const;
export type AllowedTxType = (typeof ALLOWED_TX_TYPES)[number];

/** Lighter transaction type codes the allowlist maps to (lighter-go `txtypes`). */
export const TX_TYPE_CODE: { readonly [K in AllowedTxType]: number } = { CREATE_ORDER: 14, CANCEL_ORDER: 15 };

/** Self-trade behaviour signed explicitly into every order: expire the taker. The venue's default has changed before (L-ORD-14). */
export const SELF_TRADE_BEHAVIOR_EXPIRE_TAKER = 1;

/** The official SDK the Go key custody links, pinned by tag, commit and module checksum (custody/go.sum). */
export const LIGHTER_SDK = {
  module: 'github.com/elliottech/lighter-go',
  version: 'v1.0.10',
  commit: '9d38261d1a4cc5c7211b383ba07a4d6e41604708',
  sum: 'h1:JEsJB9RNi6tIOlKpNEXIcjitDkcZPPKCEJvWro3BED8=',
} as const;

export const FINALITY_LADDER = ['ACKED', 'SEQUENCED', 'COMMITTED', 'VERIFIED'] as const;
/** Nothing is released below this level (reconciliation-evidence.md §2); releases are 7F's. */
export const RELEASE_LEVEL = 'VERIFIED';

export interface LighterAdapterConfig {
  readonly chainId: number;
}

export function adapterManifest(c: LighterAdapterConfig): Uint8Array {
  const w = new ByteWriter().str('mandate/perp-lighter/adapter-manifest').u16(1);
  w.str(ADAPTER_ID).u32(ADAPTER_VERSION).u32(c.chainId);
  w.u16(ALLOWED_TX_TYPES.length);
  for (const t of ALLOWED_TX_TYPES) w.str(t).u8(TX_TYPE_CODE[t]);
  w.u8(SELF_TRADE_BEHAVIOR_EXPIRE_TAKER);
  for (const k of ['CREDENTIAL_SCOPE', 'NONCE_SLOT']) w.str(k);
  for (const l of FINALITY_LADDER) w.str(l);
  w.str(RELEASE_LEVEL);
  // No non-execution rule is enabled until nonce semantics are evidenced (testnet-evidence.md): unknown → quarantine.
  w.str('non-execution:none');
  w.str('submission:signer-owned').str('resubmission:none').str('artifact:lighter.l2-tx-hash').str('slot:one-lane-per-key');
  w.str(LIGHTER_SDK.module).str(LIGHTER_SDK.version).str(LIGHTER_SDK.commit).str(LIGHTER_SDK.sum);
  return w.finish();
}

export function lighterAdapterRefInput(c: LighterAdapterConfig): AdapterRefInput {
  return { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, adapterDigest: keccakDigest(adapterManifest(c)) };
}

export function lighterAdapterRef(c: LighterAdapterConfig): AdapterRef {
  const r = validateAdapterRef(lighterAdapterRefInput(c));
  if (!r.ok) throw new Error(`adapter ref invalid: ${r.error.code}`);
  return r.value;
}
