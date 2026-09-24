/**
 * The bridge to the kernel.
 *
 * ```
 * RepresentationRecord  ->  Observed<RepresentationState>  ->  verify(...)
 * ```
 *
 * The registry's output is an *input* to the verifier, re-checked from scratch.
 * This module does not decide anything: it translates established registry claims
 * into the kernel's trusted-state shape, and refuses to translate anything that is
 * not established.
 *
 * That refusal is the point. Emitting `synthetic: NO` for a representation whose
 * backing could not be established would convert a registry gap into an execution,
 * which is the exact failure this layer exists to prevent. So the function returns
 * an error and emits nothing rather than substituting a permissive default —
 * there is no code path here that turns UNKNOWN into a favourable value.
 */

import {
  err,
  ok,
  parseObserved,
  parseRepresentationState,
  TriState,
  type Observed,
  type RepresentationState,
  type Result,
} from '@mandate/kernel';
import type { RegistryReasonCode } from './reason-codes.ts';
import { canonicalAssetKey } from './asset-id.ts';
import { resolveClaimSet, type ClaimSet, type UnknownReason } from './claims.ts';
import { identityKey, isSyntheticBacking } from './semantics.ts';
import type { RepresentationRecord } from './representation.ts';
import { claimPolicyOf, type RepresentationRequirements } from './requirements.ts';

function unknownCode(reason: UnknownReason): RegistryReasonCode {
  switch (reason) {
    case 'NO_CLAIMS':
      return 'REPRESENTATION_METADATA_UNKNOWN';
    case 'BELOW_TRUST_FLOOR':
      return 'TRUST_REQUIREMENT_NOT_MET';
    case 'STALE':
      return 'REPRESENTATION_METADATA_STALE';
  }
}

function establishOrFail<T>(
  claims: ClaimSet<T>,
  requirements: RepresentationRequirements,
  keyOf: (v: T) => string,
): Result<{ value: T; provenance: Observed<unknown>['provenance'] }, RegistryReasonCode> {
  const r = resolveClaimSet(claims, claimPolicyOf(requirements), keyOf);
  if (r.state === 'ESTABLISHED') return ok({ value: r.value, provenance: r.provenance });
  if (r.state === 'CONFLICT') return err('REPRESENTATION_METADATA_CONFLICT');
  return err(unknownCode(r.reason));
}

/**
 * Translate a registry record into kernel trusted state.
 *
 * Succeeds only when the underlying, the issuer, the backing model and the
 * operational status are all established at or above the requirements' trust
 * floor. The provenance attached is the oldest qualifying observation across those
 * properties, so the kernel's freshness check is applied to the weakest evidence
 * rather than the most flattering.
 */
export function toRepresentationState(
  record: RepresentationRecord,
  requirements: RepresentationRequirements,
): Result<Observed<RepresentationState>, RegistryReasonCode> {
  const underlying = establishOrFail(record.underlying, requirements, canonicalAssetKey);
  if (!underlying.ok) return underlying;
  const issuer = establishOrFail(record.issuer, requirements, identityKey);
  if (!issuer.ok) return issuer;
  const backing = establishOrFail(record.backing, requirements, identityKey);
  if (!backing.ok) return backing;
  const operational = establishOrFail(record.operationalStatus, requirements, identityKey);
  if (!operational.ok) return operational;

  // The instrument type is optional in the kernel's shape, so an unestablished one
  // becomes null rather than failing: the kernel constrains synthetic status and
  // operational state, not instrument type. Where a caller's requirements *do*
  // constrain it, `evaluateRepresentation` has already refused.
  const instrument = resolveClaimSet(record.instrumentType, claimPolicyOf(requirements), identityKey);
  const instrumentType = instrument.state === 'ESTABLISHED' ? instrument.value : null;

  // Weakest evidence wins: the kernel then applies its freshness bound to the
  // oldest observation any of these properties rests on.
  const observedAtUnixSeconds = [
    underlying.value.provenance.observedAtUnixSeconds,
    issuer.value.provenance.observedAtUnixSeconds,
    backing.value.provenance.observedAtUnixSeconds,
    operational.value.provenance.observedAtUnixSeconds,
  ].reduce((oldest, t) => (t < oldest ? t : oldest));

  // Likewise the weakest trust class of the four, so the kernel never sees a
  // representation described as better-sourced than its worst input.
  const trustRank: Record<string, number> = { UNTRUSTED: 0, ADVISORY: 1, VERIFIED: 2, AUTHORITATIVE: 3 };
  const weakestTrust = [
    underlying.value.provenance.trustClass,
    issuer.value.provenance.trustClass,
    backing.value.provenance.trustClass,
    operational.value.provenance.trustClass,
  ].reduce((worst, t) => ((trustRank[t] ?? 0) < (trustRank[worst] ?? 0) ? t : worst));

  const state = parseRepresentationState({
    representationId: record.representationId.value,
    canonicalAsset: {
      assetClass: underlying.value.value.assetClass,
      idScheme: underlying.value.value.idScheme,
      value: underlying.value.value.value,
    },
    issuer: issuer.value.value,
    chain: record.representationId.chain,
    instrumentType,
    // Derived, never carried as its own claim, so the two cannot disagree.
    synthetic: isSyntheticBacking(backing.value.value) ? TriState.YES : TriState.NO,
    operationalState: operational.value.value,
  });
  if (!state.ok) return err(state.error);

  // Routed through the kernel's own `parseObserved`, which refuses advisory and
  // untrusted provenance. Belt and braces: the trust floor already excluded those,
  // and this makes it impossible for a change here to bypass the kernel's rule.
  const observed = parseObserved(
    {
      value: {
        representationId: state.value.representationId,
        canonicalAsset: state.value.canonicalAsset,
        issuer: state.value.issuer,
        chain: state.value.chain,
        instrumentType: state.value.instrumentType,
        synthetic: state.value.synthetic,
        operationalState: state.value.operationalState,
      },
      provenance: {
        trustClass: weakestTrust,
        sourceId: 'registry',
        observedAtUnixSeconds,
      },
    },
    parseRepresentationState,
  );
  if (!observed.ok) return err(observed.error);
  return ok(observed.value);
}
