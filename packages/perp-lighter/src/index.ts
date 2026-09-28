/**
 * @mandate/perp-lighter — PerpPolicy v1 for Lighter and the Lighter Venue
 * Signer (Phase 7E.1).
 *
 * - `vocabulary`, `market`, `identity`, `policy`, `adapter` are pure: the
 *   domain module, its codecs, reviewed market claims and the adapter
 *   descriptor. No network, clock or key.
 * - The signer (`signer.ts`), its key custody client (`custody.ts`) and venue
 *   client (`venue.ts`) are the only effectful parts: the custody client talks
 *   to the separate Go key-custody process, and the venue client refuses any
 *   host but Lighter's testnet in this phase.
 *
 * Core, the ledger and the control engine stay venue-independent: everything
 * Lighter-specific lives here.
 */

export * from './vocabulary.ts';
export * from './market.ts';
export * from './identity.ts';
export * from './adapter.ts';
export { ALLOWED_DIRECTION, ASSUMPTIONS, MAX_LEVERAGE, MAX_MARKED_EXPOSURE, ORDER_NOTIONAL_BOUND, PRICE_LADDER, STATE_LADDER, allowedDirectionParams, createPerpPolicy, maxLeverageParams, maxMarkedExposureParams, perpImplementation, perpManifest, perpModuleRef, type Direction, type PerpPolicy, type PerpPolicyConfig } from './policy.ts';
