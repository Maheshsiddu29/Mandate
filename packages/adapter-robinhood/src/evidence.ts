import { TrustClass, type Identifier, type Provenance, type UnixSeconds } from '@mandate/kernel';

/** How a field entered normalized state. This is separate from trust class so a
 * curated value can never be displayed as issuer-authoritative. */
export const EvidenceClass = {
  DIRECT_AUTHORITATIVE_OBSERVATION: 'DIRECT_AUTHORITATIVE_OBSERVATION',
  VERIFIED_DETERMINISTIC_DERIVATION: 'VERIFIED_DETERMINISTIC_DERIVATION',
  CURATED_MAPPING: 'CURATED_MAPPING',
  ADVISORY_INFERENCE: 'ADVISORY_INFERENCE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type EvidenceClass = (typeof EvidenceClass)[keyof typeof EvidenceClass];

export const ObservationClock = {
  SOURCE_TIMESTAMP: 'SOURCE_TIMESTAMP',
  HTTP_RETRIEVAL_TIME: 'HTTP_RETRIEVAL_TIME',
  BLOCK_TIMESTAMP: 'BLOCK_TIMESTAMP',
  CURATION_TIME: 'CURATION_TIME',
} as const;
export type ObservationClock = (typeof ObservationClock)[keyof typeof ObservationClock];

export interface Evidence<T> {
  readonly value: T;
  readonly evidenceClass: EvidenceClass;
  readonly observationClock: ObservationClock;
  readonly provenance: Provenance;
  readonly derivedFrom?: readonly string[];
}

export function authoritativeHttpEvidence<T>(
  value: T,
  sourceId: Identifier,
  observedAtUnixSeconds: UnixSeconds,
  observationClock: ObservationClock,
): Evidence<T> {
  return {
    value,
    evidenceClass: EvidenceClass.DIRECT_AUTHORITATIVE_OBSERVATION,
    observationClock,
    provenance: { trustClass: TrustClass.AUTHORITATIVE, sourceId, observedAtUnixSeconds },
  };
}

export function verifiedDerivation<T>(
  value: T,
  sourceId: Identifier,
  observedAtUnixSeconds: UnixSeconds,
  observationClock: ObservationClock,
  derivedFrom: readonly string[],
): Evidence<T> {
  return {
    value,
    evidenceClass: EvidenceClass.VERIFIED_DETERMINISTIC_DERIVATION,
    observationClock,
    provenance: { trustClass: TrustClass.VERIFIED, sourceId, observedAtUnixSeconds },
    derivedFrom,
  };
}
